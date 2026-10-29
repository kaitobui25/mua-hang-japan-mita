import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assets=path.resolve(root,'..');
const runtime=path.join(root,'.agents','runtime');
const STOP_FILE=path.join(runtime,'llama-gateway.stop');
const executable=path.join(assets,'tools','llama.cpp-vulkan','llama-server.exe');
const model=path.join(assets,'models','Index-Translate-2B.Q4_K_M.gguf');
const HOST='127.0.0.1', API_PORT=8080, MODEL_PORT=8081;
export const IDLE_MS=15*60*1000;
const READINESS_TIMEOUT_MS=120000;
const log=(event,fields={})=>console.log(JSON.stringify({at:new Date().toISOString(),event,...fields}));

export function createModelLifecycle({start,stop,probe,clock=()=>Date.now(),idleMs=IDLE_MS}) {
  let child=null,starting=null,stopping=null,active=0,lastActivity=clock();
  async function ensure() {
    if(stopping)await stopping;
    if(child && await probe(child)) return child;
    if(starting) return starting;
    starting=(async()=>{
      if(child) { await stop(child);child=null; }
      const owned=await start();
      child=owned;
      return owned;
    })();
    try{return await starting;}
    finally{starting=null;}
  }
  return {
    async enter(){ active++;lastActivity=clock();
      try {await ensure();}catch(e){active--;lastActivity=clock();throw e;}
    },
    leave(){active=Math.max(0,active-1);lastActivity=clock();},
    async tick(){
      // Active demand and an in-progress boot always prevent idle shutdown.
      if(!child || active || starting || stopping || clock()-lastActivity<idleMs)return false;
      const owned=child;child=null;
      stopping=stop(owned);
      try{await stopping;return true;}
      finally{stopping=null;}
    },
    async close(){if(stopping)await stopping;const owned=child;child=null;if(owned)await stop(owned);},
    snapshot(){return {active,running:!!child,starting:!!starting,stopping:!!stopping,idleMs:clock()-lastActivity};}
  };
}

function connectable(port) {
  return new Promise(resolve=>{
    const socket=net.connect({host:HOST,port});
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',()=>resolve(false));
    socket.setTimeout(800,()=>{socket.destroy();resolve(false);});
  });
}
async function ready() {
  try{
    const response=await fetch(`http://${HOST}:${MODEL_PORT}/health`,{signal:AbortSignal.timeout(1000)});
    return response.ok;
  }catch{return false;}
}
let ownedChild=null;
async function startModel() {
  if(!existsSync(executable)||!existsSync(model))throw Error('Local GGUF or llama-server binary missing');
  if(await connectable(MODEL_PORT))throw Error('Model port 8081 already occupied; no foreign process will be used');
  mkdirSync(runtime,{recursive:true});
  const output=createWriteStream(path.join(runtime,'llama.out.log'),{flags:'a'});
  const errors=createWriteStream(path.join(runtime,'llama.err.log'),{flags:'a'});
  const child=spawn(executable,['-m',model,'-a','Index-Translate-2B','--host',HOST,'--port',String(MODEL_PORT),
    '-c','4096','-t','12','-ngl','99','--temp','0','--reasoning-budget','0','--jinja','-np','1'],
    {cwd:path.dirname(executable),windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,LLAMA_ARG_CHAT_TEMPLATE_KWARGS:'{"enable_thinking":false}'}});
  child.stdout.pipe(output);child.stderr.pipe(errors);
  let spawnError=null;
  child.once('error',error=>{spawnError=error;log('model_spawn_error',{reason:error.code??'unknown'});});
  ownedChild=child;
  child.once('exit',(code)=>{if(ownedChild===child)ownedChild=null;log('model_exited',{pid:child.pid,code});});
  const expires=Date.now()+READINESS_TIMEOUT_MS;
  while(Date.now()<expires){
    if(spawnError)throw Error('Model failed to spawn');
    if(child.exitCode!==null||child.signalCode)throw Error('Model exited before readiness');
    if(await ready()) {log('model_ready',{pid:child.pid});return child;}
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  await stopModel(child);
  throw Error('Model readiness timeout');
}
async function stopModel(child){
  if(ownedChild!==child||child.exitCode!==null)return;
  child.kill('SIGTERM'); // Exact child handle created by this process; no name-wide kill.
  await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)),
    new Promise(resolve=>setTimeout(resolve,5000))
  ]);
  log('model_idle_stop',{pid:child.pid});
}

export async function serve(){
  const lifecycle=createModelLifecycle({
    start:startModel,stop:stopModel,
    // Readiness is checked during startup. A running server can report busy
    // during inference; that must never cause another request to kill it.
    probe:async child=>child.exitCode===null && child.signalCode===null && ownedChild===child
  });
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/health' && req.method==='GET'){
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(lifecycle.snapshot()));return;
    }
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){
      res.writeHead(404);res.end();return;
    }
    let entered=false,released=false;
    const release=()=>{if(entered&&!released){released=true;lifecycle.leave();}};
    try{
      const parts=[];let bytes=0;
      for await(const part of req){
        bytes+=part.length;
        if(bytes>512*1024)throw Error('Request too large');
        parts.push(part);
      }
      await lifecycle.enter();entered=true;
      // Port 8081 is private to this process. Never proxy arbitrary destinations.
      const upstream=http.request({hostname:HOST,port:MODEL_PORT,path:'/v1/chat/completions',
        method:'POST',headers:{'content-type':'application/json','content-length':bytes}},reply=>{
        res.writeHead(reply.statusCode??502,{'content-type':reply.headers['content-type']??'application/json'});
        reply.pipe(res);
        reply.once('end',release);
        reply.once('error',release);
      });
      upstream.setTimeout(210000,()=>upstream.destroy(Error('Inference timeout')));
      upstream.once('error',error=>{
        if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});
        if(!res.writableEnded)res.end(JSON.stringify({error:{message:'local_inference_unavailable'}}));
        release();log('inference_error',{reason:error.code??'upstream_failed'});
      });
      res.once('close',()=>{if(!res.writableEnded)upstream.destroy();release();});
      upstream.end(Buffer.concat(parts));
    }catch(error){
      if(!res.headersSent)res.writeHead(error.message==='Request too large'?413:503,{'content-type':'application/json'});
      if(!res.writableEnded)res.end(JSON.stringify({error:{message:'local_inference_unavailable'}}));
      release();log('model_unavailable',{reason:error.message});
    }
  });
  server.on('error',error=>{log('gateway_error',{reason:error.code??'listen_failed'});process.exitCode=1;});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(API_PORT,HOST,resolve);});
  log('gateway_ready',{port:API_PORT,modelPort:MODEL_PORT,idleMinutes:15});
  const timer=setInterval(()=>{
    if(existsSync(STOP_FILE)&&lifecycle.snapshot().active===0){
      unlinkSync(STOP_FILE);void halt();return;
    }
    lifecycle.tick().then(stopped=>{if(stopped)log('idle_shutdown');})
      .catch(error=>log('idle_shutdown_error',{reason:error.message}));
  },10000);
  const halt=async()=>{clearInterval(timer);server.close();await lifecycle.close();process.exit(0);};
  process.once('SIGINT',()=>void halt());
  process.once('SIGTERM',()=>void halt());
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  serve().catch(error=>{console.error(error.message);process.exitCode=1;});
}
