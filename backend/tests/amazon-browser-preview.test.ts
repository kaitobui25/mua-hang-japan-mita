import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { parseBrowserCapture } from '../src/amazon-browser-preview.js';
import { ScraplingSession } from '../src/ingestion/scrapling.js';
import { QuoteError } from '../src/amazon-quote-source.js';

const asin = 'B08FTSH6KP';
const fixedCapturedAt = '2026-11-13T00:00:00.000Z';
const page = {
  url: `https://www.amazon.co.jp/dp/${asin}?ref_=mobile`,
  asin, title: 'テスト商品 ブルー', priceText: '￥3,580', brand: 'テストブランド',
  images: ['https://m.media-amazon.com/images/I/test-photo.jpg'],
  variantText: '青色', availabilityText: '在庫あり',
  deliveryText: '通常配送、送料は未確定',
  features: ['商品説明の一行']
};

const disposable = process.env.MITA_DISPOSABLE_TEST_DATABASE;
const safe = disposable && /^mita_test_[a-f0-9]+$/.test(disposable) &&
  new URL(config.databaseUrl).pathname === `/${disposable}`;
after(async () => { await db.end(); });

test('user-browser capture accepts selected product data, not a verified quote', () => {
  const input = parseBrowserCapture({ capturedAt: fixedCapturedAt, page, quantity: 2 }, new Date(fixedCapturedAt));
  assert.equal(input.preview.asin, asin);
  assert.equal(input.preview.priceJpy, 3580);
  assert.equal(input.preview.sourceUrl, `https://www.amazon.co.jp/dp/${asin}`);
  assert.equal(input.preview.observedAt, fixedCapturedAt);
  assert.equal(input.preview.observedDetails?.images?.length, 1);
  assert.equal(input.preview.deliveryText, page.deliveryText);
  assert.ok(input.preview.observedDetails?.specifications?.some(v => v.name.includes('Phiên bản') && v.value === '青色'));
  assert.equal(input.quantity, 2);
  assert.equal(input.translateToVietnamese, false);
  assert.equal(parseBrowserCapture({ capturedAt: fixedCapturedAt, page, translateToVietnamese: true }, new Date(fixedCapturedAt)).translateToVietnamese, true);
  assert.throws(() => parseBrowserCapture({ capturedAt: fixedCapturedAt, page, translateToVietnamese: 'true' }, new Date(fixedCapturedAt)),
    (error: unknown) => error instanceof QuoteError && error.code === 'invalid_browser_capture');
  assert.equal(parseBrowserCapture({ capturedAt: fixedCapturedAt, page: { ...page, priceText: undefined } }, new Date(fixedCapturedAt)).preview.priceJpy, undefined);
  assert.equal(parseBrowserCapture({ capturedAt: fixedCapturedAt, page }, new Date('2026-11-13T00:14:59Z')).preview.observedAt, fixedCapturedAt);
  for (const at of ['2026-11-12T23:44:59.000Z', '2026-11-13T00:02:01.000Z']) {
    assert.throws(() => parseBrowserCapture({ capturedAt: at, page }, new Date(fixedCapturedAt)),
      (error: unknown) => error instanceof QuoteError && error.code === 'browser_capture_expired');
  }
  assert.throws(() => parseBrowserCapture({ page }, new Date(fixedCapturedAt)),
    (error: unknown) => error instanceof QuoteError && error.code === 'invalid_browser_capture');
});

test('user-browser capture rejects mismatches, non-Amazon URLs, ambiguous price and unsafe fields', () => {
  const bad = [
    { ...page, url: 'http://www.amazon.co.jp/dp/' + asin },
    { ...page, url: 'https://amazon.co.jp.evil.test/dp/' + asin },
    { ...page, asin: 'B000000001' },
    { ...page, priceText: '￥3,580～￥7,000' },
    { ...page, priceText: '$3,580' },
    { ...page, priceText: '￥0' },
    { ...page, images: ['https://evil.example/track.jpg'] },
    { ...page, features: Array.from({ length: 11 }, () => 'foo') },
    { ...page, title: '' }
  ];
  for (const invalidPage of bad) assert.throws(() => parseBrowserCapture({ capturedAt: fixedCapturedAt, page: invalidPage }, new Date(fixedCapturedAt)),
    (error: unknown) => error instanceof QuoteError && error.code === 'invalid_browser_capture');
});

