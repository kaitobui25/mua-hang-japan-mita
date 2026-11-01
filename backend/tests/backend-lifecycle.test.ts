import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { db } from '../src/db/pool.js';
import { buildServer, getLocalBackendLifecycle, isLocalBackendStopRequested } from '../src/server.js';

after(async () => { await db.end(); });

test('local lifecycle requires exact Windows port, DB and stop-file authorization', async () => {
  const runId = 'a'.repeat(32);
  const stopFile = join(fileURLToPath(new URL('../../.agents/runtime/backend-4000/', import.meta.url)), `${runId}.backend-stop`);
  const databaseUrl = 'postgresql://mita_local@127.0.0.1:5433/postgres';
  const environment = { MITA_BACKEND_RUN_ID: runId, MITA_BACKEND_STOP_FILE: stopFile };
  assert.deepEqual(getLocalBackendLifecycle(environment, 4000, databaseUrl, 'win32'), { runId, stopFile });
  assert.equal(getLocalBackendLifecycle(environment, 4000, databaseUrl, 'linux'), undefined);
  assert.equal(getLocalBackendLifecycle(environment, 4100, databaseUrl, 'win32'), undefined);
  assert.equal(getLocalBackendLifecycle(environment, 4000, 'postgresql://mita@127.0.0.1:15432/postgres', 'win32'), undefined);
  assert.equal(getLocalBackendLifecycle({ ...environment, MITA_BACKEND_STOP_FILE: 'wrong' }, 4000, databaseUrl, 'win32'), undefined);
  assert.equal(getLocalBackendLifecycle({ ...environment, MITA_BACKEND_RUN_ID: 'invalid' }, 4000, databaseUrl, 'win32'), undefined);

  // Exercise the real health handler with an isolated test DB pool; changing
  // config here only determines the opt-in guard, never the pool connection.
  const oldDbUrl = config.databaseUrl;
  const oldPort = config.port;
  const oldId = process.env.MITA_BACKEND_RUN_ID;
  const oldStop = process.env.MITA_BACKEND_STOP_FILE;
  try {
    config.port = 4000;
    config.databaseUrl = databaseUrl;
    process.env.MITA_BACKEND_RUN_ID = runId;
    process.env.MITA_BACKEND_STOP_FILE = stopFile;
    const server = buildServer();
    try {
      const result = await server.inject({ method: 'GET', url: '/api/health' });
      assert.equal(result.statusCode, 200);
      if (process.platform === 'win32') assert.equal(result.json().lifecycleRunId, runId);
      else assert.equal(result.json().lifecycleRunId, undefined);
    } finally { await server.close(); }

    process.env.MITA_BACKEND_STOP_FILE = 'wrong';
    const unauthorized = buildServer();
    try {
      const result = await unauthorized.inject({ method: 'GET', url: '/api/health' });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().lifecycleRunId, undefined);
    } finally { await unauthorized.close(); }
  } finally {
    config.databaseUrl = oldDbUrl;
    config.port = oldPort;
    if (oldId === undefined) delete process.env.MITA_BACKEND_RUN_ID;
    else process.env.MITA_BACKEND_RUN_ID = oldId;
    if (oldStop === undefined) delete process.env.MITA_BACKEND_STOP_FILE;
    else process.env.MITA_BACKEND_STOP_FILE = oldStop;
  }
});

test('local stop signal requires the exact run ID; missing file is not a stop', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mita-lifecycle-'));
  const lifecycle = { runId: 'b'.repeat(32), stopFile: join(directory, 'stop') };
  try {
    assert.equal(isLocalBackendStopRequested(lifecycle), false);
    writeFileSync(lifecycle.stopFile, 'wrong-id');
    assert.equal(isLocalBackendStopRequested(lifecycle), false);
    writeFileSync(lifecycle.stopFile, lifecycle.runId);
    assert.equal(isLocalBackendStopRequested(lifecycle), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
