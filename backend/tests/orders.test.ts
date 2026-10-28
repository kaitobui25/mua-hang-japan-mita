import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { db } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createOrder, createSimulationOrder } from '../src/orders.js';
import { getPricingPolicy, toVnd } from '../src/pricing.js';

const server = buildServer();
const asin = 'ORDER00001';
const customer = { name: 'Checkout test private customer', phone: '0901234567', address: 'Private address' };
const payload = { customer, items: [{ asin, quantity: 2, unitPriceVnd: 1 }], status: 'paid', paymentMethod: 'card' };
after(async () => { await server.close(); await db.end(); });

test('real checkout persists locked merchandise, separates shipping and never captures payment', async t => {
  config.publicReadOnly = false;
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,rights_status,price_jpy,price_observed_at,availability,sale_status)
    VALUES($1,'thuc-pham-bo-sung','Order fixture','https://www.amazon.co.jp/dp/ORDER00001','fixture','verified',1000,now(),'in_stock','ready')`, [asin]);
  const simulation = await createSimulationOrder(payload);
  const response = await server.inject({ method: 'POST', url: '/api/checkout', payload });
  assert.equal(response.statusCode, 200);
  const order = response.json();
  assert.equal(order.status, 'pending_confirmation');
  assert.equal(order.paymentStatus, 'unpaid');
  assert.equal(order.paymentMethod, 'manual');
  assert.equal(order.paymentProvider, null);
  assert.equal(order.payableNowVnd, 0);
  assert.equal(order.shippingFinalVnd, null);
  assert.equal(order.subtotalVnd, toVnd(1000, await getPricingPolicy()) * 2);
  assert.equal(order.lines[0].unitPriceVnd * 2, order.subtotalVnd);
  assert.equal(JSON.stringify(order).includes(customer.address), false);
  const saved = (await db.query('SELECT * FROM orders WHERE id=$1', [order.orderId])).rows[0];
  assert.equal(saved.status, 'pending_confirmation');
  assert.equal(saved.payment_status, 'unpaid');
  assert.equal(saved.payment_method, 'manual');
  assert.equal(saved.payment_reference, null);
  assert.equal(saved.paid_at, null);
  assert.equal(Number(saved.merchandise_vnd), order.subtotalVnd);
  const shipping = (await db.query("SELECT shipping_estimate_vnd FROM categories WHERE slug='thuc-pham-bo-sung'")).rows[0].shipping_estimate_vnd;
  assert.equal(Number(saved.estimated_shipping_vnd), shipping * 2);

  await t.test('migration is repeatable and preserves simulation history', async () => {
    const sql = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql);
    assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [simulation.orderId])).rows[0].status, 'simulation_created');
  });
  await t.test('later catalog prices do not change order snapshots', async () => {
    await db.query('UPDATE products SET price_jpy=2000 WHERE asin=$1', [asin]);
    const line = (await db.query('SELECT * FROM order_items WHERE order_id=$1', [order.orderId])).rows[0];
    assert.equal(line.price_jpy, 1000);
    assert.equal(Number(line.unit_price_vnd), order.lines[0].unitPriceVnd);
  });
  await t.test('invalid carts, stale and hidden products write nothing', async () => {
    const before = (await db.query("SELECT count(*) FROM orders WHERE customer_name='Checkout test private customer'")).rows[0].count;
    for (const items of [[], [{ asin, quantity: -1 }], [{ asin, quantity: 0.5 }], [{ asin, quantity: 99 }, { asin, quantity: 1 }], [{ asin: 'MISSING001', quantity: 1 }]]) {
      await assert.rejects(createOrder({ customer, items }));
    }
    for (const change of ["price_observed_at=now()-interval '25 hours'", "price_observed_at=now(),admin_hidden_at=now()"]) {
      await db.query(`UPDATE products SET ${change} WHERE asin=$1`, [asin]);
      await assert.rejects(createOrder(payload));
    }
    await db.query('UPDATE products SET admin_hidden_at=NULL WHERE asin=$1', [asin]);
    assert.equal((await db.query("SELECT count(*) FROM orders WHERE customer_name='Checkout test private customer'")).rows[0].count, before);
  });
  await t.test('item write failure rolls back order and returns no private database error', async () => {
    // A transaction-local DB constraint failure occurs after the order INSERT.
    await db.query(`ALTER TABLE order_items ADD CONSTRAINT orders_test_reject CHECK (asin <> 'ORDER00001') NOT VALID`);
    try {
      const before = (await db.query("SELECT count(*) FROM orders WHERE customer_name='Checkout test private customer'")).rows[0].count;
      const response = await server.inject({ method: 'POST', url: '/api/checkout', payload });
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().code, 'checkout_failed');
      assert.equal(response.body.includes(customer.name), false);
      assert.equal(response.body.includes('orders_test_reject'), false);
      assert.equal((await db.query("SELECT count(*) FROM orders WHERE customer_name='Checkout test private customer'")).rows[0].count, before);
    } finally { await db.query('ALTER TABLE order_items DROP CONSTRAINT orders_test_reject'); }
  });
  await t.test('checkout follows the owner catalog switch without bypassing price validation', async () => {
    const previous = (await db.query('SELECT hide_local_test_only FROM catalog_settings WHERE id=1')).rows[0].hide_local_test_only;
    try {
      await db.query("UPDATE products SET rights_status='unverified' WHERE asin=$1", [asin]);
      await db.query('UPDATE catalog_settings SET hide_local_test_only=true WHERE id=1');
      await assert.rejects(createOrder(payload));
      await db.query('UPDATE catalog_settings SET hide_local_test_only=false WHERE id=1');
      assert.equal((await createOrder(payload)).status, 'pending_confirmation');
      await db.query("UPDATE products SET price_observed_at=now()-interval '25 hours' WHERE asin=$1", [asin]);
      await assert.rejects(createOrder(payload));
    } finally {
      await db.query('UPDATE catalog_settings SET hide_local_test_only=$1 WHERE id=1', [previous]);
      await db.query("UPDATE products SET rights_status='verified',price_observed_at=now() WHERE asin=$1", [asin]);
    }
  });
  await t.test('READ_ONLY blocks HTTP and direct persistence', async () => {
    config.publicReadOnly = true;
    try {
      assert.equal((await server.inject({ method: 'POST', url: '/api/checkout', payload })).statusCode, 404);
      await assert.rejects(createOrder(payload), { code: 'checkout_disabled' });
    } finally { config.publicReadOnly = false; }
  });
});
