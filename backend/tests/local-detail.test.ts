import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { hasEnglish, localEndpoint, LocalTranslationError, translateLocalString, validateAtomicTranslation } from '../src/translation/local.js';
import { detailItems, needsDetailTranslation, renderDetail, type DetailText, type DetailItem } from '../src/translation/detail-text.js';
import { backfillFrozenEnglishSlots, translatePendingDetails } from '../src/translation/detail-jobs.js';
import { shouldRunDetailTranslation, detailTranslationCron, detailTranslationTimezone, parseDetailCommand } from '../src/translation/detail-schedule.js';
import { applyTranslations } from '../src/translation/catalog.js';

const snapshot: DetailText = {
  features: ['成分 300mg', '特長'], ingredients: ['原材料'], usage: ['使用方法'], cautions: ['注意'],
  specs: { '容量': ' ３０錠\r\n日本語 300mg ', '原産国': '日本', Brand: 'DHC' }
};
const output: Record<string, string> = { '成分 300mg': 'Thành phần 300mg', '特長': 'Đặc điểm', '原材料': 'Nguyên liệu',
  '使用方法': 'Cách dùng', '注意': 'Chú ý', '容量': 'Dung lượng', '原産国': 'Xuất xứ', Brand: 'Thương hiệu' };

// SQL boundary fake: no connection to PostgreSQL or model is made by this suite.
function fixture(input: DetailText = snapshot) {
  let frozen: DetailText | undefined;
  let source = structuredClone(input);
  let legacyFull = false, lock = true, released = 0, semantics = false;
  const items = new Map<string, DetailItem & {attempts?: number; warning?: boolean}>();
  const sql: string[] = [];
  const query = async (statement: string, values: unknown[] = []) => {
    sql.push(statement);
    if (statement.includes('FROM translation_settings')) return { rows: [{ validate_translation_semantics: semantics, version: 1 }] };
    if (statement.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lock }] };
    if (statement.includes('SELECT p.asin')) {
      assert.match(statement, /NOT t.name_only AND t.detail IS NOT NULL/);
      assert.doesNotMatch(statement, /source_hash/);
      assert.equal(values[0], 3);
      const pending = [...items.values()].some(i => (!i.translated || i.warning) && (i.attempts ?? 0)<3 && !i.retry_after);
      return { rows: legacyFull || (frozen && !pending) ? [] : [{ asin: 'A000000001', brand: 'DHC', snapshot: frozen ?? structuredClone(source) }] };
    }
    if (statement.includes('INSERT INTO local_detail_translations')) frozen ??= JSON.parse(String(values[1]));
    if (statement.includes('INSERT INTO local_detail_translation_items') && !items.has(String(values[1]))) {
      items.set(String(values[1]), { slot: String(values[1]), source: String(values[2]), translated: null });
    }
    if (statement.includes('SELECT slot,source,translated')) return { rows: [...items.values()].filter(i => (i.translated === null || i.warning) && (i.attempts ?? 0)<3 && !i.retry_after) };
    if (statement.includes('UPDATE local_detail_translation_items')) {
      const item = items.get(String(values[1]))!;
      if (statement.includes('RETURNING attempts')) { item.attempts = (item.attempts ?? 0)+1; return { rows: [{ attempts: item.attempts }] }; }
      if (statement.includes('translated=$3')) { item.translated = String(values[2]); item.warning = Boolean(values[4]); item.retry_after = item.warning ? new Date() : null; }
      else item.retry_after = new Date(Date.now() + 43200000);
    }
    assert.doesNotMatch(statement, /(?:INSERT INTO|UPDATE) product_translations/);
    return { rows: [] };
  };
  const connect = async () => ({ query, release: () => { released++; } }) as unknown as Pick<PoolClient, 'query' | 'release'>;
  return { connect, items, sql, get frozen() { return frozen; }, get released() { return released; },
    setSemantics: (value: boolean) => { semantics = value; },
    changeSource: () => { source.features = ['変更']; source.specs = { '変更': 'new' }; },
    legacy: () => { legacyFull = true; }, denyLock: () => { lock = false; } };
}
const translate = async (source: string) => ({ text: output[source], model: 'fixture' });

