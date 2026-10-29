import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { galleryPilotAsins, galleryPilotDue, galleryPilotMarker } from '../src/ingestion/gallery-pilot.js';
import { syncCatalog } from '../src/ingestion/sync.js';
import { SourceError } from '../src/ingestion/source.js';
import { db } from '../src/db/pool.js';
import { after } from 'node:test';
after(() => db.end());

const due = new Date('2026-10-29T19:00:00Z');
test('pilot accepts only the explicitly armed scheduled window', () => {
  assert.equal(galleryPilotDue('2026-10-30', true, due), true);
  for (const [date, scheduled, now] of [
    ['2026-10-30', false, due], ['2026-10-29', true, due],
    ['2026-10-30', true, new Date('2026-10-29T19:06:00Z')],
    ['2026-10-30', true, new Date('2026-10-30T19:00:00Z')],
    ['', true, due]
  ] as const) assert.equal(galleryPilotDue(date, scheduled, now), false);
});

function fixture({ locked = true, cooldown = false, consumed = false } = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let claimed = consumed;
  const connection = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    let rows: unknown[] = [];
    if (sql.includes('pg_try_advisory_lock')) rows = [{ acquired: locked }];
    else if (sql.includes('INSERT INTO sync_runs')) rows = [{ id: '1' }];
    else if (sql.includes('SELECT retry_after_at')) rows = cooldown ? [{ retry_after_at: new Date('2026-11-01') }] : [];
    else if (sql.includes('RETURNING source')) rows = [];
    else if (sql.includes('SELECT id FROM sync_runs')) rows = claimed ? [{ id: '1' }] : [];
    else if (sql.includes('UPDATE sync_runs SET note=')) { assert.equal(JSON.parse(values[1] as string).galleryPilot, galleryPilotMarker); claimed = true; }
    else if (sql.includes('SELECT asin,parent_asin,provenance')) {
      assert.deepEqual(values[2], [...galleryPilotAsins], 'SQL restricts rank-independent selection to exact allowlist');
      assert.match(sql, /asin=ANY\(\$3/);
      assert.equal(values[0], 'thuc-pham-cho-be');
      const next = galleryPilotAsins.find(asin => !(values[1] as string[]).includes(asin));
      rows = next ? [{ asin: next, parent_asin: null, provenance: {} }] : [];
    } else if (sql.includes('count(*)::text')) rows = [{ count: '999' }];
    return { rows, rowCount: rows.length };
  }} as unknown as PoolClient;
  return { connection, queries, isClaimed: () => claimed };
}

test('scheduled pilot claims durably before requests, attempts only five, and never repeats', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: due });
  const f = fixture();
  const calls: string[] = [];
  const options = { connection: f.connection, scheduled: true, galleryPilotDate: '2026-10-30', limit: 999,
    discover: async () => { assert.fail('pilot must not request listings'); },
    collect: async (asin: string) => {
      assert.equal(f.isClaimed(), true);
      calls.push(asin);
      throw new SourceError('temporary', 'offline fixture');
    } };
  const result = await syncCatalog(options);
  assert.equal(result.attempted, 5);
  assert.deepEqual(calls, [...galleryPilotAsins]);
  assert.equal((await syncCatalog(options)).state, 'pilot_consumed');
  assert.equal(calls.length, 5);
  assert.ok(f.queries.some(q => q.sql.includes('pg_advisory_unlock')));
});

test('mutex, cooldown, and source denial fail closed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: due });
  for (const setup of [{ locked: false }, { cooldown: true }, { consumed: true }]) {
    const f = fixture(setup);
    await syncCatalog({ connection: f.connection, scheduled: true, galleryPilotDate: '2026-10-30',
      collect: async () => { assert.fail('gated pilot must not collect'); },
      discover: async () => { assert.fail('gated pilot must not discover'); } });
  }
  const f = fixture();
  let requests = 0;
  await syncCatalog({ connection: f.connection, scheduled: true, galleryPilotDate: '2026-10-30',
    collect: async () => { requests++; throw new SourceError('blocked', 'offline CAPTCHA'); } });
  assert.equal(requests, 1);
  assert.ok(f.queries.some(q => q.sql.includes('INSERT INTO source_access_blocks')));
  assert.ok(!f.queries.some(q => q.sql.includes('DELETE FROM source_access_blocks')));
});

test('out-of-window pilot returns before database access', async () => {
  const result = await syncCatalog({ galleryPilotDate: '2026-10-30', scheduled: false,
    connection: { query: async () => assert.fail('no DB access outside window') } as unknown as PoolClient });
  assert.equal(result.state, 'pilot_outside_window');
});
