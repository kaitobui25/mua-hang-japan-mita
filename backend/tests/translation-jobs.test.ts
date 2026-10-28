import { db } from '../src/db/pool.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEnglishSuccessTitles, saveReviewedEnglishTitle, translatePendingNames, nameHash, sourceHash, sourceText, translationFailureStopsBatch } from '../src/translation/jobs.js';
import { TranslationUnavailable } from '../src/translation/openrouter.js';
import { translationCron, translationTimezone, shouldRunTranslation } from '../src/translation/schedule.js';

test('source content hash is stable for unchanged text and changes with Japanese source', () => {
  const row = {
    asin: 'A000000001', name: 'SAVAS 980g', brand: 'SAVAS',
    features: ['たんぱく質 20g'], ingredients: [], usage: [], specs: { weight: '980g' },
    cautions: [], source_hash: null, status: null
  };
  const text = sourceText(row);
  assert.equal(text.name, 'SAVAS 980g');
  assert.equal(sourceHash(text), sourceHash(sourceText({ ...row })));
  assert.notEqual(sourceHash(text), sourceHash(sourceText({ ...row, name: 'SAVAS 500g' })));
});

test('empty optional detail is normalized for translation', () => {
  const text = sourceText({
    name: '日本語の商品', brand: null,
    features: null, ingredients: null, usage: null, specs: null, cautions: null,
  });
  assert.deepEqual(text.features, []);
  assert.deepEqual(text.specs, {});
});

test('read-only audit pages identify English successful titles and retain frozen source identity', async () => {
  const source = { name: 'DHC Vitamin AB-1234 500mg', brand: 'DHC' };
  const rows = [
    { asin: 'A000000001', source_name: 'Changed Amazon name', brand: 'Changed',
      name_source: source, translated_name: 'DHC Vitamin AB-1234 500mg', source_hash: 'frozen-hash', status: 'success' },
    { asin: 'A000000002', source_name: 'DHC 商品', brand: 'DHC', name_source: null,
      translated_name: 'DHC bổ sung 500mg', source_hash: 'unchanged', status: 'success' }
  ];
  const statements: string[] = [];
  const client = { query: async (sql: string, values: unknown[]) => {
    statements.push(sql);
    assert.deepEqual(values, ['', 2]);
    return { rows };
  } };
  const audit = await auditEnglishSuccessTitles(client as never, { limit: 2 });
  assert.equal(audit.nextAfterAsin, 'A000000002');
  assert.equal(audit.candidates.length, 1);
  assert.deepEqual(audit.candidates[0], { asin: 'A000000001', sourceName: source.name,
    brand: 'DHC', translatedName: rows[0].translated_name, sourceHash: 'frozen-hash',
    sourceNameHash: nameHash(source) });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /t\.status='success'/);
  assert.doesNotMatch(statements[0], /UPDATE|DELETE|INSERT/);
  await assert.rejects(auditEnglishSuccessTitles(client as never, { limit: 501 }), /invalid_audit_page/);
});

test('explicit reviewed title replacement validates facts and uses compare-and-swap without changing approved details', async () => {
  const source = { name: 'DHC Vitamin AB-1234 500mg', brand: 'DHC' };
  const row = { asin: 'A000000001', source_name: source.name, brand: source.brand, name_source: null,
    translated_name: source.name, source_hash: 'frozen-hash', status: 'success' };
  let updates = 0, rolledBack = 0, committed = 0;
  const client = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('FOR UPDATE')) return { rows: [row] };
    if (sql.includes('UPDATE product_translations')) {
      updates++;
      assert.match(sql, /name=\$2/);
      assert.match(sql, /name=\$3 AND source_hash=\$4/);
      assert.doesNotMatch(sql, /detail\s*=|detail_approved\s*=|name_attempts\s*=/);
      assert.deepEqual(values, [row.asin, 'DHC bổ sung AB-1234 500mg', row.translated_name, row.source_hash]);
      return { rowCount: 1 };
    }
    if (sql === 'ROLLBACK') rolledBack++;
    if (sql === 'COMMIT') committed++;
    return { rows: [] };
  } };
  const audit = await auditEnglishSuccessTitles({ query: async () => ({ rows: [row] }) } as never);
  const candidate = audit.candidates[0];
  assert.equal(await saveReviewedEnglishTitle({ candidate, replacement: 'DHC bổ sung AB-1234 500mg', approved: true }, client as never), true);
  assert.equal(updates, 1);
  assert.equal(committed, 1);
  for (const replacement of ['DHC bổ sung AB-1234 501mg', 'DHC bổ sung AB-1234 500g',
    'DHC bổ sung XY-1234 500mg', 'ABC bổ sung AB-1234 500mg']) {
    await assert.rejects(saveReviewedEnglishTitle({ candidate, replacement, approved: true }, client as never));
  }
  assert.equal(updates, 1);
  assert.equal(rolledBack, 4);
  await assert.rejects(saveReviewedEnglishTitle({ candidate, replacement: 'DHC bổ sung AB-1234 500mg', approved: false } as never, client as never), /review_required/);
  assert.equal(updates, 1);
  assert.equal(await saveReviewedEnglishTitle({ candidate: { ...candidate, translatedName: 'stale' },
    replacement: 'DHC bổ sung AB-1234 500mg', approved: true }, client as never), false);
  assert.equal(updates, 1);
});

