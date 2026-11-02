import { createConnection } from 'node:net';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ManualWorkerInput = { worker: 'amazon' | 'names' | 'detail'; maxProducts: number; requestId: string };

export function validateManualWorkerInput(raw: unknown): ManualWorkerInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_manual_worker_request');
  const value = raw as Record<string, unknown>;
  if (!['amazon','names','detail'].includes(String(value.worker)) ||
      !Number.isInteger(value.maxProducts) || (value.maxProducts as number)<1 ||
      (value.maxProducts as number)>300 || typeof value.requestId!=='string' || !uuid.test(value.requestId)) {
    throw Error('invalid_manual_worker_request');
  }
  return { worker: value.worker as ManualWorkerInput['worker'],
    maxProducts: value.maxProducts as number, requestId: value.requestId };
}

type ManualReceipt = { state: 'accepted'; runId: string; worker: string; limit: number };
/** Sends one Owner-authorized command to the existing local Supervisor.
 * Never starts a worker directly from the HTTP process or silently retries. */
export async function requestManualWorker(raw: unknown, cookieHeader: string | undefined, csrf: string,
  port = 19978): Promise<ManualReceipt> {
  const input = validateManualWorkerInput(raw);
  const session = cookieHeader?.match(/(?:^|;\s*)(mita_admin=[a-f0-9]{64})(?:;|$)/i)?.[1];
  if (!session || !/^[a-f0-9]{64}$/.test(csrf)) throw Error('owner_session_required');
  return new Promise((resolve,reject) => {
    const socket=createConnection({host:'127.0.0.1',port});
    let done=false,received='',sent=false;
    const fail=(reason: string)=>{
      if(done)return; done=true; socket.destroy(); reject(Error(reason));
    };
    socket.setTimeout(7000,()=>fail('worker_dispatch_outcome_unknown'));
    socket.on('connect',()=>{
      sent=true;
      socket.write(JSON.stringify({protocol:'mita-sync-v1',action:'RunWorker',cookie:session,csrf,
        worker:input.worker,maxProducts:input.maxProducts,requestId:input.requestId})+'\n');
    });
    socket.on('data',chunk=>{
      received+=chunk.toString('utf8');
      if(received.length>8192){fail('worker_supervisor_response_invalid');return;}
      const lines=received.split(/\r?\n/).filter(Boolean);
      const line=lines.find(part=>part.startsWith('{"ok":'));
      if(!line)return;
      try {
        const value=JSON.parse(line);
        if(!value.ok || value.protocol!=='mita-sync-v1' || value.state!=='accepted' ||
            value.runId!==input.requestId || value.worker!==input.worker || value.limit!==input.maxProducts) {
          fail('worker_supervisor_rejected');return;
        }
        if(done)return;done=true;socket.end();
        resolve({state:'accepted',runId:value.runId,worker:value.worker,limit:value.limit});
      }catch{fail('worker_supervisor_response_invalid');}
    });
    socket.once('error',()=>fail(sent?'worker_dispatch_outcome_unknown':'worker_supervisor_unavailable'));
    socket.once('end',()=>{if(!done)fail('worker_dispatch_outcome_unknown');});
  });
}
