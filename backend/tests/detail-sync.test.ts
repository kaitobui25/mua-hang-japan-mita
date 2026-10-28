import test, { after } from 'node:test';
import pg from 'pg';
import { config } from '../src/config.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { db } from '../src/db/pool.js';
import { ingestObservations } from '../src/ingestion/store.js';
import { syncCatalog, seedExistingDetails, processCategoryDetails } from '../src/ingestion/sync.js';
import { SourceError, type Observation } from '../src/ingestion/source.js';
import { amazonGate, recordAmazonPause, nextAmazonRetryAt } from '../src/ingestion/source-access.js';

const category = 'thuc-pham-bo-sung';
after(async () => { await db.end(); });
const existing = 'S000000001', child = 'S000000002', discovered = 'S000000003';
const item = (asin: string, cat = category): Observation => ({ asin, categorySlug: cat,
  name: 'Daily enrichment fixture', sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, sourceAdapter: 'fixture',
  priceJpy: 1000, observedAt: new Date().toISOString() });

test('daily sync refreshes existing ASINs on discovery errors, records backlog and stops whole run on denial', async t => {
  // Session advisory lock prevents duplicate workers even with a one-connection pool.
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(70400200)');
    const duplicate = await syncCatalog({ discover: async () => { assert.fail('overlapping run must not crawl'); } });
    assert.equal(duplicate.state, 'already_running');
  } finally { await client.query('SELECT pg_advisory_unlock(70400200)'); await client.end(); }
  const isolatedPool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  const isolated = await isolatedPool.connect();
  const namespace = `detail_sync_test_${randomBytes(6).toString('hex')}`;
  try {
    await isolated.query(`CREATE SCHEMA ${namespace}`);
    await isolated.query(`SET search_path TO ${namespace}`);
    await isolated.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    await ingestObservations([item(existing)], undefined, isolated);
    assert.equal(await seedExistingDetails(isolated), 1, 'existing legacy ASIN seeded without Amazon requests');
    assert.equal(await seedExistingDetails(isolated), 0, 'seeding is idempotent');
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM product_detail_queue')).rows[0].n, 1);
    const calls: string[] = [];
    const result = await syncCatalog({
      connection: isolated,
      discover: async seed => {
        if (seed.categorySlug === category) throw new SourceError('temporary', 'listing unavailable');
        return { observations: [], issues: [] };
      },
      collect: async (asin, cat) => { calls.push(asin); return { ...item(asin, cat), detail: {
        features: ['Observed daily'], ingredients: [], usage: [], specs: {}, cautions: [], variantAttributes: {},
        childAsins: asin === existing ? [child] : [], sourceObservedAt: new Date().toISOString(),
        provenance: { sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, adapter: 'fixture', sections: ['twister'] }
      } }; }, limit: 1
    });
    assert.equal(result.state, 'partial');
    assert.deepEqual(calls, [existing]);
    assert.equal(result.saved, 1);
    assert.equal(result.deferred?.[category], 1);
    const queue = await isolated.query('SELECT state,last_attempt_at FROM product_detail_queue WHERE asin=$1', [child]);
    assert.equal(queue.rows[0].state, 'pending');
    assert.equal(queue.rows[0].last_attempt_at, null);
    const note = (await isolated.query('SELECT note FROM sync_runs WHERE id=$1', [result.id])).rows[0].note;
    assert.equal(JSON.parse(note).deferred[category], 1);
    // Listing products are queued, but never saved if the subsequent detail crawl is denied.
    let discoveries = 0, detailCalls = 0;
    const blocked = await syncCatalog({
      connection: isolated,
      discover: async () => { discoveries++; return { observations: [item(discovered)], issues: [] }; },
      collect: async () => { detailCalls++; throw new SourceError('blocked', 'HTTP 429'); }
    });
    assert.equal(blocked.state, 'failed');
    assert.equal(detailCalls, 1);
    assert.equal(discoveries, 1, 'the second category must not be fetched after denial');
    assert.equal((await isolated.query('SELECT * FROM products WHERE asin=$1', [discovered])).rows.length, 0);
    assert.equal((await isolated.query('SELECT name FROM products WHERE asin=$1', [existing])).rows[0].name, 'Daily enrichment fixture');
    const errors = await isolated.query('SELECT state,asin FROM sync_errors WHERE sync_run_id=$1', [blocked.id]);
    assert.equal(errors.rows[0].state, 'blocked');
    assert.equal(errors.rows[0].asin, child);
    // A blocked category must not issue further Amazon requests on a later run.
    const paused = await syncCatalog({
      connection: isolated, categories: [category],
      discover: async () => { assert.fail('human verification not cleared: do not hit listing'); },
      collect: async () => { assert.fail('human verification not cleared: do not hit detail'); }
    });
    assert.equal(paused.state, 'failed');
    assert.equal(paused.saved, 0);
    const cooldown = (await isolated.query('SELECT retry_after_at FROM source_access_blocks')).rows[0].retry_after_at;
    assert.ok(cooldown > new Date());
    assert.equal(cooldown.getUTCHours(), 19);
    const historyCount = (await isolated.query('SELECT count(*)::int AS n FROM sync_errors')).rows[0].n;
    // Only a scheduled window may consume a due cooldown. Imports/manual runs cannot.
    await isolated.query(`UPDATE source_access_blocks SET retry_after_at='2026-10-28T19:00:00Z'`);
    const due = new Date('2026-10-28T19:00:00Z');
    assert.equal(await amazonGate(isolated, false, due), false);
    assert.equal(await amazonGate(isolated, true, new Date('2026-10-28T19:06:00Z')), false);
    assert.equal(await amazonGate(isolated, true, due), true);
    assert.equal(await amazonGate(isolated, true, due), false, 'only one re-entry reservation');
    // A scheduled re-entry reaches the collector once; a new denial creates tomorrow's gate.
    await isolated.query(`UPDATE source_access_blocks SET retry_after_at=$1`, [due]);
    t.mock.timers.enable({ apis: ['Date'], now: due });
    let reentries = 0;
    const captcha = await syncCatalog({ connection: isolated, scheduled: true,
      discover: async () => ({ observations: [], issues: [] }),
      collect: async () => { reentries++; throw new SourceError('blocked', 'Amazon CAPTCHA'); }
    });
    assert.equal(reentries, 1);
    const again = await syncCatalog({ connection: isolated, scheduled: true,
      discover: async () => { assert.fail('no repeated scheduled probing'); } });
    assert.equal(again.state, 'failed');
    assert.equal((await isolated.query('SELECT retry_after_at FROM source_access_blocks')).rows[0].retry_after_at.toISOString(), nextAmazonRetryAt(due).toISOString());
    t.mock.timers.reset();
    assert.equal(captcha.state, 'failed');
    assert.equal((await isolated.query('SELECT state FROM product_detail_queue WHERE asin=$1', [child])).rows[0].state, 'failed');
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM sync_errors')).rows[0].n, historyCount + 1);
    assert.equal((await isolated.query('SELECT name FROM products WHERE asin=$1', [existing])).rows[0].name, 'Daily enrichment fixture');
    // Transient failure during tomorrow's re-entry also cannot trigger repeated probing.
    const tomorrow = nextAmazonRetryAt(due);
    t.mock.timers.enable({ apis: ['Date'], now: tomorrow });
    const transient = await syncCatalog({ connection: isolated, scheduled: true, categories: [category], limit: 1,
      discover: async () => ({ observations: [], issues: [] }),
      collect: async () => { throw new SourceError('temporary', 'fixture timeout'); } });
    assert.equal(transient.state, 'failed');
    assert.equal((await isolated.query('SELECT retry_after_at FROM source_access_blocks')).rows[0].retry_after_at.toISOString(), nextAmazonRetryAt(tomorrow).toISOString());
    assert.equal((await syncCatalog({ connection: isolated, scheduled: true,
      discover: async () => { assert.fail('transient re-entry cannot repeat today'); } })).state, 'failed');
    // An error-free scheduled re-entry clears the gate and resumes normal operation.
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date'], now: nextAmazonRetryAt(tomorrow) });
    const recovered = await syncCatalog({ connection: isolated, scheduled: true, categories: [category], limit: 1,
      discover: async () => ({ observations: [], issues: [] }), collect: async (asin, cat) => item(asin, cat) });
    assert.equal(recovered.state, 'success');
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM source_access_blocks')).rows[0].n, 0);
    t.mock.timers.reset();
    // Listing denial has no ASIN but still blocks all other categories and manual runs.
    await isolated.query(`DELETE FROM source_access_blocks`);
    const denied = await syncCatalog({ connection: isolated,
      discover: async () => { throw new SourceError('rate_limited', 'HTTP 429 exhausted'); },
      collect: async () => { assert.fail('no detail after listing denial'); } });
    assert.equal(denied.state, 'failed');
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM source_access_blocks')).rows[0].n, 1);
    assert.equal((await syncCatalog({ connection: isolated, discover: async () => { assert.fail('blocked'); } })).state, 'failed');
    await isolated.query('DELETE FROM source_access_blocks'); // fixture reset
    let attempts = 0;
    const partial = await syncCatalog({ connection: isolated, categories: [category], limit: 2,
      discover: async () => ({ observations: [], issues: [] }),
      collect: async (asin, cat) => {
        if (++attempts === 2) throw new SourceError('blocked', 'HTTP 403 after good detail');
        return item(asin, cat);
      } });
    assert.equal(partial.state, 'partial');
    assert.equal(partial.saved, 1);
    assert.equal(attempts, 2);
    assert.equal((await isolated.query("SELECT count(*)::int AS n FROM sync_errors WHERE state='needs_human'")).rows[0].n, 0);

  } finally {
    await isolated.query('RESET search_path');
    await isolated.query(`DROP SCHEMA ${namespace} CASCADE`);
    isolated.release();
    await isolatedPool.end();
  }
});