// Durable checkpoint/transaction fake: exercises the backfill SQL boundary without
// touching PostgreSQL or calling a translation model.
function frozenBackfillFixture() {
  type Frozen = { snapshot: DetailText; approved?: boolean; marked?: boolean };
  type Saved = { source: string; translated: string | null; attempts: number; warning: boolean };
  const snapshots = new Map<string, Frozen>([
    ['A000000001', { snapshot: {
      features: ['成分 300mg', 'High protein 20g', 'SAVAS'], ingredients: [],
      usage: ['Take 2 tablets'], cautions: [],
      specs: { '容量': ' ３０錠\r\n日本語 300mg ', 'Net Weight': ' raw 980g ', Brand: 'DHC' }
    } }],
    ['A000000002', { snapshot: {
      features: ['High protein 20g'], ingredients: [], usage: [], cautions: [], specs: { Brand: 'DHC' }
    }, approved: true }],
    ['A000000003', { snapshot: {
      features: ['SAVAS', 'AB-1234'], ingredients: [], usage: [], cautions: [], specs: { 'AB-1234': ' untouched ' }
    } }]
  ]);
  const items = new Map<string, Saved>([
    ['A000000001:features:0', { source: '成分 300mg', translated: 'Thành phần 300mg', attempts: 1, warning: false }],
    ['A000000001:features:1', { source: 'High protein 20g', translated: 'Đạm cao 20g', attempts: 1, warning: false }],
    ['A000000001:specs:2', { source: 'Brand', translated: 'Bad warning', attempts: 3, warning: true }]
  ]);
  const before = structuredClone([...items]);
  const sourceBefore = structuredClone([...snapshots].map(([asin, data]) => [asin, data.snapshot]));
  let transaction: { items: Map<string, Saved>; marked: Map<string, boolean | undefined> } | undefined;
  let failOnSlot: string | undefined;
  const selected: string[][] = [];
  let commits = 0, rollbacks = 0;
  const client = { query: async (statement: string, values: unknown[] = []) => {
    if (statement === 'BEGIN') {
      assert.equal(transaction, undefined);
      transaction = { items: structuredClone(items), marked: new Map([...snapshots].map(([asin, s]) => [asin, s.marked])) };
      return { rows: [] };
    }
    if (statement === 'COMMIT') { commits++; transaction = undefined; return { rows: [] }; }
    if (statement === 'ROLLBACK') {
      assert.ok(transaction);
      rollbacks++;
      items.clear();
      for (const [key, item] of transaction.items) items.set(key, item);
      for (const [asin, marked] of transaction.marked) snapshots.get(asin)!.marked = marked;
      transaction = undefined;
      return { rows: [] };
    }
    if (statement.includes('SELECT asin FROM local_detail_translations')) {
      assert.match(statement, /english_slots_backfilled_at IS NULL/);
      assert.match(statement, /ORDER BY asin LIMIT \$1/);
      const rows = [...snapshots].filter(([, s]) => !s.marked).map(([asin]) => ({ asin })).slice(0, Number(values[0]));
      selected.push(rows.map(r => r.asin));
      return { rows };
    }
    if (statement.includes('SELECT l.snapshot')) {
      assert.ok(transaction);
      assert.match(statement, /FOR UPDATE OF l/);
      const row = snapshots.get(String(values[0]));
      return { rows: row && !row.marked ? [{ snapshot: row.snapshot, full_approved: Boolean(row.approved) }] : [] };
    }
    if (statement.includes('INSERT INTO local_detail_translation_items')) {
      assert.ok(transaction);
      assert.match(statement, /ON CONFLICT\(asin,slot\) DO NOTHING/);
      assert.equal(values.length, 3, 'raw spec values must never enter the INSERT');
      if (values[1] === failOnSlot) { failOnSlot = undefined; throw Error('injected_insert_failure'); }
      const key = `${values[0]}:${values[1]}`;
      if (items.has(key)) return { rows: [], rowCount: 0 };
      items.set(key, { source: String(values[2]), translated: null, attempts: 0, warning: false });
      return { rows: [{ slot: values[1] }], rowCount: 1 };
    }
    if (statement.includes('UPDATE local_detail_translations')) {
      assert.ok(transaction);
      assert.match(statement, /english_slots_backfilled_at=now\(\)/);
      snapshots.get(String(values[0]))!.marked = true;
      return { rows: [], rowCount: 1 };
    }
    assert.fail(`Unexpected backfill SQL: ${statement}`);
  } };
  return { client: client as unknown as Pick<PoolClient, 'query'>, items, snapshots, selected, before, sourceBefore,
    get commits() { return commits; }, get rollbacks() { return rollbacks; },
    failOnceAt: (slot: string) => { failOnSlot = slot; } };
}

