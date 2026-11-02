import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { translateCodexNames, codexRunInput } from '../src/translation/codex-jobs.js';
import { config } from '../src/config.js';
import { CodexQuotaBeforeInferenceError, type CodexProvider } from '../src/translation/codex-provider.js';

// This file uses no database/network/CLI; even accidental real pool use fails.
import { db } from '../src/db/pool.js';
const runId = '00000000-0000-4000-8000-000000000002';
const existingColumns = {
  products: 'asin name brand',
  product_translations: 'asin locale name status detail detail_approved name_only source_hash model name_source name_issues updated_at translated_at name_revision name_generation name_model',
  product_title_presentations: 'asin source_name translated_name short_name omitted_facts model updated_at'
};
async function schemaColumns() {
  const sql = await readFile(new URL(import.meta.url.includes('/.test-build/') ?
    '../../src/db/codex-names.sql' : '../src/db/codex-names.sql', import.meta.url), 'utf8');
  const columns = Object.entries(existingColumns).flatMap(([table_name, names]) => names.split(' ').map(column_name => ({ table_name, column_name })));
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    for (const field of match[2].matchAll(/^  (\w+) (?:bigserial|bigint|uuid|text|date|integer|smallint|timestamptz|jsonb|varchar)/gm)) {
      columns.push({ table_name: match[1], column_name: field[1] });
    }
  }
  return columns;
}

test('Codex input bounds reject invalid runs before DB access', () => {
  assert.equal(codexRunInput({ trigger: 'scheduled' }).maxProducts, 300);
  for (const maxProducts of [0, 301, NaN, 1.5]) assert.throws(() => codexRunInput({ maxProducts }));
  assert.throws(() => codexRunInput({ runId: 'bad' }));
  assert.throws(() => codexRunInput({ trigger: 'startup' }));
});

