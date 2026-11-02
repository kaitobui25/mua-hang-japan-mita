import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { db } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { saveCodexName } from '../src/translation/codex-store.js';
import { translateCodexNames } from '../src/translation/codex-jobs.js';
import type { CodexProvider } from '../src/translation/codex-provider.js';

// This suite cannot write via a direct invocation against a developer database.
// Only tests/run.ts sets the matching, randomly generated disposable DB marker.
const database = new URL(config.databaseUrl).pathname.slice(1);
const disposable = /^mita_test_[a-f0-9]{16}$/.test(database) && process.env.MITA_DISPOSABLE_TEST_DATABASE === database;
after(async () => { if (disposable) await db.end(); });

test('20 full Codex job records are committed using real disposable PostgreSQL',
  { skip: !disposable }, async () => {
    const client = await db.connect();
    // Sort ahead of every alphabetic fixture, so the real job selects only
    // this 20-row cohort even when other suite tests have inserted products.
    const asins = Array.from({ length: 20 }, (_, i) => `0${String(i + 1).padStart(9, '0')}`);
    try {
      await client.query(`INSERT INTO categories(slug,name,amazon_seed_url)
        VALUES('codex-test-20','Codex test','https://example.com') ON CONFLICT DO NOTHING`);
      for (const asin of asins) await client.query(`INSERT INTO products(asin,category_slug,name,brand,source_url,source_adapter)
        VALUES($1,'codex-test-20','DHC ビタミン 500mg','DHC','https://example.com','codex-test')`, [asin]);
    } finally { client.release(); }
    let calls = 0;
    const provider: CodexProvider = {
      quota: async () => ({ allowed: true, reason: 'ready', remainingFiveHour: 90 }),
      translate: async products => {
        calls++;
        return JSON.stringify({ translations: products.map(p => ({ asin: p.asin, full: 'DHC vitamin 500mg', short: null })) });
      },
      close: async () => {}
    };
    const runId = randomUUID();
    const run = await translateCodexNames({ runId, trigger: 'manual', maxProducts: 20,
      provider: async () => provider });
    assert.equal(run.state, 'completed');
    assert.equal(run.selected, 20);
    assert.equal(run.translated, 20);
    assert.equal(run.failed, 0);
    assert.equal(calls, 1);
    const saved = await db.query(`SELECT p.asin,t.name,t.name_revision,h.run_id,i.outcome,i.attempts
      FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
        JOIN codex_name_history h ON h.asin=p.asin AND h.id=t.name_revision
        JOIN codex_name_run_items i ON i.asin=p.asin AND i.run_id=h.run_id
      WHERE p.asin=ANY($1::varchar[]) ORDER BY p.asin`, [asins]);
    assert.equal(saved.rows.length, 20);
    assert.ok(saved.rows.every(row => row.name === 'DHC vitamin 500mg' && row.run_id === runId &&
      row.outcome === 'saved' && row.attempts === 1));
    const locks = await db.query(`SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype='advisory' AND granted AND classid=0 AND objid IN (70400200,70400300,70400301)`);
    assert.equal(locks.rows[0].n, 0);
  });

test('PostgreSQL identity normalization uses the real server address, not a mock',
  { skip: !disposable }, async () => {
    const target = new URL(config.databaseUrl);
    const { rows } = await db.query<{ database: string; raw: string; address: string; port: number }>(`
      SELECT current_database() AS database, inet_server_addr()::text AS raw,
        host(inet_server_addr()) AS address, inet_server_port() AS port`);
    assert.equal(rows[0].database, decodeURIComponent(target.pathname.slice(1)));
    assert.equal(rows[0].port, 5433);
    assert.equal(rows[0].address, '127.0.0.1');
    assert.ok(rows[0].raw === rows[0].address || rows[0].raw.startsWith(rows[0].address + '/'));
  });

