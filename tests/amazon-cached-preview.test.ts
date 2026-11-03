import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amazonInputAsin, lookupLocalAmazonPreview, publicCatalogPreview } from '../src/lib/amazon-cached-preview.js';
import { AmazonQuoteApiError, createAmazonQuote } from '../src/lib/amazon-quotes.js';

const asin = 'B08FTSH6KP';
const sourceUrl = `https://www.amazon.co.jp/dp/${asin}`;
const savedProduct = { asin, sourceUrl, name: 'Morinaga Chilmil 800g', lastUpdatedAt: '2026-10-29T19:00:27.265Z', priceJpy: 1745, availability: 'in_stock' };

test('Amazon input normalizes valid ASIN and HTTPS Amazon product paths only', () => {
  for (const value of [asin, asin.toLowerCase(), sourceUrl, `https://amazon.co.jp/gp/product/${asin.toLowerCase()}?tag=xyz`,
    `https://www.amazon.co.jp/store/dp/${asin}/ref=abc`]) {
    assert.equal(amazonInputAsin(value), asin, value);
  }
  for (const value of ['', 'B08FTSH6K', 'B08FTSH6KPX', `http://www.amazon.co.jp/dp/${asin}`,
    `https://amazon.co.jp.evil.com/dp/${asin}`, `https://user@amazon.co.jp/dp/${asin}`,
    `https://amazon.co.jp:444/dp/${asin}`, `https://amazon.com/dp/${asin}`,
    `https://amazon.co.jp/dp/${asin}X`, `https://amazon.co.jp/gp/product/XYZ`, 'x'.repeat(2049)]) {
    assert.equal(amazonInputAsin(value), null, value);
  }
});

test('cached projection requires exact identity and never exposes price, stock or checkout', () => {
  assert.deepEqual(publicCatalogPreview(savedProduct, asin), {
    asin, sourceUrl, title: 'Morinaga Chilmil 800g', updatedAt: savedProduct.lastUpdatedAt
  });
  for (const bad of [
    { ...savedProduct, asin: 'B000000001' },
    { ...savedProduct, sourceUrl: 'https://example.com/item' },
    { ...savedProduct, name: ' ' }, { ...savedProduct, name: 'z'.repeat(1001) }, null
  ]) assert.equal(publicCatalogPreview(bad, asin), null);
});

test('cached lookup obtains title when saved and returns canonical link for invalid catalog responses', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `/api/catalog/products/${asin}`);
      assert.equal(init?.cache, 'no-store');
      return Response.json(savedProduct);
    };
    assert.deepEqual(await lookupLocalAmazonPreview(asin.toLowerCase()), publicCatalogPreview(savedProduct, asin));

    for (const response of [new Response(null, { status: 404 }), new Response('not-json'),
      Response.json({ ...savedProduct, asin: 'B000000001' }),
      Response.json({ ...savedProduct, sourceUrl: 'https://example.com/other' })]) {
      globalThis.fetch = async () => response;
      assert.deepEqual(await lookupLocalAmazonPreview(sourceUrl), { asin, sourceUrl });
    }
    assert.equal(await lookupLocalAmazonPreview('not an Amazon product'), null);
  } finally { globalThis.fetch = original; }
});

test('catalog timeout bounds hung response.json and aborts fetch signal', async () => {
  const original = globalThis.fetch;
  let signal: AbortSignal | undefined;
  try {
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal ?? undefined;
      return { ok: true, json: () => new Promise<never>(() => {}) } as unknown as Response;
    };
    const started = Date.now();
    assert.deepEqual(await lookupLocalAmazonPreview(asin), { asin, sourceUrl });
    assert.ok(Date.now() - started >= 3900 && Date.now() - started < 7000);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('transport failure and non-JSON gateway errors are typed for cache fallback', async () => {
  const original = globalThis.fetch;
  try {
    for (const mock of [
      async () => { throw new Error('network disconnected'); },
      async () => new Response('<html>upstream error</html>', { status: 502 }),
      async () => new Response('timeout', { status: 504 })
    ]) {
      globalThis.fetch = mock;
      await assert.rejects(createAmazonQuote(asin, 1), (error: unknown) =>
        error instanceof AmazonQuoteApiError && error.code === 'quote_service_unavailable');
      // The UI uses the typed failure to call the same safe local catalog lookup.
      globalThis.fetch = async () => Response.json(savedProduct);
      assert.equal((await lookupLocalAmazonPreview(asin))?.title, savedProduct.name);
    }
    globalThis.fetch = async () => Response.json({ code: 'invalid_amazon_input', error: 'Invalid input' }, { status: 400 });
    await assert.rejects(createAmazonQuote(asin, 1), (error: unknown) =>
      error instanceof AmazonQuoteApiError && error.code === 'invalid_amazon_input');
  } finally { globalThis.fetch = original; }
});