test('frozen English backfill is bounded, additive and permanently checkpoints scanned snapshots', async () => {
  const f = frozenBackfillFixture();
  assert.deepEqual(await backfillFrozenEnglishSlots(f.client, 2), { scanned: 2, inserted: 2, remaining: true });
  assert.deepEqual(f.selected[0], ['A000000001', 'A000000002', 'A000000003'],
    'lookahead checks for more work without modifying the third row');
  assert.deepEqual([...f.items].filter(([key]) => key.startsWith('A000000001:')).map(([key]) => key).sort(),
    ['A000000001:features:0', 'A000000001:features:1', 'A000000001:specs:1',
      'A000000001:specs:2', 'A000000001:usage:0']);
  assert.deepEqual([...f.items].filter(([key]) => f.before.some(([original]) => original === key)), f.before,
    'successful, warned and exhausted legacy slots are never rewritten');
  assert.equal(f.items.get('A000000001:usage:0')?.source, 'Take 2 tablets');
  assert.equal(f.items.get('A000000001:specs:1')?.source, 'Net Weight');
  assert.equal(f.items.get('A000000001:specs:0'), undefined, 'Japanese slot was not part of the English backfill');
  assert.deepEqual(await backfillFrozenEnglishSlots(f.client, 2), { scanned: 1, inserted: 0, remaining: false });
  assert.deepEqual(await backfillFrozenEnglishSlots(f.client, 2), { scanned: 0, inserted: 0, remaining: false });
  assert.deepEqual(f.selected, [['A000000001', 'A000000002', 'A000000003'], ['A000000003'], []]);
  assert.equal(f.commits, 3);
  assert.equal(f.rollbacks, 0);
  assert.equal(f.items.size, 5, 'approved full detail and non-English snapshots create no jobs');
  assert.deepEqual([...f.snapshots].map(([asin, row]) => [asin, row.snapshot]), f.sourceBefore);
});

test('backfill rolls back both inserts and checkpoint on failure, then safely resumes', async () => {
  const f = frozenBackfillFixture();
  f.failOnceAt('specs:1');
  await assert.rejects(backfillFrozenEnglishSlots(f.client, 1), /injected_insert_failure/);
  assert.equal(f.rollbacks, 1);
  assert.equal(f.snapshots.get('A000000001')?.marked, undefined);
  assert.deepEqual([...f.items], f.before, 'no partial writes or attempt resets survive rollback');
  assert.deepEqual(await backfillFrozenEnglishSlots(f.client, 1), { scanned: 1, inserted: 2, remaining: true });
  assert.equal(f.items.get('A000000001:specs:1')?.source, 'Net Weight');
  assert.equal(f.snapshots.get('A000000001')?.marked, true);
  await assert.rejects(backfillFrozenEnglishSlots(f.client, 0), /DETAIL_TRANSLATION_LIMIT/);
  await assert.rejects(backfillFrozenEnglishSlots(f.client, 1001), /DETAIL_TRANSLATION_LIMIT/);
});

test('only numeric loopback endpoints accepted, including no credentials or path overrides', () => {
  assert.equal(localEndpoint('http://[::1]:8080/v1/'), 'http://[::1]:8080/v1/chat/completions');
  for (const url of ['https://127.0.0.1/v1', 'http://example.com/v1', 'http://localhost/v1',
    'http://u:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?target=remote', 'http://127.0.0.1/other', 'http://127.0.0.1/v1#x']) assert.throws(() => localEndpoint(url));
});

test('atomic request uses Chinese prompt, plain output <=1800, no JSON, credentials or fallback', async () => {
  let calls = 0;
  const result = await translateLocalString('成分 300mg', { baseUrl: 'http://127.0.0.1:8080/v1', fetcher: async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 1800);
    assert.equal(body.response_format, undefined);
    assert.equal(body.messages[1].content, '成分 300mg');
    assert.match(body.messages[0].content, /越南语/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Thành phần 300mg' } }] });
  } });
  assert.equal(calls, 1);
  assert.equal(result.text, 'Thành phần 300mg');
});