test('Codex additive SQL upgrades an older schema, reapplies without resetting state, and preserves approved detail during title replacement',
  { skip: !disposable }, async () => {
    const client = await db.connect();
    const schema = `codex_fixture_${randomBytes(8).toString('hex')}`;
    const sqlUrl = (name: string) => new URL((import.meta.url.includes('/.test-build/') ? '../../src/db/' : '../src/db/') + name, import.meta.url);
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      // Representative pre-Codex schema: no new revision columns/tables.
      await client.query(`CREATE TABLE products(asin varchar(10) PRIMARY KEY,name text NOT NULL,brand text);
        CREATE TABLE product_translations(asin varchar(10) NOT NULL REFERENCES products(asin),locale text NOT NULL,
          name text,source_hash text NOT NULL,model text,status text,translated_at timestamptz,
          detail jsonb,detail_approved boolean NOT NULL DEFAULT false,name_only boolean NOT NULL DEFAULT false,
          name_attempts integer NOT NULL DEFAULT 0,name_source jsonb,name_issues jsonb NOT NULL DEFAULT '[]',
          updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(asin,locale));
        INSERT INTO products VALUES('B000000001','DHC ビタミン 500mg','DHC');
        INSERT INTO product_translations(asin,locale,name,source_hash,model,status,detail,detail_approved,name_attempts)
          VALUES('B000000001','vi','DHC vitamin cũ 500mg','approved-detail-hash','approved-detail-model','success',
            '{"features":["approved detail"]}',true,3);`);
      await client.query(await readFile(sqlUrl('title-presentations.sql'), 'utf8'));
      const migration = await readFile(sqlUrl('codex-names.sql'), 'utf8');
      await client.query(migration);
      const runId = randomUUID();
      const cycle = await client.query<{ id: string }>('INSERT INTO codex_name_cycles DEFAULT VALUES RETURNING id');
      const cycleId = cycle.rows[0].id;
      const prior = await client.query<{ name: string; updated_at: string }>("SELECT name,updated_at::text FROM product_translations WHERE asin='B000000001'");
      const source = { asin: 'B000000001', name: 'DHC ビタミン 500mg', brand: 'DHC',
        prior_name: prior.rows[0].name, prior_updated_at: prior.rows[0].updated_at };
      await client.query("INSERT INTO codex_name_runs(id,trigger,jst_day,cycle_id) VALUES($1,'manual',CURRENT_DATE,$2)", [runId, cycleId]);
      await client.query("INSERT INTO codex_name_cycle_items(cycle_id,asin,attempts) VALUES($1,'B000000001',1)", [cycleId]);
      await client.query(`INSERT INTO codex_name_run_items(run_id,asin,source,prior_name,prior_updated_at,attempts)
        VALUES($1,$2,$3,$4,$5,1)`, [runId, source.asin,
        JSON.stringify({ asin: source.asin, name: source.name, brand: source.brand }), source.prior_name, source.prior_updated_at]);
      const result = await saveCodexName(client, { runId, cycleId, source, full: 'DHC vitamin mới 500g', short: null });
      assert.equal(result.saved, true);
      assert.ok(result.issues.includes('units_changed'));
      await client.query(migration);
      const saved = (await client.query("SELECT * FROM product_translations WHERE asin='B000000001'")).rows[0];
      assert.equal(saved.name, 'DHC vitamin mới 500g');
      assert.equal(saved.status, 'warning');
      assert.equal(saved.name_attempts, 3);
      assert.equal(saved.detail_approved, true);
      assert.equal(saved.name_only, false);
      assert.equal(saved.source_hash, 'approved-detail-hash');
      assert.equal(saved.model, 'approved-detail-model');
      assert.deepEqual(saved.detail, { features: ['approved detail'] });
      const history = (await client.query('SELECT * FROM codex_name_history WHERE run_id=$1', [runId])).rows;
      assert.equal(history.length, 1);
      assert.equal(history[0].previous.title.name, source.prior_name);
      assert.equal(history[0].id, saved.name_revision);
      assert.equal((await client.query('SELECT attempts FROM codex_name_cycle_items')).rows[0].attempts, 1);
      for (const [index, detail] of [null, { features: ['unapproved previous detail'] },
        { features: ['unapproved warning detail'] }].entries()) {
        const asin = `B00000000${index + 2}`;
        await client.query('INSERT INTO products VALUES($1,$2,$3)', [asin, source.name, source.brand]);
        await client.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name_only,detail)
          VALUES($1,'vi','previous-detail-hash',$3,false,$2)`,
          [asin, detail === null ? null : JSON.stringify(detail), index === 2 ? 'warning' : 'failed']);
        const token = (await client.query('SELECT updated_at::text FROM product_translations WHERE asin=$1', [asin])).rows[0].updated_at;
        const failedSource = { ...source, asin, prior_name: null, prior_updated_at: token };
        await client.query('INSERT INTO codex_name_cycle_items(cycle_id,asin,attempts) VALUES($1,$2,1)', [cycleId, asin]);
        await client.query(`INSERT INTO codex_name_run_items(run_id,asin,source,prior_name,prior_updated_at,attempts)
          VALUES($1,$2,$3,NULL,$4,1)`, [runId, asin, JSON.stringify({ asin, name: source.name, brand: source.brand }), token]);
        assert.equal((await saveCodexName(client, { runId, cycleId, source: failedSource,
          full: 'DHC vitamin 500mg', short: null })).saved, true);
        const titleOnly = (await client.query('SELECT name_only,detail_approved,detail FROM product_translations WHERE asin=$1', [asin])).rows[0];
        assert.equal(titleOnly.name_only, true, 'a Codex title cannot promote missing/failed/unapproved warning details');
        assert.equal(titleOnly.detail_approved, false);
        assert.deepEqual(titleOnly.detail, detail);
      }
      // Legacy full approvals acquire the durable approval flag before title
      // warnings change status, protecting them from later detail-worker writes.
      const legacyAsin = 'B000000005';
      await client.query('INSERT INTO products VALUES($1,$2,$3)', [legacyAsin, source.name, source.brand]);
      await client.query(`INSERT INTO product_translations(asin,locale,name,source_hash,status,name_only,detail,detail_approved)
        VALUES($1,'vi','DHC vitamin cũ 500mg','legacy-detail-hash','success',false,'{"features":["legacy approved detail"]}',false)`, [legacyAsin]);
      let legacyCycle = cycleId;
      for (let iteration = 0; iteration < 2; iteration++) {
        const legacyRunId = randomUUID();
        if (iteration) {
          await client.query('UPDATE codex_name_cycles SET finished_at=now() WHERE id=$1', [legacyCycle]);
          legacyCycle = (await client.query('INSERT INTO codex_name_cycles DEFAULT VALUES RETURNING id')).rows[0].id;
        }
        await client.query("INSERT INTO codex_name_runs(id,trigger,jst_day,cycle_id) VALUES($1,'manual',CURRENT_DATE,$2)", [legacyRunId, legacyCycle]);
        await client.query('INSERT INTO codex_name_cycle_items(cycle_id,asin,attempts) VALUES($1,$2,1)', [legacyCycle, legacyAsin]);
        const previous = (await client.query('SELECT name,updated_at::text FROM product_translations WHERE asin=$1', [legacyAsin])).rows[0];
        const legacySource = { ...source, asin: legacyAsin, prior_name: previous.name, prior_updated_at: previous.updated_at };
        await client.query(`INSERT INTO codex_name_run_items(run_id,asin,source,prior_name,prior_updated_at,attempts)
          VALUES($1,$2,$3,$4,$5,1)`, [legacyRunId, legacyAsin,
          JSON.stringify({ asin: legacyAsin, name: source.name, brand: source.brand }), previous.name, previous.updated_at]);
        assert.equal((await saveCodexName(client, { runId: legacyRunId, cycleId: legacyCycle, source: legacySource,
          full: 'DHC vitamin mới 500g', short: null })).saved, true);
        const legacy = (await client.query('SELECT name_only,detail_approved,detail FROM product_translations WHERE asin=$1', [legacyAsin])).rows[0];
        assert.equal(legacy.name_only, false);
        assert.equal(legacy.detail_approved, true);
        assert.deepEqual(legacy.detail, { features: ['legacy approved detail'] });
        const detailEligible = await client.query(`SELECT asin FROM product_translations WHERE asin=$1 AND
          NOT (detail_approved OR (status='success' AND NOT name_only AND detail IS NOT NULL))`, [legacyAsin]);
        assert.equal(detailEligible.rows.length, 0);
      }
      await client.query("UPDATE product_translations SET name='A later legacy title 500g' WHERE asin='B000000001'");
      const later = (await client.query("SELECT name_revision,name_generation,name_model FROM product_translations WHERE asin='B000000001'")).rows[0];
      assert.deepEqual(later, { name_revision: null, name_generation: null, name_model: null });
      assert.equal((await client.query("SELECT count(*)::int AS count FROM codex_name_history WHERE asin='B000000001'")).rows[0].count, 1);
      await assert.rejects(client.query("INSERT INTO codex_name_runs(id,trigger,jst_day) VALUES($1,'scheduled',CURRENT_DATE),($2,'scheduled',CURRENT_DATE)", [randomUUID(), randomUUID()]));
    } finally {
      try { await client.query('SET search_path TO public'); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { client.release(); }
    }
  });
