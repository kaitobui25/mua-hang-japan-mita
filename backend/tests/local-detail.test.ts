import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { localEndpoint, LocalTranslationError, translateLocalString, validateAtomicTranslation } from '../src/translation/local.js';
import { detailItems, renderDetail, type DetailText, type DetailItem } from '../src/translation/detail-text.js';
import { translatePendingDetails } from '../src/translation/detail-jobs.js';
import { shouldRunDetailTranslation, detailTranslationCron, detailTranslationTimezone, parseDetailCommand } from '../src/translation/detail-schedule.js';
import { applyTranslations } from '../src/translation/catalog.js';

const snapshot: DetailText = {
  features: ['成分 300mg', '特長'], ingredients: ['原材料'], usage: ['使用方法'], cautions: ['注意'],
  specs: { '容量': ' ３０錠\r\n日本語 300mg ', '原産国': '日本', Brand: 'DHC' }
};
const output: Record<string, string> = { '成分 300mg': 'Thành phần 300mg', '特長': 'Đặc điểm', '原材料': 'Nguyên liệu',
  '使用方法': 'Cách dùng', '注意': 'Chú ý', '容量': 'Dung lượng', '原産国': 'Xuất xứ' };

// SQL boundary fake: no connection to PostgreSQL or model is made by this suite.
function fixture() {
  let frozen: DetailText | undefined;
  let source = structuredClone(snapshot);
  let legacyFull = false, lock = true, released = 0;
  const items = new Map<string, DetailItem>();
  const sql: string[] = [];
  const query = async (statement: string, values: unknown[] = []) => {
    sql.push(statement);
    if (statement.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lock }] };
    if (statement.includes('SELECT p.asin')) {
      assert.match(statement, /NOT t.name_only AND t.detail IS NOT NULL/);
      assert.doesNotMatch(statement, /source_hash/);
      assert.equal(values[0], 3);
      const pending = [...items.values()].some(i => !i.translated && !i.retry_after);
      return { rows: legacyFull || (frozen && !pending) ? [] : [{ asin: 'A000000001', snapshot: frozen ?? structuredClone(source) }] };
    }
    if (statement.includes('INSERT INTO local_detail_translations')) frozen ??= JSON.parse(String(values[1]));
    if (statement.includes('INSERT INTO local_detail_translation_items') && !items.has(String(values[1]))) {
      items.set(String(values[1]), { slot: String(values[1]), source: String(values[2]), translated: null });
    }
    if (statement.includes('SELECT slot,source,translated')) return { rows: [...items.values()].filter(i => i.translated === null && !i.retry_after) };
    if (statement.includes('UPDATE local_detail_translation_items')) {
      const item = items.get(String(values[1]))!;
      if (statement.includes('translated=$3')) { item.translated = String(values[2]); item.retry_after = null; }
      else item.retry_after = new Date(Date.now() + 43200000);
    }
    assert.doesNotMatch(statement, /(?:INSERT INTO|UPDATE) product_translations/);
    return { rows: [] };
  };
  const connect = async () => ({ query, release: () => { released++; } }) as unknown as Pick<PoolClient, 'query' | 'release'>;
  return { connect, items, sql, get frozen() { return frozen; }, get released() { return released; },
    changeSource: () => { source.features = ['変更']; source.specs = { '変更': 'new' }; },
    legacy: () => { legacyFull = true; }, denyLock: () => { lock = false; } };
}
const translate = async (source: string) => ({ text: output[source], model: 'fixture' });

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

test('facts, unprocessed Japanese, empty, JSON and reasoning output are rejected', () => {
  for (const value of ['Thành phần 300g', 'Thành phần 400mg', '成分 300mg', '', '{"text":"300mg"}', '<think>300mg']) {
    assert.throws(() => validateAtomicTranslation('成分 300mg', value), LocalTranslationError);
  }
  assert.throws(() => validateAtomicTranslation('品 AB-1234 20ml', 'Sản phẩm XY-1234 20ml'));
  assert.equal(validateAtomicTranslation('成分 300mg', ' Thành phần 300mg '), 'Thành phần 300mg');
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
  assert.deepEqual(items.map(i => i.source), ['成分 300mg', '特長', '原材料', '使用方法', '注意', '容量', '原産国']);
  const rendered = renderDetail(snapshot, items.map(i => ({ ...i, translated: output[i.source] })));
  assert.equal(rendered.specs['Dung lượng'], snapshot.specs['容量']);
  assert.equal(rendered.specs['Xuất xứ'], '日本');
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
  const first = await translatePendingDetails({ limit: 3, connect: f.connect, translate: async source => {
    calls.push(source);
    if (source === '特長') {
      assert.equal(f.items.get('features:0')?.translated, 'Thành phần 300mg', 'first atomic success already saved');
      throw new LocalTranslationError(false, 'invalid_output');
    }
    return translate(source);
  } });
  assert.equal(first.translated, 6);
  assert.equal(first.failed, 1);
  const partial = renderDetail(f.frozen!, [...f.items.values()]);
  assert.deepEqual(partial.features, ['Thành phần 300mg', '特長']);
  assert.deepEqual(partial.usage, ['Cách dùng']);
  f.changeSource();
  calls = [];
  await translatePendingDetails({ limit: 3, connect: f.connect, translate: async source => { calls.push(source); return translate(source); } });
  assert.deepEqual(calls, [], 'failed item waits for retry');
  f.items.get('features:1')!.retry_after = null;
  await translatePendingDetails({ limit: 3, connect: f.connect, translate: async source => { calls.push(source); return translate(source); } });
  assert.deepEqual(calls, ['特長']);
  assert.deepEqual(f.frozen?.features, snapshot.features);
  calls = [];
  await translatePendingDetails({ limit: 3, connect: f.connect, translate: async source => { calls.push(source); return translate(source); } });
  assert.deepEqual(calls, [], 'completed strings never retranslate after source changes');
  assert.equal(f.released, 4);
});

test('legacy successful full detail is excluded forever, regardless of source hash', async () => {
  const f = fixture(); f.legacy();
  await translatePendingDetails({ limit: 3, connect: f.connect, translate: async () => { assert.fail('legacy detail translated'); } });
  assert.equal(f.items.size, 0);
});

test('outages preserve earlier successes and pause; contention does not unlock another worker', async () => {
  const f = fixture();
  const result = await translatePendingDetails({ limit: 3, connect: f.connect, translate: async source => {
    if (source === '特長') throw new LocalTranslationError(true, 'offline');
    return translate(source);
  } });
  assert.equal(result.paused, true);
  assert.equal(f.items.get('features:0')?.translated, 'Thành phần 300mg');
  assert.ok(f.sql.at(-1)?.includes('pg_advisory_unlock'));
  const other = fixture(); other.denyLock();
  assert.equal((await translatePendingDetails({ limit: 3, connect: other.connect })).paused, true);
  assert.equal(other.sql.length, 1);
  assert.equal(other.released, 1);
});

test('cancellation makes no inference and releases lock; invalid limits never connect', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await translatePendingDetails({ limit: 3, connect: f.connect, signal: controller.signal })).paused, true);
  assert.equal(f.items.size, 0);
  assert.equal(f.released, 1);
  await assert.rejects(translatePendingDetails({ limit: 0, connect: async () => { assert.fail('invalid limit connected'); } }));
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
  await assert.rejects(translatePendingDetails({ limit: 3, connect: async () => client,
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