test('English feature/ingredient/usage/caution prose and spec KEYS are selected; identity-only strings and raw values are excluded', () => {
  const english: DetailText = {
    features: ['High protein 20g', 'SAVAS', 'AB-1234'],
    ingredients: ['Ingredients: DHC Vitamin C 500mg'],
    usage: ['Take 2 tablets daily'], cautions: ['Keep away from children'],
    specs: { 'Net Weight': ' 980g\r\nraw data ', Brand: 'DHC', 'AB-1234': 'source', '原産国': '日本' }
  };
  const items = detailItems(english);
  assert.deepEqual(items.map(i => i.source), [
    'High protein 20g', 'Ingredients: DHC Vitamin C 500mg', 'Take 2 tablets daily',
    'Keep away from children', 'Net Weight', 'Brand', '原産国'
  ]);
  assert.equal(needsDetailTranslation('DHC'), false);
  assert.equal(hasEnglish('500mg AB-1234 SAVAS'), false);
  assert.equal(hasEnglish('ALLERGENS'), true);
  assert.equal(hasEnglish('NUTRITION FACTS'), true);
  assert.equal(hasEnglish('Thành phần nguyên liệu'), false);
  const translations = new Map([
    ['High protein 20g', 'Đạm cao 20g'], ['Ingredients: DHC Vitamin C 500mg', 'Thành phần: DHC Vitamin C 500mg'],
    ['Take 2 tablets daily', 'Uống 2 viên mỗi ngày'], ['Keep away from children', 'Tránh xa trẻ em'],
    ['Net Weight', 'Khối lượng tịnh'], ['Brand', 'Thương hiệu'], ['原産国', 'Xuất xứ']
  ]);
  const rendered = renderDetail(english, items.map(i => ({ ...i, translated: translations.get(i.source)! })));
  assert.equal(rendered.specs['Khối lượng tịnh'], english.specs['Net Weight']);
  assert.equal(rendered.specs['Thương hiệu'], 'DHC');
  assert.equal(rendered.specs['Xuất xứ'], '日本');
  assert.equal(rendered.specs['AB-1234'], 'source');
  assert.deepEqual(rendered.features, ['Đạm cao 20g', 'SAVAS', 'AB-1234']);
});

test('English atomic prompt requests Vietnamese and protects quantities, units, codes and brands', async () => {
  const source = 'Ingredients: DHC AB-1234 500mg, take 2 tablets daily';
  const translated = 'Thành phần: DHC AB-1234 500mg, uống 2 viên mỗi ngày';
  const result = await translateLocalString(source, { brand: 'DHC', fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /日语和英语到越南语/);
    assert.equal(body.messages[1].content, source);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: translated } }] });
  } });
  assert.equal(result.text, translated);
  assert.equal(validateAtomicTranslation('Take 2 tablets 500mg', 'Uống 2 viên 500mg'), 'Uống 2 viên 500mg');
  assert.equal(validateAtomicTranslation('KEEP AWAY FROM CHILDREN', 'TRÁNH XA TRẺ EM'), 'TRÁNH XA TRẺ EM');
  for (const bad of [
    'Thành phần: DHC AB-1234 500mg, uống 3 viên mỗi ngày',
    'Thành phần: DHC AB-1234 500g, uống 2 viên mỗi ngày',
    'Thành phần: DHC XY-1234 500mg, uống 2 viên mỗi ngày',
    'Thành phần: ABC AB-1234 500mg, uống 2 viên mỗi ngày',
    source
  ]) assert.throws(() => validateAtomicTranslation(source, bad, 'DHC'), LocalTranslationError);
  const warned = await translateLocalString(source, { brand: 'DHC',
    fetcher: async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: 'Thành phần: DHC AB-1234 500g, uống 2 viên mỗi ngày'
    } }] })
  });
  assert.match(warned.text, /500g/);
});

