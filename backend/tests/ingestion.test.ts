import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverHttp, parseListing, SourceError } from '../src/ingestion/source.js';
import { collectCategory } from '../src/ingestion/sync.js';
import { parseNeoOutcome } from '../src/ingestion/neo.js';

const asinA = 'B000000001';
const asinB = 'B000000002';
const seed = { categorySlug: 'thuc-pham-cho-be', url: 'https://www.amazon.co.jp/s?k=test' };
const card = (asin: string, price = '') => `<div data-component-type="s-search-result" data-asin="${asin}"><h2>Example Japanese product ${asin}</h2><img alt="Japanese product" src="https://example.com/${asin}.jpg"/><span class="a-price"><span class="a-offscreen">${price}</span></span></div>`;
const obs = (asin: string, priceJpy: number | null, adapter = 'http') => ({ asin, name: `Product ${asin}`, categorySlug: seed.categorySlug, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, observedAt: '2026-10-27T00:00:00Z', priceJpy, sourceAdapter: adapter });

test('temporary HTTP failures are retried with bounded backoff', async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await discoverHttp(seed.categorySlug, seed.url, {
    maxPages: 1,
    fetchPage: async () => { calls++; if (calls < 3) throw new SourceError('temporary', 'HTTP 503'); return card(asinA, '¥1,280'); },
    delay: async milliseconds => { delays.push(milliseconds); }
  });
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
  assert.equal(result.observations[0]?.priceJpy, 1280);
  assert.deepEqual(result.issues, []);
});

test('access denied is not retried and never automatically bypassed', async () => {
  let calls = 0;
  await assert.rejects(discoverHttp(seed.categorySlug, seed.url, {
    maxPages: 1,
    fetchPage: async () => { calls++; throw new SourceError('blocked', 'Amazon HTTP 403'); },
    delay: async () => {}
  }), (error: unknown) => error instanceof SourceError && error.state === 'blocked');
  assert.equal(calls, 1);
});

test('page two failure keeps page one products but explicitly marks partial', async () => {
  const result = await discoverHttp(seed.categorySlug, seed.url, {
    maxPages: 2,
    fetchPage: async url => url.includes('page=2') ? Promise.reject(new SourceError('temporary', 'HTTP 503')) : card(asinA, '¥500'),
    delay: async () => {}
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].state, 'temporary');
  assert.equal(result.issues[0].page, 2);
});

test('valid ASIN with missing price triggers fallback and does not lose HTTP catalog', async () => {
  let called = 0;
  const result = await collectCategory(seed, async () => ({ observations: [obs(asinA, null), obs(asinB, 300)], issues: [] }), async () => {
    called++;
    return [obs(asinA, 450, 'browseros-neo')];
  });
  assert.equal(called, 1);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations.find(x => x.asin === asinA)?.priceJpy, 450);
  assert.deepEqual(result.issues, []);
});

test('Neo unavailability preserves HTTP data and requires human attention', async () => {
  const result = await collectCategory(seed, async () => ({ observations: [obs(asinA, null)], issues: [] }), async () => {
    throw new SourceError('needs_human', 'BrowserOS Neo offline', 'browseros-neo');
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.issues[0]?.state, 'needs_human');
  assert.equal(result.issues[0]?.adapter, 'browseros-neo');
});

test('Neo reports human verification instead of treating CAPTCHA as parsing error', () => {
  assert.throws(() => parseNeoOutcome({ blocked: true, items: [] }, seed.categorySlug), (error: unknown) => error instanceof SourceError && error.state === 'blocked' && error.adapter === 'browseros-neo');
});

test('a late Amazon block retains the first page and flags human review without bypass', async () => {
  const result = await discoverHttp(seed.categorySlug, seed.url, {
    maxPages: 2,
    fetchPage: async url => url.includes('page=2') ? Promise.reject(new SourceError('blocked', 'HTTP 403')) : card(asinA, '¥500'),
    delay: async () => {}
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.issues[0].state, 'blocked');
  assert.equal(result.issues[0].page, 2);
});

test('HTTP access denial on a later page prevents Neo fallback even when saved ASINs lack prices', async () => {
  let neoCalls = 0;
  const result = await collectCategory(seed, async () => ({
    observations: [obs(asinA, null)],
    issues: [{ state: 'blocked', adapter: 'http', page: 2, message: 'Amazon HTTP 403' }]
  }), async () => {
    neoCalls++;
    return [obs(asinA, 900, 'browseros-neo')];
  });
  assert.equal(neoCalls, 0);
  assert.equal(result.observations[0]?.priceJpy, null);
  assert.equal(result.issues[0]?.state, 'blocked');
});

test('HTTP parses source-supplied family ID but never guesses it from similar names', () => {
  const html = card(asinA, '¥500').replace(`data-asin="${asinA}"`, `data-asin="${asinA}" data-parent-asin="B0ABCDEF12"`) + card(asinB, '¥600');
  const products = parseListing(html, seed.categorySlug);
  assert.equal(products[0].parentAsin, 'B0ABCDEF12');
  assert.equal(products[1].parentAsin, null);
});

test('bounded listing discovery retains overflow ASINs for the detail backlog instead of silently dropping them', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => `D${String(i).padStart(9, '0')}`);
  const result = await discoverHttp(seed.categorySlug, seed.url, {
    maxPages: 1, fetchPage: async () => ids.map(id => card(id)).join(''), delay: async () => {}
  });
  assert.equal(result.observations.length, 205);
  assert.equal(new Set(result.observations.map(item => item.asin)).size, 205);
});
