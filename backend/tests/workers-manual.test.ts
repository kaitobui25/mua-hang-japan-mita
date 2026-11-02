import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { requestManualWorker, validateManualWorkerInput } from '../src/workers/manual.js';

const input = {worker:'names',maxProducts:20,requestId:'29bd33b0-c460-4fd6-9e67-32b58b359842'};
const cookie='mita_admin='+'a'.repeat(64);
const csrf='b'.repeat(64);

test('Manual requests are strictly bounded and tied to unique IDs', () => {
  assert.deepEqual(validateManualWorkerInput(input),input);
  for(const bad of [
    {...input,maxProducts:0},{...input,maxProducts:301},{...input,maxProducts:20.5},
    {...input,worker:'sync'},{...input,requestId:'abc'},null,
  ]) assert.throws(()=>validateManualWorkerInput(bad),/invalid_manual_worker_request/);
});

test('Only verified loopback coordinator receipts can acknowledge one manual dispatch', async () => {
  let message: Record<string, unknown> = {};
  const server=createServer(socket=>{
    socket.write('Mita supervisor active\n');
    socket.on('data',bytes=>{
      message=JSON.parse(bytes.toString().trim());
      socket.end(JSON.stringify({ok:true,protocol:'mita-sync-v1',
        state:'accepted',runId:input.requestId,worker:'names',limit:20})+'\n');
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  try{
    const receipt=await requestManualWorker(input,cookie,csrf,port);
    assert.deepEqual(receipt,{state:'accepted',runId:input.requestId,worker:'names',limit:20});
    assert.equal(message.action,'RunWorker');
    assert.equal(message.cookie,cookie);
    assert.equal(message.csrf,csrf);
    await assert.rejects(()=>requestManualWorker(input,'wrong',csrf,port),/owner_session_required/);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('Malformed or mismatched Supervisor response is never treated as accepted', async()=>{
  const server=createServer(socket=>{
    socket.write('Mita supervisor active\n');
    socket.once('data',()=>socket.end(JSON.stringify({ok:true,protocol:'mita-sync-v1',
      state:'accepted',runId:input.requestId,worker:'detail',limit:20})+'\n'));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    await assert.rejects(()=>requestManualWorker(input,cookie,csrf,port),/worker_supervisor_rejected/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