test('English detail copy is translated through frozen atomic jobs with no raw spec value inference', async () => {
  const english: DetailText = { features: ['High protein 20g'], ingredients: ['Ingredients'],
    usage: ['Take 2 tablets'], cautions: ['Keep away from children'],
    specs: { 'Net Weight': ' raw 980g ', Brand: 'DHC' } };
  const translations: Record<string, string> = {
    'High protein 20g': 'Đạm cao 20g', Ingredients: 'Thành phần', 'Take 2 tablets': 'Uống 2 viên',
    'Keep away from children': 'Tránh xa trẻ em', 'Net Weight': 'Khối lượng tịnh', Brand: 'Thương hiệu'
  };
  const f = fixture(english);
  const seen: string[] = [];
  const result = await translatePendingDetails({ limit: 3, connect: f.connect, log: async () => {},
    translate: async (source, options) => {
      assert.equal(options?.brand, 'DHC');
      seen.push(source);
      return { text: translations[source], model: 'mock' };
    } });
  assert.equal(result.translated, 6);
  assert.equal(result.failed, 0);
  assert.match(f.sql.find(sql => sql.includes('INSERT INTO local_detail_translations')) ?? '',
    /english_slots_backfilled_at\) VALUES\(\$1,\$2,now\(\)\)/,
    'new frozen snapshots are already initialized and cannot be rescanned later');
  assert.deepEqual(seen, detailItems(english).map(i => i.source));
  assert.ok(!seen.includes(english.specs['Net Weight']));
  const rendered = renderDetail(f.frozen!, [...f.items.values()]);
  assert.equal(rendered.specs['Khối lượng tịnh'], ' raw 980g ');
  assert.equal(rendered.specs['Thương hiệu'], 'DHC');
  assert.equal(rendered.usage[0], 'Uống 2 viên');
});

test('semantic English warnings are retained verbatim with validation OFF', async () => {
  const english: DetailText = { features: ['DHC Take 2 tablets AB-1234 500mg'],
    ingredients: [], usage: [], cautions: [], specs: {} };
  for (const invalid of [
    'DHC Uống 3 viên AB-1234 500mg', 'DHC Uống 2 viên AB-1234 500g',
    'DHC Uống 2 viên XY-1234 500mg', 'ABC Uống 2 viên AB-1234 500mg'
  ]) {
    const f = fixture(english);
    const result = await translatePendingDetails({ limit: 3, connect: f.connect, log: async () => {},
      translate: async () => ({ text: invalid, model: 'mock' }) });
    assert.equal(result.failed, 0);
    assert.equal(f.items.get('features:0')?.translated, invalid);
    assert.equal(f.items.get('features:0')?.warning, true);
    assert.equal(renderDetail(f.frozen!, [...f.items.values()]).features[0], invalid);
  }
});

test('facts, unprocessed Japanese, empty, JSON and reasoning output are rejected', () => {
  for (const value of ['Thành phần 300g', 'Thành phần 400mg', '成分 300mg', '', '{"text":"300mg"}', '<think>300mg']) {
    assert.throws(() => validateAtomicTranslation('成分 300mg', value), LocalTranslationError);
  }
  assert.throws(() => validateAtomicTranslation('品 AB-1234 20ml', 'Sản phẩm XY-1234 20ml'));
  assert.equal(validateAtomicTranslation('成分 300mg', ' Thành phần 300mg '), ' Thành phần 300mg ');
});

test('Vietnamese decimal commas and counted-one words pass without relaxing dosages or codes', () => {
  assert.equal(validateAtomicTranslation('1本(約4.5g) 1回分', 'Mỗi thanh (khoảng 4,5g), một liều'),
    'Mỗi thanh (khoảng 4,5g), một liều');
  assert.equal(validateAtomicTranslation('1本 20g', 'một thanh 20g'), 'một thanh 20g');
  assert.equal(validateAtomicTranslation('1本あたり18kcal', 'Mỗi thanh có 18kcal'), 'Mỗi thanh có 18kcal');
  assert.throws(() => validateAtomicTranslation('1本 20g', 'một thanh 21g'), /facts_changed/);
  assert.throws(() => validateAtomicTranslation('1本 18kcal', 'một thanh 18g'), /facts_changed/);
  assert.throws(() => validateAtomicTranslation('2本 20g', 'một thanh 20g'), /facts_changed/);
  assert.throws(() => validateAtomicTranslation('容量 1,000mg', 'Dung lượng 1.000mg'), /facts_changed/);
  assert.throws(() => validateAtomicTranslation('型番 AB-1234', 'Mã CD-1234'), /facts_changed/);
});

