import test, { after } from 'node:test';
import pg from 'pg';
import { config } from '../src/config.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { db } from '../src/db/pool.js';
import { ingestObservations } from '../src/ingestion/store.js';
import { syncCatalog, seedExistingDetails, processCategoryDetails, acknowledgeSourceAccess } from '../src/ingestion/sync.js';
import { SourceError, type Observation } from '../src/ingestion/source.js';

const category = 'thuc-pham-bo-sung';
after(async () => { await db.end(); });
const existing = 'S000000001', child = 'S000000002', discovered = 'S000000003';
const item = (asin: string, cat = category): Observation => ({ asin, categorySlug: cat,
  name: 'Daily enrichment fixture', sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, sourceAdapter: 'fixture',
  priceJpy: 1000, observedAt: new Date().toISOString() });

test('daily sync refreshes existing ASINs on discovery errors, records backlog and stops whole run on denial', async () => {
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
    assert.equal(blocked.state, 'needs_human');
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
    assert.equal(paused.state, 'needs_human');
    assert.equal(paused.saved, 0);
    await assert.rejects(acknowledgeSourceAccess(child, false, isolated), /manually verified/);
    assert.equal(await acknowledgeSourceAccess(child, true, isolated), 1);
    assert.equal((await isolated.query('SELECT state FROM product_detail_queue WHERE asin=$1', [child])).rows[0].state, 'pending');
    // A listing may be blocked before an ASIN can be identified. The global
    // source marker must protect later categories and future worker restarts.
    const denied = await syncCatalog({ connection: isolated, categories: [category],
      discover: async () => { throw new SourceError('blocked', 'HTTP 403 listing'); },
      collect: async () => { assert.fail('no detail after listing denial'); } });
    assert.equal(denied.state, 'needs_human');
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM source_access_blocks')).rows[0].n, 1);
    const listingPaused = await syncCatalog({ connection: isolated, categories: ['thuc-pham-cho-be'],
      discover: async () => { assert.fail('source gate must stop other categories'); } });
    assert.equal(listingPaused.state, 'needs_human');
    assert.equal(await acknowledgeSourceAccess('ALL', true, isolated), 0);
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM source_access_blocks')).rows[0].n, 0);
  } finally {
    await isolated.query('RESET search_path');
    await isolated.query(`DROP SCHEMA ${namespace} CASCADE`);
    isolated.release();
    await isolatedPool.end();
  }
});
