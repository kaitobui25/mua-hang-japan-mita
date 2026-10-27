import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config.js';
import { claimDueAmazonContinuation, recordAmazonPause } from '../src/ingestion/source-access.js';

test('Amazon 30s deadline can be observed while main DB_POOL_MAX=1 is occupied', { timeout: 10_000 }, async () => {
  // A translator can hold the only normal DB connection during a slow remote
  // inference call. The worker's independent continuation pool must still tick.
  const primary = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  const continuation = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  const occupied = await primary.connect();
  const gate = await continuation.connect();
  try {
    // Temporary table ensures this assertion never mutates shared test data.
    await gate.query(`CREATE TEMP TABLE source_access_blocks (
      source text PRIMARY KEY, reason text NOT NULL, blocked_at timestamptz DEFAULT now(),
      continuation_due_at timestamptz, timeout_recorded_at timestamptz
    )`);
    await recordAmazonPause(gate, 'test CAPTCHA');
    await gate.query(`UPDATE source_access_blocks SET continuation_due_at=now()-interval '1 second'`);
    const started = Date.now();
    assert.equal(await claimDueAmazonContinuation(gate), true);
    assert.ok(Date.now() - started < 5_000, 'continuation must not wait for the held default connection');
    assert.equal(await claimDueAmazonContinuation(gate), false, 'timeout event must be observed only once');
  } finally {
    gate.release();
    occupied.release();
    await continuation.end();
    await primary.end();
  }
});
