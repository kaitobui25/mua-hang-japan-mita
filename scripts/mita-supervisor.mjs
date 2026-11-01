import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, appendFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const backend=path.join(root,'backend'), runtime=path.join(root,'.agents','runtime');
const requireBackend=createRequire(path.join(backend,'package.json'));
const {Client}=requireBackend('pg');
const node=process.execPath;
const logger=path.join(runtime,'mita-supervisor.jsonl');
const STATUS_PORT=19978;
const STOP_FILE=path.join(runtime,'mita-supervisor.stop');
const TUNNEL_LEASE=path.join(runtime,'tunnel-15432.lease');
function reserveTunnel(runId){
  // Atomic cross-process exclusion with diagnostic PowerShell. A stale lease
  // after a crash fails closed and requires identity-checked manual recovery.
  const fd=openSync(TUNNEL_LEASE,'wx',0o600);
  try{writeFileSync(fd,`sync:${runId}`);}catch(error){closeSync(fd);throw error;}
  let released=false;
  return ()=>{
    if(released)return;
    released=true;
    closeSync(fd);
    try{if(readFileSync(TUNNEL_LEASE,'utf8')===`sync:${runId}`)unlinkSync(TUNNEL_LEASE);}
    catch{record('tunnel_reservation_cleanup_uncertain',{runId});}
  };
}
const LOCKS={amazon:70400200,names:70400300,detail:70400301};
const execFileAsync=promisify(execFile);
const terminalStates=['completed','skipped','partial','failed'];
export function assertManualSyncReady(snapshot,today) {
  if(snapshot?.day!==today || snapshot.sync?.state!=='pending')throw Error('Sync is not pending; replay/retry is unsupported. Inspect the daily state and remote ledger.');
  if(!['amazon','names','detail'].every(name=>snapshot.jobs?.[name]?.day===today && terminalStates.includes(snapshot.jobs[name].state)))
    throw Error('All three terminal worker states must belong to the current JST date.');
  if(Object.values(snapshot.jobs).every(job=>job.state==='skipped'))throw Error('All workers were skipped.');
}
export function assertOwnerSession(session,csrf,now=Date.now()) {
  if(session?.role!=='owner' || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt)<=now ||
     !/^[a-f0-9]{64}$/.test(csrf??'') || session.csrfToken!==csrf)throw Error('Fresh Owner session and matching CSRF token required.');
}
async function authorizeSync(cookie,csrf) {
  if(!/^mita_admin=[a-f0-9]{64}$/.test(cookie??''))throw Error('Owner session cookie required.');
  const session=await new Promise((resolve,reject)=>{
    const req=request('http://127.0.0.1:4000/api/admin/session',{headers:{Cookie:cookie,Origin:'http://127.0.0.1:4000'}},res=>{
      let body='';
      res.on('data',chunk=>{body+=chunk;if(body.length>8192)res.destroy(Error('Session response too large'));});
      res.on('error',reject);
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Session rejected');resolve(JSON.parse(body));}catch{reject(Error('Owner authorization unavailable or rejected.'));}});
    });
    req.setTimeout(3000,()=>req.destroy(Error('Owner authorization timed out.')));
    req.on('error',()=>reject(Error('Owner authorization unavailable.')));req.end();
  });
  assertOwnerSession(session,csrf);
}
export function assertSyncInventory(inventory,workerPids) {
  if(!inventory || !Array.isArray(inventory.processes) || !Array.isArray(inventory.tunnels))throw Error('Process/tunnel inventory unavailable.');
  if(inventory.tunnels.length)throw Error('Port 15432 occupied; no tunnel adoption.');
  for(const process of inventory.processes){
    const command=process.CommandLine??'';
    if(!command)throw Error('Cannot inspect a possible worker/sync/tunnel process.');
    if(/(?:nightly-vps-sync\.ps1|sync-catalog-vps\.mjs|sync-mita-reviews\.ps1|start-vps-worker\.ps1)/i.test(command) ||
       (/ssh(?:\.exe)?$/i.test(process.Name) && /15432/.test(command)))throw Error('Existing sync or tunnel process detected.');
    if(/src[\\/](?:worker|translator|detail-translator)\.ts(?:["\s]|$)/i.test(command) && !workerPids.includes(Number(process.ProcessId)))
      throw Error('Unmanaged or duplicate worker detected.');
  }
}
async function syncInventory(workerPids) {
  const command="$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|powershell|pwsh|ssh)\\.exe$' } | Select-Object Name,ProcessId,CommandLine); $t=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 15432 | Select-Object OwningProcess); @{processes=$p;tunnels=$t} | ConvertTo-Json -Depth 4 -Compress";
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:1024*1024});
  assertSyncInventory(JSON.parse(stdout.replace(/^\uFEFF/,'')),workerPids);
}
export const windows={amazon:4*60,names:5*60,detail:5*60+15};
export const REVIEW_SYNC_INTERVAL_MS=5*60*1000;
export function canRunReviewSync(time=new Date()) {
  const minute=jstClock(time).minute;
  // Reserve time for Amazon collection, translation, and the nightly catalog transfer.
  return minute<3*60+45 || minute>=5*60+45;
}
const specs={
  amazon:{entry:'worker.ts',code:['worker.ts','ingestion','admin/imports.ts','db/pool.ts','config.ts']},
  names:{entry:'translator.ts',code:['translator.ts','translation','db/pool.ts','config.ts']},
  detail:{entry:'detail-translator.ts',code:['detail-translator.ts','translation','db/pool.ts','config.ts']}
};
const defaultKeys=process.argv.includes('--detail-only')?['detail']:['amazon','names','detail'];
if(process.argv.some((arg,index)=>index>1&&!['--detail-only'].includes(arg)))throw Error('Usage: node scripts/mita-supervisor.mjs [--detail-only]');

export function jstClock(time=new Date()) {
  const date=new Date(time.getTime()+9*3600000);
  return {day:date.toISOString().slice(0,10),minute:date.getUTCHours()*60+date.getUTCMinutes(),
    second:date.getUTCSeconds()};
}
export function canRestart(key,time=new Date(),locked=false) {
  if(locked)return false;
  const {minute}=jstClock(time);
  return minute < windows[key]-10 || minute >= windows[key]+7;
}
function fingerprint(key){
  const hash=createHash('sha256');
  const files=specs[key].code.flatMap(spec=>{
    const paths=[]; const base=path.join(backend,'src',spec);
    if(!existsSync(base))return paths;
    if(statSync(base).isDirectory()){
      const collect=relative=>{
        const full=path.join(base,relative);
        if(statSync(full).isDirectory())for(const entry of readdirSync(full))collect(path.join(relative,entry));
        else if(/\.(ts|js|json|mjs)$/.test(full))paths.push(full);
      };
      collect('.');
    }else paths.push(base);
    return paths;
  });
  for(const file of [...files,path.join(backend,'package.json')].sort()){
    hash.update(path.relative(root,file));hash.update(readFileSync(file));
  }
  if(key==='amazon'){
    const python=path.join(backend,'python');
    for(const filename of readdirSync(python).filter(name=>name.endsWith('.py')).sort()){
      hash.update(filename);hash.update(readFileSync(path.join(python,filename)));
    }
  }
  return hash.digest('hex');
}
function record(event,data={}){
  appendFileSync(logger,JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');
}
function atomicJson(file,value){
  const tmp=file+'.tmp';
  writeFileSync(tmp,JSON.stringify(value,null,2));
  renameSync(tmp,file);
}
async function activeLocks(){
  const client=new Client({connectionString:process.env.MITA_LOCAL_DATABASE_URL||
    'postgresql://mita_local@127.0.0.1:5433/postgres',connectionTimeoutMillis:2500});
  try{
    await client.connect();
    const rows=(await client.query(`SELECT objid::bigint AS key, count(*)::int AS count
      FROM pg_locks WHERE locktype='advisory' AND granted AND classid=0
        AND objid=ANY($1::oid[]) GROUP BY objid`,[Object.values(LOCKS)])).rows;
    const known=new Set(rows.map(row=>Number(row.key)));
    const latest=(await client.query(`SELECT id,started_at,finished_at,state
      FROM sync_runs WHERE started_at >= (now() AT TIME ZONE 'Asia/Tokyo')::date AT TIME ZONE 'Asia/Tokyo'
      ORDER BY id DESC LIMIT 2`)).rows;
    return {busy:Object.fromEntries(Object.entries(LOCKS).map(([key,value])=>[key,known.has(value)])),latest};
  } finally {await client.end().catch(()=>{});}
}
async function withWorkerLease(name,action){
  const client=new Client({connectionString:process.env.MITA_LOCAL_DATABASE_URL||
    'postgresql://mita_local@127.0.0.1:5433/postgres',connectionTimeoutMillis:2500});
  let acquired=false;
  try {
    await client.connect();
    acquired=(await client.query('SELECT pg_try_advisory_lock($1) AS ok',[LOCKS[name]])).rows[0].ok;
    if(!acquired)return false;
    return await action();
  } finally {
    if(acquired)await client.query('SELECT pg_advisory_unlock($1)',[LOCKS[name]]).catch(()=>{});
    await client.end().catch(()=>{});
  }
}
export async function acquireSyncLease(client=new Client({connectionString:process.env.MITA_LOCAL_DATABASE_URL||
    'postgresql://mita_local@127.0.0.1:5433/postgres',connectionTimeoutMillis:2500})){
  const acquired=[];
  let lost=false;
  client.on('error',()=>{lost=true;});
  const release=async()=>{
    for(const key of acquired)await client.query('SELECT pg_advisory_unlock($1)',[key]).catch(()=>{});
    await client.end().catch(()=>{});
  };
  try{
    await client.connect();
    for(const key of Object.values(LOCKS)){
      if(!(await client.query('SELECT pg_try_advisory_lock($1) AS ok',[key])).rows[0].ok)throw Error('Worker lock is busy; sync rejected.');
      acquired.push(key);
    }
    return {client,release,get lost(){return lost;}};
  }catch(error){await release();throw error;}
}
const tails=new Map();
function appendOutput(name,chunk,handler){
  // Preserve worker console logs separately. The supervisor log contains states only.
  const file=path.join(runtime,name+'.out.log');
  appendFileSync(file,chunk);
  const fragments=((tails.get(name)??'')+chunk.toString('utf8')).split(/\r?\n/);
  tails.set(name,fragments.pop().slice(-8192));
  for(const line of fragments)if(line.trim())handler(name,line);
}
export async function runSupervisor({keys=defaultKeys,refreshMs=20000}={}){
  mkdirSync(runtime,{recursive:true});
  let exiting=false,ticking=false,status=null,day=null,plannedSync=false,syncInFlight=false;
  let reviewSyncInFlight=false,lastReviewSyncAttempt=0;
  let syncDispatching=false,syncOwner=null;
  const supervisorRunId=randomUUID();
  const children=new Map(),pending=new Map();
  const statePath=()=>path.join(runtime,`mita-daily-${day}.json`);
  function setState(name,state,details={}){
    const previous=status.jobs[name];
    if(previous?.state===state)return;
    status.jobs[name]={day,state,updatedAt:new Date().toISOString(),...details};
    atomicJson(statePath(),status);
    record('job_state',{day,name,state});
  }
  function updateDay(){
    const today=jstClock().day;
    if(today===day)return;
    if(status?.sync?.state==='pending'){
      status.sync={state:'deferred',at:new Date().toISOString(),reason:'previous_day_jobs_incomplete'};
      atomicJson(statePath(),status);
      record('sync_deferred',{day});
    }
    day=today;
    const dest=statePath();
    status=existsSync(dest)?JSON.parse(readFileSync(dest,'utf8')):{day,jobs:{},sync:{state:'pending'}};
    plannedSync=status.sync?.state!=='pending';
    record('day_started',{day});
  }
  function line(name,message){
    if(!status)return;
    const at=jstClock(), due=windows[name], near=at.minute>=due&&at.minute<=due+360;
    if(!near)return;
    if(name==='names' && message.includes('05:00 JST name translation started'))setState(name,'running');
    if(name==='detail' && message.includes('05:15 JST local DETAIL translation:'))setState(name,'completed');
    if(name==='names' && message.includes('Name translation finished:'))setState(name,'completed');
    if(message.includes('paused: true') && status.jobs[name]?.state==='completed')setState(name,'partial');
    if(message.includes('Skipped missed') && !status.jobs[name]?.state)setState(name,'skipped');
  }
  function launch(name){
    const entry=path.join(backend,'src',specs[name].entry);
    const child=spawn(node,['--import','tsx',entry,'daily'],{
      cwd:backend,windowsHide:true,stdio:['ignore','pipe','pipe'],
      // First permitted scan: five source-approved gallery QA ASINs only.
      // Leave the pilot armed until DuckDNS QA; an explicit "verified" setting
      // is required to resume normal scheduled discovery on later days.
      env:{...process.env,LLAMA_BASE_URL:'http://127.0.0.1:8080/v1',LLAMA_MODEL:'Index-Translate-2B',
        ...(name==='amazon' ? {AMAZON_GALLERY_PILOT_DATE:process.env.AMAZON_GALLERY_PILOT_DATE ?? '2026-10-30'} : {})}
    });
    const startedAt=new Date();
    const entryInfo={child,startedAt,fingerprint:fingerprint(name),healthy:true};
    children.set(name,entryInfo);
    child.stdout.on('data',chunk=>appendOutput(name,chunk,line));
    child.stderr.on('data',chunk=>appendFileSync(path.join(runtime,name+'.err.log'),chunk));
    child.once('error',error=>record('worker_error',{name,reason:error.code??'spawn_failed'}));
    child.once('exit',(code)=>{
      if(children.get(name)===entryInfo)children.delete(name);
      record('worker_exit',{name,code});
      if(status?.jobs[name]?.state==='running')setState(name,'failed');
    });
    record('worker_started',{name,pid:child.pid,code:entryInfo.fingerprint.slice(0,16)});
  }
  async function idleStop(name,info){
    // Hold the same job advisory lock during the Windows process termination.
    // A just-enqueued import cannot begin between an idle check and the stop.
    return withWorkerLease(name,async()=>{
      if(info.child.exitCode===null && info.child.signalCode===null){
        info.child.kill('SIGTERM');
        await new Promise(resolve=>{
          if(info.child.exitCode!==null || info.child.signalCode!==null)return resolve();
          const done=()=>{clearTimeout(timeout);resolve();};
          const timeout=setTimeout(done,3000);
          info.child.once('exit',done);
        });
      }
      if(info.child.exitCode===null && info.child.signalCode===null)return false;
      if(children.get(name)===info)children.delete(name);
      return true;
    });
  }
  async function triggerSync(manual=null){
    if(syncDispatching || syncInFlight || reviewSyncInFlight || exiting || existsSync(STOP_FILE)){
      if(manual)throw Error('Coordinator busy or draining.');
      return;
    }
    if(manual)assertManualSyncReady(status,jstClock().day);
    if(plannedSync || !keys.every(name=>status.jobs[name] && ['completed','skipped','partial','failed'].includes(status.jobs[name].state)))return;
    // Never sync while a job has outstanding work or if all work was missed.
    if(keys.length!==3 || Object.values(status.jobs).every(job=>job.state==='skipped')) {
      plannedSync=true;status.sync={state:'skipped',at:new Date().toISOString()};
      atomicJson(statePath(),status);return;
    }
    syncDispatching=true;
    let lease,releaseTunnel;
    try{
      if(keys.length!==3)throw Error('All three supervisor workers are required.');
      // The same leases used by workers close the check/dispatch race. Hold
      // all three until the sync child exits; never stop a worker to get them.
      lease=await acquireSyncLease();
      await syncInventory([...children.values()].map(info=>info.child.pid));
      assertManualSyncReady(status,jstClock().day);
      if(manual)await authorizeSync(manual.cookie,manual.csrf); // after all slow checks
      assertManualSyncReady(status,jstClock().day); // reject a JST rollover during authorization
      if(lease.lost)throw Error('Worker lease connection lost; manual inspection required.');
      if(reviewSyncInFlight || exiting || existsSync(STOP_FILE))throw Error('Coordinator busy or draining.');
      releaseTunnel=reserveTunnel(randomUUID());
    }catch(error){if(releaseTunnel)releaseTunnel();if(lease)await lease.release();syncDispatching=false;throw error;}
    const runId=randomUUID();
    plannedSync=true;status.sync={state:'running',at:new Date().toISOString(),runId,sessionId:manual?.sessionId??null};
    const runningDay=day,runningPath=statePath();
    const env={...process.env,MITA_SYNC_JOBS:JSON.stringify(status.jobs)};
    const script=path.join(root,'scripts','nightly-vps-sync.ps1');
    let child;
    try{
      atomicJson(runningPath,status);
      child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{
        windowsHide:true,cwd:root,env,stdio:['ignore','pipe','pipe']
      });
    }catch(error){syncDispatching=false;releaseTunnel();await lease.release();throw error;} // claim stays blocked; never retry
    syncInFlight=true;
    syncOwner={runId,pid:child.pid??null,script,supervisorPid:process.pid,supervisorRunId,sessionId:manual?.sessionId??null,startedAt:new Date().toISOString()};
    // Loss of a lease cannot be repaired by retrying. Keep this run claimed,
    // record the uncertainty, and never terminate an in-flight transfer.
    lease.client.on('error',()=>record('sync_lease_lost',{runId}));
    child.stdout.on('data',chunk=>appendFileSync(path.join(runtime,'nightly-sync.out.log'),chunk));
    child.stderr.on('data',chunk=>appendFileSync(path.join(runtime,'nightly-sync.err.log'),chunk));
    let finalized=false;
    const complete=code=>{
      if(finalized)return;
      finalized=true;
      try{
        const saved=JSON.parse(readFileSync(runningPath,'utf8'));
        saved.sync={state:lease.lost?'unknown':code===0?'completed':code===2?'partial':'failed',at:new Date().toISOString(),runId,sessionId:manual?.sessionId??null};
        atomicJson(runningPath,saved);
        if(day===runningDay)status.sync=saved.sync;
        record('sync_finished',{day:runningDay,exitCode:code});
      }catch{record('sync_state_unknown',{day:runningDay,runId});}
      finally{syncInFlight=false;syncDispatching=false;releaseTunnel();void lease.release();}
    };
    child.once('exit',complete);
    child.once('error',()=>complete(-1));
    record('sync_started',{day});
    return syncOwner;
  }
  function triggerReviewSync(observed){
    if(process.env.MITA_REVIEW_SYNC_ENABLED!=='1' || reviewSyncInFlight || syncInFlight || syncDispatching ||
       Object.values(observed.busy).some(Boolean) || !canRunReviewSync() ||
       Date.now()-lastReviewSyncAttempt<REVIEW_SYNC_INTERVAL_MS)return;
    lastReviewSyncAttempt=Date.now();
    reviewSyncInFlight=true;
    const script=path.join(root,'scripts','sync-mita-reviews.ps1');
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{
      windowsHide:true,cwd:root,env:process.env,stdio:['ignore','pipe','pipe']
    });
    child.stdout.on('data',chunk=>appendFileSync(path.join(runtime,'review-sync.out.log'),chunk));
    child.stderr.on('data',chunk=>appendFileSync(path.join(runtime,'review-sync.err.log'),chunk));
    let completed=false;
    const timeout=setTimeout(()=>{
      record('review_sync_timeout');
      child.kill();
    },180000);
    const complete=code=>{
      if(completed)return;
      completed=true;
      clearTimeout(timeout);
      reviewSyncInFlight=false;
      record('review_sync_finished',{exitCode:code??-1});
    };
    child.once('exit',complete);
    child.once('error',()=>complete(-1));
    record('review_sync_started');
  }
  async function tick(){
    if(ticking||exiting)return;
    ticking=true;
    try {
      updateDay();
      let observed;
      try{observed=await activeLocks();}
      catch(error){record('database_unavailable',{reason:error.code??'connection_failed'});return;}
      if(existsSync(STOP_FILE)){
        if(syncInFlight || syncDispatching || reviewSyncInFlight || Object.values(observed.busy).some(Boolean) ||
           keys.some(name=>!canRestart(name,new Date(),false))){
          return; // Owner requested stop; allow in-flight work and dispatch to drain.
        }
        await stop();
        return;
      }
      const clock=jstClock();
      const dueAmazon=windows.amazon;
      const runs=observed.latest.filter(row=>jstClock(new Date(row.started_at)).day===day &&
        jstClock(new Date(row.started_at)).minute>=dueAmazon&&
        jstClock(new Date(row.started_at)).minute<=dueAmazon+5);
      if(runs.length){
        const row=runs[0];
        setState('amazon',!row.finished_at?'running':row.state==='success'?'completed':row.state==='partial'?'partial':'failed',
          {runId:String(row.id)});
      }
      for(const name of keys){
        let info=children.get(name);
        if(!info) {launch(name);info=children.get(name);}
        const fingerprintNow=fingerprint(name);
        const pendingHash=pending.get(name);
        if(fingerprintNow!==info.fingerprint){
          if(!pendingHash||pendingHash.value!==fingerprintNow) pending.set(name,{value:fingerprintNow,firstSeen:Date.now()});
          else if(Date.now()-pendingHash.firstSeen>=30000 && canRestart(name,new Date(),observed.busy[name])){
            record('code_updated',{name});
            if(await idleStop(name,info)){
              launch(name);
              pending.delete(name);
            }
          }
        }else pending.delete(name);
        if(!status.jobs[name] && clock.minute>=windows[name]+6 && !observed.busy[name]){
          // Worker started after due, or no dispatched job was recorded in
          // the five-minute window: record the miss, never enqueue catch-up.
          setState(name,'skipped');
        }
      }
      if(!Object.values(observed.busy).some(Boolean))await triggerSync();
      triggerReviewSync(observed);
    }catch(error){record('supervisor_error',{reason:error.message});}
    finally{ticking=false;}
  }
  const control=createServer(socket=>{
    // Retain the banner consumed by existing read-only desktop probes.
    socket.write('Mita supervisor active\n');
    socket.setTimeout(15000,()=>socket.destroy());
    socket.on('error',()=>{});
    let input='',handled=false;
    socket.on('data',chunk=>{
      if(handled)return;
      input+=chunk.toString('utf8');
      if(input.length>8192){handled=true;socket.destroy();return;}
      if(!input.includes('\n'))return;
      handled=true;
      void (async()=>{
        try{
          let message;
          try{message=JSON.parse(input.slice(0,input.indexOf('\n')));}catch{throw Error('Invalid sync request JSON.');}
          if(message.protocol!=='mita-sync-v1')throw Error('Unsupported sync protocol.');
          let result;
          if(message.action==='Status'){
            const observed=await activeLocks();
            const state=syncInFlight?'running':status?.sync?.state==='running'?'unknown':status?.sync?.state??'unknown';
            result={day,state,status,workerLocks:observed.busy,inFlight:syncInFlight,dispatching:syncDispatching,reviewSyncInFlight,owner:syncInFlight?syncOwner:null,lastRun:syncOwner,
              ledger:'not-observed; remote atomic daily claim remains authoritative',forceRerunSupported:false,canStop:false};
          }else if(message.action==='SyncNow'){
            if(!/^[a-zA-Z0-9-]{1,80}$/.test(message.sessionId??''))throw Error('Desktop session ID required.');
            if(message.force)throw Error('Forced rerun is unsupported: ledger claims must never be replaced.');
            await authorizeSync(message.cookie,message.csrf);
            if(ticking)throw Error('Coordinator refreshing; retry manually after status refresh.');
            updateDay();
            const owner=await triggerSync(message);
            if(!owner)throw Error('Daily sync already planned; no replay.');
            result={state:'accepted',owner,canStop:false,forceRerunSupported:false};
          }else throw Error('Only Status and SyncNow are supported; no stop or retry.');
          socket.end(JSON.stringify({ok:true,protocol:'mita-sync-v1',root,pid:process.pid,supervisorRunId,observedAt:new Date().toISOString(),...result})+'\n');
        }catch(error){socket.end(JSON.stringify({ok:false,protocol:'mita-sync-v1',error:error.message})+'\n');}
      })();
    });
  });
  await new Promise((resolve,reject)=>{
    control.once('error',reject);
    control.listen(STATUS_PORT,'127.0.0.1',resolve);
  });
  record('supervisor_started',{pid:process.pid,mode:keys.join(',')});
  await tick();
  const timer=setInterval(()=>void tick(),refreshMs);
  async function stop(){
    if(exiting)return;
    exiting=true;
    try {
      // Called by the private stop file only when all locks and windows are idle.
      for(const [name,info] of children){
        if(!await idleStop(name,info))return;
      }
      clearInterval(timer);
      unlinkSync(STOP_FILE);
      control.close();
      record('supervisor_stopped');
      process.exit(0);
    }finally{exiting=false;}
  }
  process.once('SIGINT',()=>{writeFileSync(STOP_FILE,'stop\n');});
  process.once('SIGTERM',()=>{writeFileSync(STOP_FILE,'stop\n');});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runSupervisor().catch(error=>{console.error(error.message);process.exitCode=1;});
}
