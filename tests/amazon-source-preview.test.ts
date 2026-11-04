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

test('direct source preview accepts observed price, primary image, product facts and free delivery label', async t => {
  const result = await rejectedPreview(t, {
    asin, sourceUrl, observedAt, title: 'Solix C2000 Gen 2',
    priceJpy: 167990, deliveryText: '無料配送 11月12日 - 13日', freeDelivery: true,
    observedDetails: {
      images: ['https://m.media-amazon.com/images/I/primary._AC_SL1500_.jpg'],
      brand: 'Anker', features: ['2048Wh portable power station'],
      rating: 4.3, reviewCount: 232,
    },
  });
  assert.equal(result?.priceJpy, 167990);
  assert.equal(result?.freeDelivery, true);
  assert.equal(result?.observedDetails?.rating, 4.3);
  assert.equal(result?.observedDetails?.images?.length, 1);
  const html = renderToStaticMarkup(createElement(AmazonSourceProductDetail, {
    preview: result!,
  }));
  assert.match(html, /primary\._AC_SL1500_/);
  assert.match(html, /167.990/);
  assert.match(html, /Miễn phí vận chuyển/);
  assert.match(html, /2048Wh portable power station/);
  assert.match(html, /232 lượt đánh giá/);
  assert.match(html, /Mã sản phẩm/);
  assert.match(html, /Chi tiết thông tin Amazon/);
  assert.match(html, /無料配送 11月12日 - 13日/);
  assert.match(html, /Sản phẩm hiện chưa nhận đặt hàng trực tuyến qua Mita/);
  assert.doesNotMatch(html, /amazon-preview-warning|inline-alert|Đã đọc thông tin sản phẩm từ Amazon/);
  assert.doesNotMatch(html, /detail-cta|amazon-consent|Thêm vào giỏ hàng/);
});

test('observed product details never accept untrusted image domains, script URLs or fake free flags', async t => {
  const result = await rejectedPreview(t, {
    asin, sourceUrl, observedAt, title: 'Source title',
    observedDetails: { images: ['javascript:alert(1)', 'https://m.media-amazon.com.evil.test/images/I/a.jpg',
      'https://m.media-amazon.com/images/I/valid.jpg'], rating: 999 },
    freeDelivery: true,
  });
  assert.deepEqual(result?.observedDetails?.images, ['https://m.media-amazon.com/images/I/valid.jpg']);
  assert.equal(result?.observedDetails?.rating, undefined);
  assert.equal(result?.freeDelivery, undefined);
});

test('display-only product page stays compact without cart controls and handles Unicode truncation', () => {
  const title = 'A'.repeat(1199) + '😊' + '終';
  const html = renderToStaticMarkup(createElement(AmazonSourceProductDetail, {
    preview: { asin, sourceUrl, observedAt, title },
  }));
  assert.match(html, /<h1 class="amazon-preview-title amazon-preview-title-jp">/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /終/);
  assert.match(html, /Xem sản phẩm gốc trên Amazon/);
  assert.match(html, /Dịch bằng Google/);
  assert.match(html, /Giá đang cập nhật/);
  assert.match(html, /Chưa có thông tin miễn phí vận chuyển/);
  assert.match(html, /<details class="amazon-preview-provenance">/);
  assert.doesNotMatch(html, /<div class="amazon-detail-rating"/);
  assert.doesNotMatch(html, /amazon-translation-bar|amazon-preview-result-status|Ảnh quan sát/);
  assert.doesNotMatch(html, /detail-cta|amazon-consent|Thêm vào giỏ hàng/);
});

test('source preview renders rating count without a fabricated score or delivery claim', () => {
  const html = renderToStaticMarkup(createElement(AmazonSourceProductDetail, {
    preview: {
      asin, sourceUrl, observedAt, title: 'Synthetic source title',
      observedDetails: { reviewCount: 9, images: ['https://bad.example/not-amazon.jpg'] },
    },
  }));
  assert.match(html, /9 lượt đánh giá trên Amazon/);
  assert.doesNotMatch(html, /amazon-rating-stars|Miễn phí vận chuyển nội địa Nhật/);
  assert.match(html, /Chưa có thông tin miễn phí vận chuyển nội địa Nhật/);
  assert.doesNotMatch(html, /bad\.example/);
});