test('Codex run gates, budgets, bounded retries and outcomes use mocked dependencies only', async t => {
  const columns = await schemaColumns();
  for (const scenario of [
    { mode: 'ok', count: 300, calls: 4, translated: 300, failed: 0, reason: null },
    { mode: 'invalid', count: 2, calls: 3, translated: 0, failed: 2, reason: null },
    { mode: 'quota', count: 2, calls: 0, translated: 0, failed: 0, reason: 'quota_unknown' },
    { mode: 'quota-later', count: 100, calls: 1, translated: 80, failed: 0, reason: 'quota_low' },
    { mode: 'quota-boundary', count: 2, calls: 1, translated: 0, failed: 0, reason: 'quota_low' },
    { mode: 'busy', count: 2, calls: 0, translated: 0, failed: 0, reason: 'worker_or_sync_busy' },
    { mode: 'duplicate', count: 2, calls: 0, translated: 0, failed: 0, reason: 'run_already_recorded' },
    { mode: 'unresolved', count: 2, calls: 0, translated: 0, failed: 0, reason: 'previous_run_unresolved' },
    { mode: 'provider', count: 2, calls: 1, translated: 0, failed: 0, reason: 'codex_provider_failed' },
    { mode: 'source', count: 2, calls: 1, translated: 0, failed: 0, reason: null }
  ]) await t.test(scenario.mode, async t => {
    t.mock.method(db, 'connect', () => { throw new Error('real_database_forbidden'); });
    const previousUrl = config.databaseUrl;
    config.databaseUrl = 'postgresql://synthetic@127.0.0.1:5433/codex_fixture';
    const products = Array.from({ length: scenario.count }, (_, i) => ({ asin: `B${String(i).padStart(9, '0')}`,
      name: 'DHC ビタミン 500mg', brand: 'DHC', prior_name: null, prior_updated_at: null }));
    const statements: { sql: string; values: unknown[] }[] = [];
    let released = false, closed = false, requests = 0, quotaReads = 0;
    const client = { query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.includes('information_schema')) return { rows: columns };
      if (sql.includes('FROM pg_indexes')) return { rows: [
        { indexname: 'codex_name_one_active_cycle', indexdef: 'CREATE UNIQUE INDEX fixture ON public.codex_name_cycles USING btree ((true)) WHERE (finished_at IS NULL)' },
        { indexname: 'codex_name_one_scheduled_day', indexdef: "CREATE UNIQUE INDEX fixture ON public.codex_name_runs USING btree (jst_day) WHERE (trigger = 'scheduled'::text)" },
        { indexname: 'codex_name_cycle_pending', indexdef: 'CREATE INDEX fixture ON public.codex_name_cycle_items USING btree (cycle_id,last_attempt_at,asin) WHERE ((completed_at IS NULL) AND (attempts < 3))' },
        { indexname: 'codex_name_history_asin', indexdef: 'CREATE INDEX fixture ON public.codex_name_history USING btree (asin, id DESC)' }
      ] };
      if (sql.includes('FROM pg_trigger')) return { rows: [{ tgname: 'mita_name_revision_guard' }] };
      if (sql.includes('current_database()')) {
        assert.match(sql, /host\(inet_server_addr\(\)\)/, 'normalization must strip PostgreSQL inet /32 or /128 mask');
        return { rows: [{ database: 'codex_fixture', address: '127.0.0.1', port: 5433 }] };
      }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: scenario.mode !== 'busy' }] };
      if (sql.includes("WHERE state='running'")) return { rows: scenario.mode === 'unresolved' ? [{ id: runId }] : [] };
      if (sql.includes('INSERT INTO codex_name_runs')) return { rows: scenario.mode === 'duplicate' ? [] : [{ id: runId }] };
      if (sql.includes('SELECT id FROM codex_name_cycles')) return { rows: [{ id: '1' }] };
      if (sql.includes('FROM codex_name_cycle_items i JOIN products')) {
        assert.equal(values[1], scenario.count);
        return { rows: products };
      }
      if (sql.includes('RETURNING asin') || sql.includes('SELECT asin FROM codex_name_run_items')) return { rows: [{ asin: 'reserved' }] };
      if (sql.includes('SELECT asin,name,brand FROM products')) return { rows: [{
        ...products.find(row => row.asin === values[0]), ...(scenario.mode === 'source' ? { name: 'changed' } : {}) }] };
      if (sql.includes('INSERT INTO codex_name_history')) return { rows: [{ id: '1' }] };
      return { rows: [] };
    }, release: () => { released = true; } };
    const provider: CodexProvider = { close: async () => { closed = true; },
      quota: async () => { quotaReads++; return { allowed: scenario.mode !== 'quota' && !(scenario.mode === 'quota-later' && quotaReads > 2),
        reason: scenario.mode === 'quota' ? 'quota_unknown' : scenario.mode === 'quota-later' && quotaReads > 2 ? 'quota_low' : 'ready', remainingFiveHour: 80 }; },
      translate: async rows => {
        requests++;
        assert.ok(rows.length <= 80);
        if (scenario.mode === 'quota-boundary') throw new CodexQuotaBeforeInferenceError('quota_low');
        if (scenario.mode === 'provider') throw new Error('synthetic');
        if (scenario.mode === 'invalid') return '{';
        return JSON.stringify({ translations: rows.map(row => ({ asin: row.asin, full: 'DHC vitamin 500mg', short: null })) });
      }
    };
    try {
      const result = await translateCodexNames({ runId, trigger: 'manual', maxProducts: scenario.count,
        connect: async () => client as never, provider: async () => provider });
      assert.equal(result.translated, scenario.translated);
      assert.equal(result.failed, scenario.failed);
      assert.equal(result.reason, scenario.reason);
      assert.equal(requests, scenario.calls);
      assert.equal(result.skipped, scenario.mode === 'source' ? scenario.count : 0);
      assert.equal(result.warnings, scenario.translated, 'short fallback warnings are durably published');
      assert.ok(released);
      if (!['busy', 'duplicate', 'unresolved'].includes(scenario.mode)) assert.ok(closed);
      if (scenario.mode === 'quota') assert.ok(!statements.some(call => call.sql.includes('INSERT INTO codex_name_run_items')));
      if (scenario.mode === 'quota-boundary') {
        assert.equal(statements.filter(call => call.sql.includes('codex_name_cycle_items SET attempts=attempts-1')).length, 2);
        assert.equal(statements.filter(call => call.sql.includes('codex_name_run_items SET attempts=attempts-1')).length, 2);
      }
      if (scenario.mode === 'busy') assert.ok(!statements.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)));
      assert.deepEqual(statements.filter(call => call.sql.includes('pg_advisory_unlock')).map(call => call.values[0]),
        scenario.mode === 'busy' ? [] : [70400301, 70400300, 70400200]);
    } finally { config.databaseUrl = previousUrl; }
  });
});