test('one bad product does not stop the batch; exhausted shared quota does', () => {
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['source_too_large'])), false);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['model-a:invalid_or_unavailable'])), false);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['model-a:http_429', 'model-b:timeout'])), false);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['providers_temporarily_unavailable'])), true);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['unauthorized_api_key'])), true);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['free_quota_exhausted'])), true);
});

test('name translation runs at 05:00 JST only when its own scheduler was alive at that time', () => {
  assert.equal(translationCron, '0 5 * * *');
  assert.equal(translationTimezone, 'Asia/Tokyo');
  const due = new Date('2026-10-27T20:00:00.000Z'); // 05:00 JST on 28 October
  const atDispatch = new Date('2026-10-27T20:00:25.000Z');
  assert.equal(shouldRunTranslation(due, new Date('2026-10-27T19:50:00Z'), atDispatch), true);
  assert.equal(shouldRunTranslation(due, new Date('2026-10-27T20:00:05Z'), atDispatch), false,
    'starting after 05:00 JST must not catch up');
  assert.equal(shouldRunTranslation(due, new Date('2026-10-27T19:50:00Z'), new Date('2026-10-27T20:06:00Z')), false);
  assert.equal(shouldRunTranslation(new Date('2026-10-26T20:00:00Z'), new Date('2026-10-27T19:50:00Z'), atDispatch), false);
});


test('scheduled translator splits truncation before failure writes and preserves recovered halves', async t => {
  for (const scenario of [
    { label: 'recursive recovery of 100 names', count: 100, threshold: 25, quota: 50, invalidCount: 0,
      sizes: [100, 50, 25, 25, 50, 25, 25], translated: 100, failed: 0, paused: false },
    { label: 'quota exhaustion keeps first half and leaves second pending', count: 100, threshold: 50, quota: 4, invalidCount: 0,
      sizes: [100, 50], translated: 50, failed: 0, paused: true },
    { label: 'singletons terminate and are marked failed individually', count: 3, threshold: 0, quota: 50, invalidCount: 0,
      sizes: [3, 2, 1, 1, 1], translated: 0, failed: 3, paused: false },
    { label: 'invalid units in a recovered half persist as warnings', count: 100, threshold: 50, quota: 50, invalidCount: 1,
      sizes: [100, 50, 50], translated: 100, failed: 0, paused: false },
    { label: '76-name regression saves warnings and valid siblings', count: 76, threshold: 100, quota: 37, invalidCount: 38,
      sizes: [76], translated: 76, failed: 0, paused: false },
    { label: 'all warned titles persist without splitting', count: 76, threshold: 100, quota: 37, invalidCount: 76,
      sizes: [76], translated: 76, failed: 0, paused: false },
    { label: 'continual truncation stops after two split levels', count: 100, threshold: 0, quota: 50, invalidCount: 0,
      sizes: [100, 50, 25, 25, 50, 25, 25], translated: 0, failed: 100, paused: false }
  ]) {
    await t.test(scenario.label, async t => {
      const rows = Array.from({ length: scenario.count }, (_, i) => ({
        asin: `B${String(i).padStart(9, '0')}`, name: 'Vitamin 500mg', brand: null,
        status: null, translated_name: null
      }));
      const snapshot = JSON.stringify(rows);
      const saved: string[] = [], failed: string[] = [], sizes: number[] = [];
      const attempts = new Map<string, number>();
      let released = false, unlocked = false, now = 0;
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) unlocked = true;
          if (sql.includes('RETURNING name_attempts')) {
            const asin = String(params[0]); const count = (attempts.get(asin) ?? 0)+1;
            attempts.set(asin,count); return { rows: [{ name_attempts: count }] };
          }
          if (sql.includes('INSERT INTO product_translations')) {
            (sql.includes("'failed'") ? failed : saved).push(String(params[0]));
          }
          return { rows: sql.includes('SELECT p.asin') ? rows : [] };
        },
        release: () => { released = true; }
      };
      t.mock.method(db, 'connect', (async () => client) as unknown as typeof db.connect);
      t.mock.method(Date, 'now', () => { now += 4000; return now; });
      t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit = {}) => {
        if (String(url).endsWith('/key')) return Response.json({ data: {
          free_model_daily_requests: { remaining: scenario.quota, limit: 50, used: 50 - scenario.quota }
        } });
        const body = JSON.parse(String(init.body));
        const products = JSON.parse(body.messages[1].content) as { asin: string; name: string }[];
        assert.deepEqual(body.reasoning, { enabled: false });
        sizes.push(products.length);
        if (products.length > scenario.threshold) return Response.json({ choices: [{
          finish_reason: 'length', message: { content: '{"translations":[' }
        }] });
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          translations: products.map(p => ({ asin: p.asin,
            name: Number(p.asin.slice(1)) < scenario.invalidCount ? 'Vitamin 500g' : p.name }))
        }) } }] });
      });
      const previousKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-only';
      try {
        assert.deepEqual(await translatePendingNames({ log: async () => {} }), { translated: scenario.translated,
          failed: scenario.failed, skipped: 0, paused: scenario.paused });
        assert.deepEqual(sizes, scenario.sizes);
        assert.equal(saved.length, scenario.translated);
        assert.equal(new Set(saved).size, saved.length);
        assert.equal(failed.length, scenario.failed);
        assert.ok(failed.every(asin => !saved.includes(asin)));

        assert.equal(JSON.stringify(rows), snapshot);
        assert.ok(released && unlocked);
      } finally {
        if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = previousKey;
      }
    });
  }
});
