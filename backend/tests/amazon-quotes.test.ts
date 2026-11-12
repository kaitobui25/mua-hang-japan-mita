import { ScraplingSession, QuoteTransportError } from '../src/ingestion/scrapling.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { db } from '../src/db/pool.js';
import { buildQuote, createAmazonQuote, quoteRateLimit, refreshAmazonQuote } from '../src/amazon-quotes.js';
import { AMAZON_QUOTE_ACCESS_LOCK, AMAZON_QUOTE_SOURCE } from '../src/ingestion/source-access.js';
import { getPricingPolicy } from '../src/pricing.js';
import { createOrder } from '../src/orders.js';
import { config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { updateOrder, orderDetail } from '../src/admin/data.js';
import { QuoteError, type PublicOffer } from '../src/amazon-quote-source.js';

const disposable = process.env.MITA_DISPOSABLE_TEST_DATABASE;
const safe = disposable && /^mita_test_[a-f0-9]+$/.test(disposable) && new URL(config.databaseUrl).pathname === `/${disposable}`;
after(async () => { await db.end(); });
test('Amazon quote checkout and migration regressions in disposable DB only', { skip: !safe }, async t => {
  config.publicReadOnly = false;
  const server = buildServer();
  const customer = { name: 'Synthetic quote test', phone: '0901234567', address: 'Synthetic address' };
  const offer: PublicOffer = { asin: 'QUOTE00001', sourceUrl: 'https://www.amazon.co.jp/dp/QUOTE00001', title: 'Synthetic item', variant: 'Blue', seller: 'Synthetic seller', offerId: 'synthetic-offer', quantity: 1,
    priceJpy: 1000, imageUrl: null, purchaseType: 'one_time', shippingType: 'standard', freeJapanShipping: true, shippingEvidence: '通常配送無料', amazonDelivery: null };
  const insertQuote = async (age = 0) => {
    const quote = buildQuote(offer, await getPricingPolicy(), 7, new Date(Date.now() - age));
    await db.query('INSERT INTO amazon_quotes(id,snapshot,observed_at,expires_at) VALUES($1,$2,$3,$4)', [quote.id, JSON.stringify(quote), quote.observedAt, quote.expiresAt]);
    return quote;
  };
  try {
    const sql = await readFile(new URL('../src/db/amazon-quotes.sql', import.meta.url), 'utf8');
    await t.test('upgrades a legacy schema twice without rewriting existing shipping', async () => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('CREATE SCHEMA quote_upgrade');
        await client.query('SET LOCAL search_path TO quote_upgrade');
        await client.query('CREATE TABLE orders(id uuid PRIMARY KEY,estimated_shipping_vnd bigint NOT NULL)');
        await client.query('CREATE TABLE order_items(order_id uuid,asin varchar(10))');
        await client.query('INSERT INTO orders VALUES($1,55000)', [randomUUID()]);
        await client.query(sql); await client.query(sql);
        assert.equal(Number((await client.query('SELECT estimated_shipping_vnd FROM orders')).rows[0].estimated_shipping_vnd), 55000);
        assert.equal((await client.query('SELECT delivery_days FROM amazon_quote_settings')).rows[0].delivery_days, 7);
        assert.ok((await client.query("SELECT to_regclass('orders_checkout_key_idx') AS index")).rows[0].index);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
    await db.query(sql); await db.query(sql);
    const quote = await insertQuote();
    const payload = { customer, checkoutKey: randomUUID(), quoteItems: [{ quoteId: quote.id, confirmed: true, acknowledgeMissingEta: true }] };
    await t.test('explicit confirmation and missing-ETA warning are mandatory', async () => {
      await assert.rejects(createOrder({ ...payload, quoteItems: [{ quoteId: quote.id, confirmed: true }] }));
      await assert.rejects(createOrder({ ...payload, quoteItems: [{ quoteId: quote.id, confirmed: false }] }));
    });
    await t.test('conditional first-order delivery enables a genuine unpriced purchase request, not a fake quote', async () => {
      const oldEnabled = process.env.AMAZON_QUOTES_ENABLED;
      process.env.AMAZON_QUOTES_ENABLED = '1';
      await db.query('DELETE FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE]);
      const mocked = t.mock.method(ScraplingSession.prototype, 'quote', async () => ({
        html: `<input id="ASIN" value="B0BSPC5JR8"><span id="productTitle">Synthetic real-source match</span>
          <div id="desktop_buybox"><div id="corePrice_feature_div"><span class="a-offscreen">￥2,782</span></div>
          <div id="mir-layout-DELIVERY_BLOCK">無料配送（土曜日・初回注文特典）</div></div>`,
        observedAt: new Date()
      }));
      const post = (requestId: string, checkoutKey: string, person = customer, quantity = 1) =>
        server.inject({ method: 'POST', url: '/api/amazon/purchase-requests',
          payload: { requestId, checkoutKey, customer: person, quantity, confirmed: true } });
      try {
        const quote = await server.inject({ method: 'POST', url: '/api/amazon/quotes',
          payload: { input: 'https://www.amazon.co.jp/dp/B0BSPC5JR8/ref=navm_hdr_signin', quantity: 1 } });
        assert.equal(quote.statusCode, 422);
        const data = quote.json();
        assert.equal(data.code, 'offer_not_verified');
        assert.equal(data.details.preview.asin, 'B0BSPC5JR8');
        assert.equal(data.details.preview.priceJpy, 2782);
        assert.ok(Number.isSafeInteger(data.details.preview.estimatedPriceVnd));
        assert.ok(data.details.preview.estimatedPriceVnd > 0);
        assert.match(data.details.preview.deliveryText, /初回注文特典/);
        assert.match(data.details.requestId, /^[a-f0-9-]{36}$/);
        assert.equal((await db.query('SELECT 1 FROM products WHERE asin=$1', ['B0BSPC5JR8'])).rowCount, 0);
        const id = data.details.requestId as string;
        const invalidCheckout = await server.inject({
          method: 'POST', url: '/api/checkout',
          payload: { customer, checkoutKey: randomUUID(), quoteItems:
            [{ quoteId: id, confirmed: true, acknowledgeMissingEta: true }] },
        });
        assert.equal(invalidCheckout.statusCode, 404, 'preview UUID cannot be used as an approved Amazon quote');
        assert.equal(invalidCheckout.json().code, 'quote_not_found');
        const invalidRefresh = await server.inject({
          method: 'POST', url: `/api/amazon/quotes/${id}/refresh`,
        });
        assert.equal(invalidRefresh.statusCode, 404);
        // Contact submission must still work when the Amazon source-fetch
        // budget has been exhausted; the source-backed UUID is already issued.
        await db.query('DELETE FROM amazon_quote_rate_limits');
        for (let i = 0; i < 6; i++) await quoteRateLimit('purchase-request-synthetic');
        await assert.rejects(quoteRateLimit('purchase-request-synthetic'), /quote_rate_limited/);
        const invalid = await post(id, randomUUID(), { ...customer, phone: 'not-a-phone' });
        assert.equal(invalid.statusCode, 422);
        const invalidQuantity = await server.inject({ method: 'POST', url: '/api/amazon/purchase-requests',
          payload: { requestId: id, checkoutKey: randomUUID(), customer, quantity: 100, confirmed: true } });
        assert.equal(invalidQuantity.statusCode, 400);
        assert.equal((await db.query('SELECT order_id FROM amazon_quotes WHERE id=$1', [id])).rows[0].order_id, null);
        const key = randomUUID();
        const submitted = await post(id, key, customer, 2);
        assert.equal(submitted.statusCode, 200);
        assert.equal(submitted.json().status, 'purchase_request');
        assert.equal(submitted.json().priceConfirmed, false);
        assert.equal(submitted.json().shippingConfirmed, false);
        assert.equal(submitted.json().payableNowVnd, 0);
        const orderId = submitted.json().orderId;
        const saved = (await db.query('SELECT status,merchandise_vnd,estimated_shipping_vnd,shipping_final_vnd FROM orders WHERE id=$1', [orderId])).rows[0];
        assert.equal(saved.status, 'purchase_request');
        assert.equal(Number(saved.merchandise_vnd), 0);
        assert.equal(saved.estimated_shipping_vnd, null);
        assert.equal(saved.shipping_final_vnd, null);
        const item = (await db.query('SELECT quantity,price_jpy,unit_price_vnd,quote_snapshot FROM order_items WHERE order_id=$1', [orderId])).rows[0];
        assert.equal(item.quantity, 2);
        assert.equal(item.price_jpy, 2782);
        assert.equal(Number(item.unit_price_vnd), 0);
        assert.equal(item.quote_snapshot.kind, 'purchase_request');
        assert.equal(item.quote_snapshot.priceConfirmed, false);
        assert.equal(item.quote_snapshot.seller, null);
        assert.equal((await db.query('SELECT 1 FROM order_notification_outbox WHERE order_id=$1', [orderId])).rowCount, 1);
        const retry = await post(id, key, customer, 2);
        assert.equal(retry.json().status, 'already_submitted');
        assert.equal(retry.json().orderId, orderId);
        assert.equal((await post(id, randomUUID(), customer, 2)).statusCode, 409);
        await assert.rejects(updateOrder(orderId, { status: 'confirmed' }, 1));
        await assert.rejects(updateOrder(orderId, { paymentStatus: 'paid' }, 1));
        await assert.rejects(updateOrder(orderId, { shippingFinalVnd: 0 }, 1));
        const fake = await post(randomUUID(), randomUUID());
        assert.equal(fake.statusCode, 404);
      } finally {
        mocked.mock.restore();
        // The synthetic HTTP requests above share Fastify's injected peer and
        // global quote throttle with later tests. Reset only disposable DB state.
        await db.query('DELETE FROM amazon_quote_rate_limits');
        if (oldEnabled === undefined) delete process.env.AMAZON_QUOTES_ENABLED; else process.env.AMAZON_QUOTES_ENABLED = oldEnabled;
      }
    });
    const order = await createOrder(payload);
    await t.test('locks price, retains provenance, unknown shipping and notifies Owner without catalog insertion', async () => {
      const row = (await db.query('SELECT * FROM orders WHERE id=$1', [order.orderId])).rows[0];
      assert.equal(row.estimated_shipping_vnd, null); assert.equal(row.shipping_final_vnd, null);
      assert.equal(Number(row.merchandise_vnd), quote.lineTotalVnd);
      assert.equal((await db.query('SELECT * FROM products WHERE asin=$1', [offer.asin])).rowCount, 0);
      const snapshot = (await db.query('SELECT quote_snapshot FROM order_items WHERE order_id=$1', [order.orderId])).rows[0].quote_snapshot;
      assert.deepEqual(snapshot, quote);
      assert.equal((await db.query('SELECT 1 FROM order_notification_outbox WHERE order_id=$1', [order.orderId])).rowCount, 1);
      const detail = await orderDetail(order.orderId);
      assert.equal('shipping_confirmation_hash' in detail, false);
    });
    await t.test('retry cannot duplicate order and altered request cannot reuse key or consumed quote', async () => {
      const retry = await createOrder(payload);
      assert.equal(retry.orderId, order.orderId); assert.equal('duplicate' in retry && retry.duplicate, true);
      assert.equal(retry.status, 'already_submitted');
      assert.equal(retry.payableNowVnd, 0);
      assert.equal(retry.shippingEstimatedVnd, null);
      assert.equal(retry.shippingConfirmationToken, order.shippingConfirmationToken);
      await assert.rejects(createOrder({ ...payload, customer: { ...customer, name: 'Changed' } }));
      await assert.rejects(createOrder({ ...payload, checkoutKey: randomUUID() }));
      await assert.rejects(refreshAmazonQuote(quote.id), (error: unknown) => error instanceof Error && error.message === 'quote_already_ordered');
      assert.equal((await db.query('SELECT 1 FROM orders WHERE checkout_key=$1', [payload.checkoutKey])).rowCount, 1);
    });
    await t.test('fee is only proposed by Owner; customer confirms exact proposed amount', async () => {
      // Synthetic Owner fixture only, never real login or credentials.
      await db.query("INSERT INTO admin_accounts(id,username,role,enabled,password_hash) VALUES(1,'owner','owner',false,'synthetic-disabled') ON CONFLICT DO NOTHING");
      await updateOrder(order.orderId, { shippingFinalVnd: 40000 }, 1);
      assert.equal((await db.query('SELECT shipping_final_vnd FROM orders WHERE id=$1', [order.orderId])).rows[0].shipping_final_vnd, null);
      if (!('shippingConfirmationToken' in order)) throw new Error('missing token');
      const confirm = (token: string, fee: number) => server.inject({ method: 'POST', url: `/api/amazon/orders/${order.orderId}/shipping/confirm`, payload: { token, shippingVnd: fee } });
      assert.equal((await confirm('0'.repeat(64), 40000)).statusCode, 409);
      assert.equal((await confirm(order.shippingConfirmationToken!, 1)).statusCode, 409);
      assert.equal((await confirm(order.shippingConfirmationToken!, 40000)).statusCode, 200);
      assert.equal(Number((await db.query('SELECT shipping_final_vnd FROM orders WHERE id=$1', [order.orderId])).rows[0].shipping_final_vnd), 40000);
      const status = await server.inject({ method: 'POST', url: `/api/amazon/orders/${order.orderId}/shipping`, payload: { token: order.shippingConfirmationToken } });
      assert.equal(status.json().shippingProposedVnd, 40000);
      assert.equal(JSON.stringify(status.json()).includes(customer.address), false);
      await assert.rejects(updateOrder(order.orderId, { shippingFinalVnd: 50000 }, 1));
    });
    await t.test('expiry cannot extend old data when refresh is disabled', async () => {
      const expired = await insertQuote(901000);
      const enabled = process.env.AMAZON_QUOTES_ENABLED; process.env.AMAZON_QUOTES_ENABLED = '0';
      try { await assert.rejects(createOrder({ customer, checkoutKey: randomUUID(), quoteItems: [{ quoteId: expired.id, confirmed: true, acknowledgeMissingEta: true }] })); }
      finally { if (enabled === undefined) delete process.env.AMAZON_QUOTES_ENABLED; else process.env.AMAZON_QUOTES_ENABLED = enabled; }
      assert.equal((await db.query('SELECT order_id FROM amazon_quotes WHERE id=$1', [expired.id])).rows[0].order_id, null);
    });
    await t.test('settings changes and later source changes cannot rewrite ordered snapshots', async () => {
      await db.query('UPDATE amazon_quote_settings SET delivery_days=14 WHERE id=1');
      assert.equal((await db.query('SELECT quote_snapshot FROM order_items WHERE order_id=$1', [order.orderId])).rows[0].quote_snapshot.deliveryDays, 7);
      await db.query('UPDATE amazon_quote_settings SET delivery_days=7 WHERE id=1');
      await db.query(sql);
      assert.equal((await db.query('SELECT quote_snapshot FROM order_items WHERE order_id=$1', [order.orderId])).rows[0].quote_snapshot.unitPriceVnd, quote.unitPriceVnd);
    });
    await t.test('concurrent submissions consume a quote once', async () => {
      const quote = await insertQuote();
      const payload = { customer, checkoutKey: randomUUID(), quoteItems: [{ quoteId: quote.id, confirmed: true, acknowledgeMissingEta: true }] };
      const results = await Promise.all([createOrder(payload), createOrder(payload)]);
      assert.equal(results[0].orderId, results[1].orderId);
      assert.equal((await db.query('SELECT 1 FROM orders WHERE checkout_key=$1', [payload.checkoutKey])).rowCount, 1);
    });
    await t.test('mixed cart stores catalog lines and quote snapshots atomically', async () => {
      await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,rights_status,price_jpy,price_observed_at,availability,sale_status)
        VALUES('MIXED00001','thuc-pham-bo-sung','Synthetic catalog item','https://www.amazon.co.jp/dp/MIXED00001','fixture','verified',1000,now(),'in_stock','ready')`);
      const quote = await insertQuote();
      const mixed = await createOrder({ customer, checkoutKey: randomUUID(), items: [{ asin: 'MIXED00001', quantity: 2 }], quoteItems: [{ quoteId: quote.id, confirmed: true, acknowledgeMissingEta: true }] });
      assert.equal(mixed.subtotalVnd, quote.unitPriceVnd * 3);
      assert.equal((await db.query('SELECT 1 FROM order_items WHERE order_id=$1', [mixed.orderId])).rowCount, 2);
      assert.equal((await db.query('SELECT estimated_shipping_vnd FROM orders WHERE id=$1', [mixed.orderId])).rows[0].estimated_shipping_vnd, null);
    });
    await t.test('same ASIN can be purchased as catalog and multiple separate Amazon offers without collapsing snapshots', async () => {
      const first = await insertQuote();
      const second = await insertQuote();
      await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,rights_status,price_jpy,price_observed_at,availability,sale_status)
        VALUES('QUOTE00001','thuc-pham-bo-sung','Synthetic catalog ASIN','https://www.amazon.co.jp/dp/QUOTE00001','fixture','verified',1000,now(),'in_stock','ready')`);
      const result = await createOrder({ customer, checkoutKey: randomUUID(), items: [{ asin: 'QUOTE00001', quantity: 1 }],
        quoteItems: [{ quoteId: first.id, confirmed: true, acknowledgeMissingEta: true }, { quoteId: second.id, confirmed: true, acknowledgeMissingEta: true }] });
      const saved = (await db.query('SELECT asin,quote_snapshot FROM order_items WHERE order_id=$1 ORDER BY line_id', [result.orderId])).rows;
      assert.equal(saved.length, 3);
      assert.equal(saved.filter(row => row.quote_snapshot === null).length, 1);
      assert.deepEqual(saved.filter(row => row.quote_snapshot).map(row => row.quote_snapshot.id).sort(), [first.id, second.id].sort());
      assert.equal(result.subtotalVnd, first.lineTotalVnd * 3);
    });
    await t.test('catalog-only checkout with an explicit key is idempotent after a lost response', async () => {
      const key = randomUUID();
      const catalogPayload = { customer, checkoutKey: key, items: [{ asin: 'MIXED00001', quantity: 1 }] };
      const original = await createOrder(catalogPayload);
      const again = await createOrder(catalogPayload);
      assert.equal(again.orderId, original.orderId);
      assert.equal(again.status, 'already_submitted');
      assert.equal(again.shippingConfirmationToken, undefined);
      assert.equal(again.shippingEstimatedVnd, original.shippingEstimatedVnd);
      assert.equal((await db.query('SELECT id FROM orders WHERE checkout_key=$1', [key])).rowCount, 1);
    });
    await t.test('refresh distinguishes unchanged terms from changed price and never submits expired quotes', async () => {
      // Other integration suites exercise persistent Amazon cooldown in this shared disposable DB.
      // Reset only the synthetic test gate, never the active developer database.
      await db.query("DELETE FROM source_access_blocks WHERE source='amazon.co.jp'");
      const enabled = process.env.AMAZON_QUOTES_ENABLED; process.env.AMAZON_QUOTES_ENABLED = '1';
      let price = 1000;
      const transportMock = t.mock.method(ScraplingSession.prototype, 'quote', async () => ({ html: `<input id="ASIN" value="${offer.asin}"><span id="productTitle">Synthetic item</span>
        <div id="twister"><span class="selection">Blue</span></div><div id="desktop_buybox"><div id="newAccordionRow"><input type="radio" checked>
        <input name="offeringID.1" value="synthetic-offer"><span id="sellerProfileTriggerId">Synthetic seller</span><span id="price_inside_buybox">￥${price}</span></div>
        <div id="availability">在庫あり</div><select name="quantity"><option value="1" selected>1</option></select><div id="mir-layout-DELIVERY_BLOCK-slot">通常配送無料</div></div>`,
      observedAt: new Date() }));
      try {
        const quote = await createAmazonQuote(offer.asin);
        assert.equal((await refreshAmazonQuote(quote.id)).changed, false);
        price = 1500;
        assert.equal((await refreshAmazonQuote(quote.id)).changed, true);
        const expired = await insertQuote(901000);
        const result = await server.inject({ method: 'POST', url: '/api/checkout', payload: { customer, checkoutKey: randomUUID(), quoteItems: [{ quoteId: expired.id, confirmed: true, acknowledgeMissingEta: true }] } });
        assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'quote_refresh_required');
        assert.equal(result.json().details.changed, true); assert.equal(result.json().details.quote.priceJpy, 1500);
        assert.equal(result.json().details.previousQuoteId, expired.id);
        assert.equal((await db.query('SELECT order_id FROM amazon_quotes WHERE id=$1', [expired.id])).rows[0].order_id, null);
      } finally {
        transportMock.mock.restore();
        if (enabled === undefined) delete process.env.AMAZON_QUOTES_ENABLED; else process.env.AMAZON_QUOTES_ENABLED = enabled;
      }
    });
    await t.test('quote gate and mutex isolate catalog cooldown; CAPTCHA stops quotes without retry', async () => {
      const enabled = process.env.AMAZON_QUOTES_ENABLED; process.env.AMAZON_QUOTES_ENABLED = '1';
      let calls = 0;
      const transportMock = t.mock.method(ScraplingSession.prototype, 'quote', async () => { calls++; throw new QuoteTransportError('amazon_blocked'); });
      const lock = await db.connect();
      try {
        await lock.query('SELECT pg_advisory_lock($1)', [AMAZON_QUOTE_ACCESS_LOCK]);
        await assert.rejects(createAmazonQuote(offer.asin, 1), /amazon_busy/);
        assert.equal(calls, 0);
        await lock.query('SELECT pg_advisory_unlock($1)', [AMAZON_QUOTE_ACCESS_LOCK]);
        // A catalog denial must not disable customer quotes.
        await db.query(`INSERT INTO source_access_blocks(source,reason,retry_after_at)
          VALUES('amazon.co.jp','catalog denied',now()+interval '1 day')`);
        let blockedRetryAfter: string | undefined;
        await assert.rejects(createAmazonQuote(offer.asin, 1), (error: unknown) => {
          assert.ok(error instanceof QuoteError);
          assert.equal(error.code, 'amazon_blocked');
          blockedRetryAfter = error.retryAfterAt;
          assert.ok(blockedRetryAfter && Date.parse(blockedRetryAfter) > Date.now());
          return true;
        });
        assert.equal(calls, 1);
        await assert.rejects(createAmazonQuote(offer.asin, 1), (error: unknown) => {
          assert.ok(error instanceof QuoteError);
          assert.equal(error.code, 'amazon_cooldown');
          assert.equal(error.retryAfterAt, blockedRetryAfter);
          return true;
        });
        assert.equal(calls, 1);
        assert.equal((await db.query('SELECT 1 FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE])).rowCount, 1);
        assert.equal((await db.query("SELECT reason FROM source_access_blocks WHERE source='amazon.co.jp'")).rows[0].reason, 'catalog denied');
        const blockedResponse = await server.inject({ method: 'POST', url: '/api/amazon/quotes', payload: { input: offer.asin } });
        assert.equal(blockedResponse.statusCode, 503);
        assert.equal(blockedResponse.json().code, 'amazon_cooldown');
        assert.equal(blockedResponse.json().retryAfterAt, blockedRetryAfter);
        await db.query('DELETE FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE]);
        transportMock.mock.mockImplementation(async () => { throw new QuoteTransportError('amazon_rate_limited', new Date(Date.now() + 604800000).toISOString()); });
        await assert.rejects(createAmazonQuote(offer.asin), /amazon_rate_limited/);
        const blocked = (await db.query('SELECT retry_after_at FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE])).rows[0];
        assert.ok(blocked.retry_after_at.getTime() > Date.now() + 6 * 86400000);
      } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [AMAZON_QUOTE_ACCESS_LOCK]); lock.release(); transportMock.mock.restore();
        await db.query('DELETE FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE]);
        await db.query("DELETE FROM source_access_blocks WHERE source='amazon.co.jp'");
        if (enabled === undefined) delete process.env.AMAZON_QUOTES_ENABLED; else process.env.AMAZON_QUOTES_ENABLED = enabled;
      }
    });
    await t.test('public quote throttle persists across requests and read-only mode disables writes', async () => {
      for (let i = 0; i < 6; i++) await quoteRateLimit('synthetic-peer');
      await assert.rejects(quoteRateLimit('synthetic-peer'), /quote_rate_limited/);
      config.publicReadOnly = true;
      try { assert.equal((await server.inject({ method: 'POST', url: '/api/amazon/quotes', payload: { input: offer.asin } })).statusCode, 404); }
      finally { config.publicReadOnly = false; }
    });
  } finally { await server.close(); }
});
