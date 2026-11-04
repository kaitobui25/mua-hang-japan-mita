import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AmazonQuoteApiError, createAmazonQuote } from '../src/lib/amazon-quotes.js';
import { AmazonSourceProductDetail } from '../src/components/amazon/amazon-product-detail.js';

const asin = 'B0FR4GT3R7';
const sourceUrl = `https://www.amazon.co.jp/dp/${asin}`;
const observedAt = '2026-11-04T03:29:33.299Z';

async function rejectedPreview(t: TestContext, preview: unknown) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    code: 'offer_not_verified', details: { preview },
  }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
  let result: AmazonQuoteApiError | undefined;
  await assert.rejects(createAmazonQuote(asin, 1), (error: unknown) => {
    assert.ok(error instanceof AmazonQuoteApiError);
    result = error;
    return true;
  });
  return result!.preview;
}

test('source preview accepts explicitly permissioned display for its own ASIN and observation', async t => {
  const result = await rejectedPreview(t, {
    asin, sourceUrl, observedAt, title: 'Verified source title',
    display: {
      provenance: { asin, sourceUrl, observedAt, permissionReference: 'synthetic-fixture-rights' },
      brand: 'Synthetic brand', images: ['https://m.media-amazon.com/images/I/sample.jpg'],
      rating: 4.5, reviewCount: 2,
    },
  });
  assert.equal(result?.display?.brand, 'Synthetic brand');
  assert.deepEqual(result?.display?.images, ['https://m.media-amazon.com/images/I/sample.jpg']);
  assert.equal(result?.display?.reviewCount, 2);
});

test('unmatched, stale or unsafe display data is not propagated into source preview', async t => {
  for (const provenance of [
    { asin: 'B000000001', sourceUrl, observedAt, permissionReference: 'synthetic-fixture-rights' },
    { asin, sourceUrl, observedAt: '2026-11-03T03:29:33.299Z', permissionReference: 'synthetic-fixture-rights' },
    { asin, sourceUrl, observedAt, permissionReference: '' },
  ]) {
    const result = await rejectedPreview(t, {
      asin, sourceUrl, observedAt, title: 'Verified source title',
      display: { provenance, images: ['https://other.example/images/I/x.jpg'] },
    });
    assert.equal(result?.display, undefined);
    t.mock.restoreAll();
  }
});

test('source preview filters unsafe images even when provenance is valid', async t => {
  const result = await rejectedPreview(t, {
    asin, sourceUrl, observedAt, title: 'Verified source title',
    display: {
      provenance: { asin, sourceUrl, observedAt, permissionReference: 'synthetic-fixture-rights' },
      images: [
        'https://other.example/images/I/x.jpg',
        'https://m.media-amazon.com.evil.example/images/I/x.jpg',
        'javascript:alert(1)',
        'https://m.media-amazon.com/images/I/valid.jpg',
      ],
    },
  });
  assert.deepEqual(result?.display?.images, ['https://m.media-amazon.com/images/I/valid.jpg']);
});

test('source identity and non-selected price remain excluded on malformed preview', async t => {
  const result = await rejectedPreview(t, {
    asin, sourceUrl, observedAt, title: 'Verified source title', priceJpy: -999,
  });
  assert.equal(result?.priceJpy, undefined);
  assert.equal(result?.display, undefined);
});

test('display-only product page stays without cart controls and handles Unicode truncation', () => {
  const title = 'A'.repeat(1199) + '😊' + '終';
  const html = renderToStaticMarkup(createElement(AmazonSourceProductDetail, {
    preview: { asin, sourceUrl, observedAt, title },
    error: 'Không xác minh được điều kiện mua.',
  }));
  assert.match(html, /Chưa có báo giá mua hộ hợp lệ/);
  assert.match(html, /Xem sản phẩm gốc trên Amazon/);
  assert.match(html, /Dịch bằng Google/);
  assert.doesNotMatch(html, /detail-cta|amazon-consent|Thêm vào giỏ hàng/);
});