test('browser preview and contact-only checkout work with source quote disabled, never use Amazon transport', { skip: !safe }, async t => {
  const server = buildServer();
  const old = process.env.AMAZON_QUOTES_ENABLED;
  const readonly = config.publicReadOnly;
  process.env.AMAZON_QUOTES_ENABLED = '0';
  config.publicReadOnly = false;
  const source = t.mock.method(ScraplingSession.prototype, 'quote', async () => {
    throw new Error('Amazon network transport must not be used for browser preview');
  });
  try {
    await db.query(`INSERT INTO source_access_blocks(source,reason,retry_after_at)
      VALUES('amazon.co.jp','synthetic catalog cooldown',now()+interval '1 day'),
            ('amazon.co.jp:quote','synthetic source quote cooldown',now()+interval '1 day')
      ON CONFLICT(source) DO UPDATE SET reason=EXCLUDED.reason,retry_after_at=EXCLUDED.retry_after_at`);
    const capturedAt = new Date().toISOString();
    const response = await server.inject({ method: 'POST', url: '/api/amazon/browser-preview', payload: { capturedAt, page, quantity: 2 } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.source, 'user_browser');
    assert.equal(result.priceConfirmed, false);
    assert.equal(result.checkoutAllowed, false);
    assert.equal(result.preview.asin, asin);
    assert.equal(result.preview.observedAt, capturedAt);
    assert.equal(result.preview.priceJpy, 3580);
    assert.ok(result.preview.estimatedPriceVnd > 0);
    assert.match(result.requestId, /^[a-f0-9-]{36}$/);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    assert.equal(source.mock.callCount(), 0);
    const snapshot = (await db.query('SELECT snapshot FROM amazon_quotes WHERE id=$1', [result.requestId])).rows[0].snapshot;
    assert.equal(snapshot.kind, 'browser_capture_preview');
    assert.equal(snapshot.quantity, 2);
    assert.equal(snapshot.preview.observedAt, capturedAt);
    assert.ok(Date.parse(snapshot.receivedAt) >= Date.parse(capturedAt));

    const invalidPriced = await server.inject({ method: 'POST', url: '/api/checkout', payload: {
      customer: { name: 'Synthetic browser test', phone: '0901234567', address: 'Synthetic QA address' },
      checkoutKey: randomUUID(),
      quoteItems: [{ quoteId: result.requestId, confirmed: true, acknowledgeMissingEta: true }]
    } });
    assert.equal(invalidPriced.statusCode, 404);
    assert.equal(invalidPriced.json().code, 'quote_not_found');
    process.env.AMAZON_QUOTES_ENABLED = '1';
    const invalidRefresh = await server.inject({ method: 'POST', url: `/api/amazon/quotes/${result.requestId}/refresh` });
    assert.equal(invalidRefresh.statusCode, 404);
    assert.equal(invalidRefresh.json().code, 'quote_not_found');
    process.env.AMAZON_QUOTES_ENABLED = '0';
    const key = randomUUID();
    const customer = { name: 'Synthetic browser test', phone: '0901234567', address: 'Synthetic QA address' };
    const contact = await server.inject({ method: 'POST', url: '/api/amazon/purchase-requests',
      payload: { requestId: result.requestId, checkoutKey: key, customer, quantity: 2, confirmed: true } });
    assert.equal(contact.statusCode, 200, contact.body);
    const receipt = contact.json();
    assert.equal(receipt.status, 'purchase_request');
    assert.equal(receipt.priceConfirmed, false);
    assert.equal(receipt.payableNowVnd, 0);
    const saved = (await db.query('SELECT status,payment_status,merchandise_vnd FROM orders WHERE id=$1', [receipt.orderId])).rows[0];
    assert.equal(saved.status, 'purchase_request');
    assert.equal(saved.payment_status, 'unpaid');
    assert.equal(Number(saved.merchandise_vnd), 0);
    const line = (await db.query('SELECT quote_snapshot FROM order_items WHERE order_id=$1', [receipt.orderId])).rows[0].quote_snapshot;
    assert.equal(line.evidenceSource, 'user_browser_unverified');
    assert.equal(line.priceConfirmed, false);
    const again = await server.inject({ method: 'POST', url: '/api/amazon/purchase-requests',
      payload: { requestId: result.requestId, checkoutKey: key, customer, quantity: 2, confirmed: true } });
    assert.equal(again.json().status, 'already_submitted');
    assert.equal(source.mock.callCount(), 0);

    const missingPrice = await server.inject({ method: 'POST', url: '/api/amazon/browser-preview',
      payload: { capturedAt: new Date().toISOString(), page: { ...page, priceText: undefined } } });
    assert.equal(missingPrice.statusCode, 200);
    assert.match(missingPrice.json().requestId, /^[a-f0-9-]{36}$/);
    assert.equal(missingPrice.json().preview.priceJpy, undefined);
    const requestWithoutPrice = await server.inject({ method: 'POST', url: '/api/amazon/purchase-requests',
      payload: { requestId: missingPrice.json().requestId, checkoutKey: randomUUID(), customer, quantity: 1, confirmed: true } });
    assert.equal(requestWithoutPrice.statusCode, 200, requestWithoutPrice.body);
    assert.equal(requestWithoutPrice.json().payableNowVnd, 0);
    const noPriceOrderLine = (await db.query('SELECT price_jpy,quote_snapshot FROM order_items WHERE order_id=$1',
      [requestWithoutPrice.json().orderId])).rows[0];
    assert.equal(noPriceOrderLine.price_jpy, 0);
    assert.equal(noPriceOrderLine.quote_snapshot.observedPriceJpy, null);
    const stale = await server.inject({ method: 'POST', url: '/api/amazon/browser-preview',
      payload: { capturedAt: new Date(Date.now() - 20 * 60000).toISOString(), page } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'browser_capture_expired');
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM source_access_blocks
      WHERE source IN ('amazon.co.jp','amazon.co.jp:quote')`)).rows[0].count, 2);
  } finally {
    source.mock.restore();
    await db.query(`DELETE FROM source_access_blocks WHERE source IN ('amazon.co.jp','amazon.co.jp:quote')`);
    if (old === undefined) delete process.env.AMAZON_QUOTES_ENABLED;
    else process.env.AMAZON_QUOTES_ENABLED = old;
    config.publicReadOnly = readonly;
    await server.close();
  }
});
