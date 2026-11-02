import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { createCodexProvider } from '../src/translation/codex-provider.js';

function transport(mode = 'ok') {
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; }
  });
  const send = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    // The transport must handle fragmented UTF-8 JSONL without mangling names.
    for (let offset = 0; offset < bytes.length; offset += 3) child.stdout.write(bytes.subarray(offset, offset + 3));
  };
  let accounts = 0;
  child.stdin.on('data', (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString());
    requests.push(message);
    if (message.id === undefined) return;
    const result = (value: unknown) => send({ id: message.id, result: value });
    switch (message.method) {
      case 'initialize': result({}); break;
      case 'account/read':
        accounts++;
        result({ account: { type: mode === 'apikey' ? 'apiKey' : 'chatgpt',
          email: mode === 'account-changed' && accounts > 1 ? 'other@example.invalid' : 'fixture@example.invalid' } }); break;
      case 'account/rateLimits/read': result({ rateLimits: { limitId: 'codex', primary: {
        usedPercent: 25, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 10000
      } } }); break;
      case 'thread/start': result({ thread: { id: 'fixture-thread', ephemeral: true } }); break;
      case 'turn/start':
        result({ turn: { id: 'fixture-turn', status: 'inProgress' } });
        if (mode === 'rpc-error') { send({ id: 999, method: 'item/commandExecution/requestApproval', params: {} }); break; }
        if (mode === 'tool') {
          send({ method: 'item/started', params: { threadId: 'fixture-thread', item: { type: 'commandExecution' } } }); break;
        }
        send({ method: 'item/completed', params: { threadId: 'fixture-thread', item: {
          type: 'agentMessage', text: '{"translations":[{"asin":"B000000001","full":"Tên Việt 500mg","short":null}]}'
        } } });
        send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: {
          id: 'fixture-turn', status: mode === 'failed' ? 'failed' : 'completed'
        } } }); break;
    }
  });
  return { child, requests, spawn: (() => child) as never };
}
const environment = { MITA_CODEX_AUTOMATION_VERIFIED: '1', MITA_CODEX_EXECUTABLE: resolve('synthetic', 'codex.exe') };
const products = [{ asin: 'B000000001', name: '商品 500mg', brand: null }];

test('Codex stdio handshake uses one ChatGPT session for fresh quota and bounded structured turns', async () => {
  const fake = transport();
  const provider = await createCodexProvider({ spawn: fake.spawn, environment });
  try {
    assert.equal((await provider.quota()).allowed, true);
    const output = await provider.translate(products);
    assert.equal(JSON.parse(output).translations[0].full, 'Tên Việt 500mg');
    assert.deepEqual(fake.requests.slice(0, 5).map(request => request.method), [
      'initialize', 'initialized', 'account/read', 'account/read', 'account/rateLimits/read'
    ]);
    const turn = fake.requests.find(request => request.method === 'turn/start')!.params!;
    assert.equal(turn.model, 'gpt-6.1-sol');
    assert.equal(turn.effort, 'low');
    assert.equal(turn.approvalPolicy, 'never');
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.ok(turn.outputSchema);
  } finally { await provider.close(); }
  assert.equal(fake.child.signalCode, 'SIGTERM');
});

test('Codex refuses API auth/account switches and discards failed turns or unexpected tool requests', async () => {
  const api = transport('apikey');
  await assert.rejects(createCodexProvider({ spawn: api.spawn, environment }), /codex_chatgpt_login_required/);
  for (const mode of ['account-changed', 'failed', 'tool', 'rpc-error']) {
    const fake = transport(mode);
    const provider = await createCodexProvider({ spawn: fake.spawn, environment });
    try {
      if (mode === 'account-changed') assert.equal((await provider.quota()).reason, 'quota_unknown');
      else await assert.rejects(provider.translate(products), /codex_/);
    } finally { await provider.close(); }
  }
});
