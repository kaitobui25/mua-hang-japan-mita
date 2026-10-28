import { fetchPageWithRetry } from '../src/ingestion/source.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDetail } from '../src/ingestion/detail.js';
import { jsonProperty, uniqueImages } from '../src/ingestion/enrichment.js';
import { collectEnrichedDetail } from '../src/ingestion/sync.js';
import { SourceError } from '../src/ingestion/source.js';

const html = await readFile(new URL('./fixtures/amazon-detail.html', import.meta.url), 'utf8');
const category = 'thuc-pham-bo-sung';
const asin = 'B000000001';

test('Amazon fixture yields five real high resolution URLs for the selected ASIN only', () => {
  const item = parseDetail(html, asin, category);
  assert.deepEqual(item.imageUrls, [
    'https://m.media-amazon.com/images/I/cover._SL1500_.jpg',
    'https://m.media-amazon.com/images/I/back._SL1200_.jpg',
    'https://m.media-amazon.com/images/I/side.jpg',
    'https://m.media-amazon.com/images/I/nutrition._SL1500_.jpg',
    'https://m.media-amazon.com/images/I/scoop.jpg'
  ]);
  assert.equal(item.imageUrl, item.imageUrls![0]);
  assert.equal(item.priceJpy, 2980);
  assert.equal(item.availability, 'in_stock');
  assert.equal(item.name, 'Source Brand Whey 1kg Vanilla');
});

test('structured source sections and ASIN specific variant values retain source evidence', () => {
  const item = parseDetail(html, asin, category);
  assert.deepEqual(item.detail?.features, ['Protein 24 g per serving', 'Made in Japan']);
  assert.deepEqual(item.detail?.ingredients, ['乳清たんぱく、バニラ香料']);
  assert.deepEqual(item.detail?.usage, ['水200mlに溶かす']);
  assert.deepEqual(item.detail?.cautions, ['乳成分を含む']);
  assert.deepEqual(item.detail?.specs, { '内容量': '1 kg', 'ブランド': 'Source Brand' });
  assert.equal(item.detail?.variantAttributes.Size, '1 kg');
  assert.equal(item.detail?.variantAttributes.Flavor, 'Vanilla');
  assert.deepEqual(item.detail?.childAsins, ['B000000002']);
  assert.equal(item.parentAsin, 'B000000099');
  assert.equal(item.detail?.provenance.sourceUrl, item.sourceUrl);
  assert.equal(item.detail?.sourceObservedAt, item.observedAt);
});

test('missing sections and parent identifiers stay empty, similar product names never group', () => {
  const minimal = `<input id="ASIN" value="${asin}"><span id="productTitle">Source Brand Whey Vanilla</span><img id="landingImage" src="https://m.media-amazon.com/images/I/cover.jpg">`;
  const item = parseDetail(minimal, asin, category);
  assert.equal(item.priceJpy, null);
  assert.equal(item.parentAsin, undefined);
  assert.deepEqual(item.detail?.features, []);
  assert.deepEqual(item.detail?.specs, {});
  assert.deepEqual(item.detail?.variantAttributes, {});
  assert.deepEqual(item.detail?.childAsins, []);
  assert.throws(() => parseDetail(minimal, 'B000000002', category));
});

test('image normalization deduplicates observed URLs without manufacturing high resolution paths', () => {
  assert.deepEqual(uniqueImages([
    'https://m.media-amazon.com/images/I/test._SX300_.jpg',
    'https://m.media-amazon.com/images/I/test._SL1500_.jpg',
    'https://m.media-amazon.com.evil.test/a.jpg',
    'https://user@m.media-amazon.com/a.jpg', 'http://m.media-amazon.com/a.jpg', 'data:image/png,x'
  ]), ['https://m.media-amazon.com/images/I/test._SL1500_.jpg']);
});

test('script JSON extraction is bounded to actual data and never evaluates JavaScript', () => {
  assert.deepEqual(jsonProperty(`{'initial':[{"caption":"brace } and escaped \\" quote"}],'other':[]}`, 'initial'), [{ caption: 'brace } and escaped " quote' }]);
  assert.equal(jsonProperty(`{'initial': evil()}`, 'initial'), undefined);
  assert.equal(jsonProperty(`{'initial': [{broken}]}`, 'initial'), undefined);
});

test('detail collection never falls back to browser on parse or access failures', async () => {
  let neoCalls = 0;
  const fallback = async () => { neoCalls++; return parseDetail(html, asin, category); };
  for (const state of ['blocked', 'rate_limited', 'temporary'] as const) {
    await assert.rejects(collectEnrichedDetail(asin, category, async () => { throw new SourceError(state, state); }, fallback));
  }
  assert.equal(neoCalls, 0);
  await assert.rejects(collectEnrichedDetail(asin, category, async () => { throw new SourceError('parse_error', 'markup changed'); }, fallback));
  assert.equal(neoCalls, 0);
  assert.throws(() => parseDetail('captcha' + html, asin, category), (e: unknown) => e instanceof SourceError && e.state === 'blocked');
});

test('unrelated variation scripts and unresolved numeric indices never create child evidence or attribute values', () => {
  const minimal = `<input id="ASIN" value="${asin}"><span id="productTitle">Source Brand Whey Vanilla</span><img id="landingImage" src="https://m.media-amazon.com/images/I/cover.jpg">`;
  const item = parseDetail(minimal + `<script>{"parentAsin":"B999999999","asinVariationValues":{"B999999998":{"size_name":"0"}}}</script><script>{"asinVariationValues":{"${asin}":{"size_name":"0"}}}</script>`, asin, category);
  assert.equal(item.parentAsin, undefined);
  assert.deepEqual(item.detail?.childAsins, []);
  assert.deepEqual(item.detail?.variantAttributes, {});
});

test('source dimension display arrays map only to explicit dimensions for this ASIN', () => {
  const minimal = `<input id="ASIN" value="${asin}"><span id="productTitle">Source Brand Whey Vanilla</span><img id="landingImage" src="https://m.media-amazon.com/images/I/cover.jpg">`;
  const item = parseDetail(minimal + `<script>{"parentAsin":"B000000099","dimensions":["size_name","flavor_name"],"dimensionValuesDisplayData":{"${asin}":["1 kg","Vanilla"],"B000000002":["2 kg","Chocolate"]}}</script>`, asin, category);
  assert.equal(item.parentAsin, 'B000000099');
  assert.deepEqual(item.detail?.variantAttributes, { size_name: '1 kg', flavor_name: 'Vanilla' });
  assert.deepEqual(item.detail?.childAsins, ['B000000002']);
});

test('real HTTP 403/429 and late CAPTCHA responses stop immediately without invoking Neo', async () => {
  const original = globalThis.fetch;
  let calls = 0, neoCalls = 0;
  try {
    for (const status of [403, 429, 200]) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(' '.repeat(12000) + 'captcha', { status }); };
      await assert.rejects(collectEnrichedDetail(asin, category, async () => parseDetail(await fetchPageWithRetry(`https://www.amazon.co.jp/dp/${asin}`), asin, category), async () => {
        neoCalls++; return parseDetail(html, asin, category);
      }), (e: unknown) => e instanceof SourceError && e.state === (status === 429 ? 'rate_limited' : 'blocked'));
      assert.equal(calls, 1);
    }
    assert.equal(neoCalls, 0);
  } finally { globalThis.fetch = original; }
});