test('truncated replies, malformed payloads, oversized sources and HTTP failures do not publish', async () => {
  for (const payload of [{ choices: [{ finish_reason: 'length', message: { content: 'Đặc điểm' } }] }, {}, null]) {
    await assert.rejects(translateLocalString('特長', { fetcher: async () => Response.json(payload) }));
  }
  await assert.rejects(translateLocalString('特'.repeat(700), { fetcher: async () => { assert.fail('oversized source sent'); } }));
  const longSource = '特'.repeat(507); // 1521 UTF-8 bytes: valid live ingredient length.
  await translateLocalString(longSource, { fetcher: async () => Response.json({
    choices: [{ finish_reason: 'stop', message: { content: 'Nguyên liệu' } }]
  }) });
  await assert.rejects(translateLocalString('特長', { fetcher: async () => new Response('', { status: 503 }) }),
    (e: unknown) => e instanceof LocalTranslationError && e.retryable);
  await assert.rejects(translateLocalString('特長', { fetcher: async () => { throw Error('offline'); } }), LocalTranslationError);
});

test('spec VALUES and names never become atomic jobs; all other sections do', () => {
  const items = detailItems(snapshot);
  assert.deepEqual(items.map(i => i.source), ['成分 300mg', '特長', '原材料', '使用方法', '注意', '容量', '原産国', 'Brand']);
  const rendered = renderDetail(snapshot, items.map(i => ({ ...i, translated: output[i.source] })));
  assert.equal(rendered.specs['Dung lượng'], snapshot.specs['容量']);
  assert.equal(rendered.specs['Xuất xứ'], '日本');
  assert.equal(rendered.specs['Thương hiệu'], 'DHC');
  assert.equal(Buffer.from(rendered.specs['Dung lượng']).equals(Buffer.from(snapshot.specs['容量'])), true);
  assert.equal(rendered.features[0], 'Thành phần 300mg');
});

test('key collisions with siblings, original keys, generated suffixes and prototype keys lose no values', () => {
  const s = { ...snapshot, specs: { '容量': 'one', '原産国': 'two', '注意': 'three', Label: 'four', 'Label [容量]': 'five', '__proto__': 'ignored literal' } };
  Object.defineProperty(s.specs, '__proto__', { value: 'six', enumerable: true });
  const items = detailItems(s).map(i => ({ ...i, translated: i.slot.startsWith('specs:') ? 'Label' : output[i.source] }));
  const rendered = renderDetail(s, items);
  assert.equal(Object.keys(rendered.specs).length, Object.keys(s.specs).length);
  assert.deepEqual(Object.values(rendered.specs).sort(), Object.values(s.specs).sort());
  assert.equal(rendered.specs.Label, 'four');
  assert.equal(rendered.specs['Label [容量] (2)'], 'one');
  assert.equal(rendered.specs.__proto__, 'six');
});

test('partial success persists before failure; retries only failed strings against frozen source', async () => {
  const f = fixture();
  let calls: string[] = [];
  const first = await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, translate: async source => {
    calls.push(source);
    if (source === '特長') {
      assert.equal(f.items.get('features:0')?.translated, 'Thành phần 300mg', 'first atomic success already saved');
      throw new LocalTranslationError(false, 'invalid_output');
    }
    return translate(source);
  } });
  assert.equal(first.translated, 7);
  assert.equal(first.failed, 1);
  const partial = renderDetail(f.frozen!, [...f.items.values()]);
  assert.deepEqual(partial.features, ['Thành phần 300mg', '特長']);
  assert.deepEqual(partial.usage, ['Cách dùng']);
  f.changeSource();
  calls = [];
  await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, translate: async source => { calls.push(source); return translate(source); } });
  assert.deepEqual(calls, [], 'failed item waits for retry');
  f.items.get('features:1')!.retry_after = null;
  await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, translate: async source => { calls.push(source); return translate(source); } });
  assert.deepEqual(calls, ['特長']);
  assert.deepEqual(f.frozen?.features, snapshot.features);
  calls = [];
  await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, translate: async source => { calls.push(source); return translate(source); } });
  assert.deepEqual(calls, [], 'completed strings never retranslate after source changes');
  assert.equal(f.released, 4);
});

