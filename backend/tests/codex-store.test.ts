import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveCodexName, assertCodexNameSchema } from '../src/translation/codex-store.js';

const source = { asin: 'B000000001', name: 'DHC ビタミン 500mg', brand: 'DHC',
  prior_name: 'DHC vitamin cũ 500mg', prior_updated_at: '2026-11-01 01:01:01.123456+00' };
const input = { runId: '00000000-0000-4000-8000-000000000001', cycleId: '1', source,
  full: 'DHC vitamin mới 500g', short: null };

function fixture(mode = 'save') {
  const calls: { sql: string; values: unknown[] }[] = [];
  return { calls, client: { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM products WHERE')) return { rows: [{ ...source, name: mode === 'source' ? 'DHC 700mg' : source.name }] };
    if (sql.includes('FROM product_translations WHERE')) return { rows: [{ name: source.prior_name,
      status: 'success', revision_token: mode === 'translation' ? 'newer' : source.prior_updated_at }] };
    if (sql.includes('SELECT asin FROM codex_name_run_items')) return { rows: mode === 'reservation' ? [] : [{ asin: source.asin }] };
    if (sql.includes('INSERT INTO codex_name_history')) return { rows: [{ id: '42' }] };
    if (sql === 'COMMIT' && mode === 'commit') throw new Error('uncertain_commit');
    if (sql.includes('INSERT INTO product_translations') && mode === 'write') throw new Error('write_failed');
    return { rows: [] };
  } } };
}

test('Codex replaces an existing successful name despite semantic warning, atomically records provenance and removes stale short', async () => {
  const f = fixture();
  const result = await saveCodexName(f.client as never, input);
  assert.equal(result.saved, true);
  assert.ok(result.issues.includes('units_changed'));
  assert.ok(result.issues.includes('short_unusable'));
  const history = f.calls.find(call => call.sql.includes('INSERT INTO codex_name_history'))!;
  assert.equal(JSON.parse(String(history.values[4])).title.name, source.prior_name);
  const save = f.calls.find(call => call.sql.includes('INSERT INTO product_translations'))!;
  assert.equal(save.values[4], 'warning');
  assert.equal(save.values[7], '42');
  assert.equal(save.values[8], input.runId);
  assert.doesNotMatch(save.sql, /detail\s*=|name_attempts\s*=/);
  assert.match(save.sql, /name_only=CASE WHEN product_translations.detail IS NOT NULL AND/);
  assert.match(save.sql, /product_translations.detail_approved OR/);
  assert.match(save.sql, /product_translations.status='success' AND NOT product_translations.name_only/);
  assert.doesNotMatch(save.sql, /status IN \('success','warning'\) AND NOT product_translations.name_only/);
  assert.match(save.sql, /detail_approved=product_translations.detail_approved OR\s+\(product_translations.status='success' AND NOT product_translations.name_only AND product_translations.detail IS NOT NULL\)/);
  assert.doesNotMatch(f.calls.map(call => call.sql).join('\n'), /translation_settings|UPDATE products/);
  assert.ok(f.calls.some(call => call.sql.includes('DELETE FROM product_title_presentations')));
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
});

test('Codex source/translation CAS rejects changes without replacing or auditing titles', async () => {
  for (const mode of ['source', 'translation']) {
    const f = fixture(mode);
    assert.deepEqual(await saveCodexName(f.client as never, input), { saved: false, issues: ['source_changed'] });
    assert.ok(!f.calls.some(call => /INSERT INTO|DELETE FROM/.test(call.sql)));
    assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  }
});

test('missing reservation, DB failure and uncertain commit are surfaced without replay', async () => {
  for (const mode of ['reservation', 'write', 'commit']) {
    const f = fixture(mode);
    await assert.rejects(saveCodexName(f.client as never, input));
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(f.calls.filter(call => call.sql === 'COMMIT').length, mode === 'commit' ? 1 : 0);
  }
  const f = fixture();
  await assert.rejects(saveCodexName(f.client as never, { ...input, full: '<script>bad</script>' }));
  assert.equal(f.calls.length, 0);
});

test('missing Codex schema fails read-only without applying SQL', async () => {
  const calls: string[] = [];
  await assert.rejects(assertCodexNameSchema({ query: async (sql: string) => { calls.push(sql); return { rows: [] }; } } as never), /codex_schema_unavailable/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /information_schema/);
  assert.doesNotMatch(calls[0], /CREATE|ALTER|INSERT|UPDATE|DELETE/);
});