test('legacy successful full detail is excluded forever, regardless of source hash', async () => {
  const f = fixture(); f.legacy();
  await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, translate: async () => { assert.fail('legacy detail translated'); } });
  assert.equal(f.items.size, 0);
});

test('outages preserve earlier successes and pause; contention does not unlock another worker', async () => {
  const f = fixture();
  const result = await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, translate: async source => {
    if (source === '特長') throw new LocalTranslationError(true, 'offline');
    return translate(source);
  } });
  assert.equal(result.paused, true);
  assert.equal(f.items.get('features:0')?.translated, 'Thành phần 300mg');
  assert.ok(f.sql.at(-1)?.includes('pg_advisory_unlock'));
  const other = fixture(); other.denyLock();
  assert.equal((await translatePendingDetails({ log: async () => {}, limit: 3, connect: other.connect })).paused, true);
  assert.equal(other.sql.length, 1);
  assert.equal(other.released, 1);
});

test('cancellation makes no inference and releases lock; invalid limits never connect', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await translatePendingDetails({ log: async () => {}, limit: 3, connect: f.connect, signal: controller.signal })).paused, true);
  assert.equal(f.items.size, 0);
  assert.equal(f.released, 1);
  await assert.rejects(translatePendingDetails({ log: async () => {}, limit: 0, connect: async () => { assert.fail('invalid limit connected'); } }));
});

test('05:15 JST daily accepts only current window and process already running before due time', () => {
  const due = new Date('2026-10-28T20:15:00Z');
  assert.equal(detailTranslationCron, '15 5 * * *');
  assert.equal(detailTranslationTimezone, 'Asia/Tokyo');
  assert.equal(shouldRunDetailTranslation(due, new Date('2026-10-28T20:00:00Z'), new Date('2026-10-28T20:16:00Z')), true);
  assert.equal(shouldRunDetailTranslation(due, new Date('2026-10-28T20:15:01Z'), new Date('2026-10-28T20:16:00Z')), false);
  assert.equal(shouldRunDetailTranslation(new Date('2026-10-27T20:15:00Z'), due, due), false);
  assert.equal(shouldRunDetailTranslation(due, due, new Date('2026-10-28T20:21:00Z')), false);
  assert.equal(shouldRunDetailTranslation(new Date('2026-10-28T20:17:00Z'), due, new Date('2026-10-28T20:16:00Z')), false);
  assert.deepEqual(parseDetailCommand(['once', '--limit', '3']), { command: 'once', limit: 3 });
  for (const args of [['watch'], ['once', '--limit'], ['daily', '--limit', '3'], ['once', '--limit', '0'], ['once', '--limit', '3', 'extra']]) assert.throws(() => parseDetailCommand(args));
});

test('catalog displays atomic partial output without a translated name, despite changed Amazon source', async () => {
  const products = [{ asin: 'A000000001', name: 'Japanese name', brand: null,
    detail: { ...snapshot, features: ['Changed'], variantAttributes: {}, childAsins: [], sourceObservedAt: '2026-10-28T00:00:00Z', provenance: { sourceUrl: '', adapter: 'test', sections: [] } } }];
  let reads = 0;
  const client = { query: async () => ({ rows: ++reads === 1 ? [] : [{ asin: products[0].asin, snapshot, items: [
    { slot: 'features:0', source: snapshot.features[0], translated: 'Thành phần 300mg' }
  ] }] }) } as unknown as Pick<PoolClient, 'query'>;
  await applyTranslations(products, client);
  assert.equal(products[0].name, 'Japanese name');
  assert.deepEqual(products[0].detail.features, ['Thành phần 300mg', '特長']);
  assert.deepEqual({ ...products[0].detail.specs }, snapshot.specs);
});

test('catalog retains legacy full detail after source hash changes, including without a saved title', async () => {
  const products = [{ asin: 'A000000001', name: 'Source title', brand: null,
    detail: { ...snapshot, variantAttributes: {}, childAsins: [], sourceObservedAt: '', provenance: { sourceUrl: '', adapter: 'test', sections: [] } } }];
  let reads = 0;
  const client = { query: async () => ({ rows: ++reads === 1 ? [{ asin: products[0].asin, name: null,
    detail: { ...snapshot, features: ['Saved Vietnamese'] }, source_hash: 'old', name_only: false }] : [] }) } as unknown as Pick<PoolClient, 'query'>;
  await applyTranslations(products, client);
  assert.deepEqual(products[0].detail.features, ['Saved Vietnamese']);
  assert.equal(products[0].name, 'Source title');
});

test('initialization failure rolls back and releases the advisory lock without inference', async () => {
  const f = fixture(), client = await f.connect();
  const query = client.query.bind(client);
  client.query = (async (sql: string, values: unknown[] = []) => {
    if (sql.includes('INSERT INTO local_detail_translation_items')) throw Error('database unavailable');
    return query(sql, values);
  }) as typeof client.query;
  await assert.rejects(translatePendingDetails({ log: async () => {}, limit: 3, connect: async () => client,
    translate: async () => { assert.fail('inference before initialization committed'); } }), /database unavailable/);
  assert.ok(f.sql.includes('ROLLBACK'));
  assert.ok(f.sql.at(-1)?.includes('pg_advisory_unlock'));
  assert.equal(f.released, 1);
});

test('additive schema provides immutable snapshots and atomic item identity without name columns', async () => {
  const schema = await readFile('src/db/schema.sql', 'utf8');
  const local = schema.slice(schema.indexOf('-- Immutable source snapshots'), schema.indexOf('-- Also holds discovered'));
  assert.match(local, /CREATE TABLE IF NOT EXISTS local_detail_translations/);
  assert.match(local, /CREATE TABLE IF NOT EXISTS local_detail_translation_items/);
  assert.match(local, /PRIMARY KEY \(asin, slot\)/);
  assert.match(local, /ON DELETE CASCADE/);
  assert.doesNotMatch(local, /source_hash|name_only/);
});


test('ON rejects new semantic warnings and retains the existing warned detail at the three-attempt cap', async () => {
  const english: DetailText = { features: ['Take 2 tablets 500mg'], ingredients: [], usage: [], cautions: [], specs: {} };
  const f = fixture(english);
  const events: unknown[] = [];
  const run = (text: string) => translatePendingDetails({ limit: 3, connect: f.connect,
    log: async event => { events.push(event); }, translate: async () => ({ text, model: 'mock' }) });
  await run(' Uong 3 vien 500g ');
  f.setSemantics(true);
  for (let i = 0; i < 3; i++) {
    f.items.get('features:0')!.retry_after = null;
    await run('Uong 4 vien 600g');
  }
  assert.equal(f.items.get('features:0')!.translated, ' Uong 3 vien 500g ');
  assert.equal(f.items.get('features:0')!.attempts, 3);
  assert.ok(events.some(e => (e as { published?: boolean }).published === false));
  const fresh = fixture(english); fresh.setSemantics(true);
  const result = await translatePendingDetails({ limit: 3, connect: fresh.connect, log: async () => {},
    translate: async () => ({ text: 'Uong 3 vien 500g', model: 'mock' }) });
  assert.equal(result.failed, 1);
  assert.equal(fresh.items.get('features:0')!.translated, null);
});

test('HTML, script, encoded markup and malformed JSON are blocked by detail jobs with semantics OFF', async () => {
  for (const text of ['<b>dose</b>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '&lt;script&gt;', '{"text":', '<script']) {
    const f = fixture({ features: ['Take 2 tablets'], ingredients: [], usage: [], cautions: [], specs: {} });
    const result = await translatePendingDetails({ limit: 3, connect: f.connect, log: async () => {},
      translate: async () => ({ text, model: 'mock' }) });
    assert.equal(result.failed, 1, text);
    assert.equal(f.items.get('features:0')!.translated, null);
  }
});


test('historical structurally invalid atomic candidates fall back to the frozen source', () => {
  const items = detailItems(snapshot).map(item => ({ ...item, translated: '<script>alert(1)</script>' }));
  assert.deepEqual(renderDetail(snapshot, items).features, snapshot.features);
  assert.deepEqual({ ...renderDetail(snapshot, items).specs }, snapshot.specs);
});
