import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '../src/db/pool.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';
import { createSimulationOrder } from '../src/orders.js';
import { provisionOwner } from '../src/admin/owner.js';

const server = buildServer();
const asin = 'ALERT00001';
const customer = { name: 'Private alert fixture', phone: '0901234567', address: 'Private address' };
const payload = { customer, items: [{ asin, quantity: 1 }] };
const headers = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:3000' };

after(async () => { await server.close(); await db.end(); });

test('real checkout creates one durable, owner-only Admin notification', async t => {
  config.publicReadOnly = false;
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,
    rights_status,price_jpy,price_observed_at,availability,sale_status)
    VALUES($1,'thuc-pham-bo-sung','Alert fixture','https://www.amazon.co.jp/dp/ALERT00001',
      'fixture','verified',1000,now(),'in_stock','ready')`, [asin]);

  const simulated = await createSimulationOrder(payload);
  const created = await server.inject({ method: 'POST', url: '/api/checkout', payload });
  assert.equal(created.statusCode, 200, created.body);
  const realId = created.json().orderId as string;
  const events = await db.query(`SELECT id,order_id,event_type,recipient,channel,acknowledged_at
    FROM order_notification_outbox WHERE order_id=$1`, [realId]);
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].event_type, 'order_placed');
  assert.equal(events.rows[0].recipient, 'owner');
  assert.equal(events.rows[0].channel, 'admin');
  assert.equal(events.rows[0].acknowledged_at, null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM order_notification_outbox WHERE order_id=$1',
    [simulated.orderId])).rows[0].n, 0, 'historical simulations produce no alerts');
  assert.equal(JSON.stringify(events.rows).includes(customer.name), false);
  assert.equal(JSON.stringify(events.rows).includes(customer.address), false);

  await t.test('duplicate insert is idempotent', async () => {
    await db.query(`INSERT INTO order_notification_outbox(order_id,event_type,recipient,channel)
      VALUES($1,'order_placed','owner','admin')
      ON CONFLICT (order_id,event_type,recipient,channel) DO NOTHING`, [realId]);
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM order_notification_outbox WHERE order_id=$1', [realId]
    )).rows[0].n, 1);
  });

  await t.test('alert-write failure rolls back real order and omits customer data from error', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    await db.query(`ALTER TABLE order_notification_outbox ADD CONSTRAINT notification_test_reject_owner
      CHECK (recipient <> 'owner') NOT VALID`);
    try {
      const response = await server.inject({ method: 'POST', url: '/api/checkout', payload });
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json().code, 'checkout_failed');
      assert.equal(response.body.includes(customer.name), false);
      assert.equal(response.body.includes(customer.address), false);
      assert.equal(response.body.includes('notification_test_reject_owner'), false);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
    } finally {
      await db.query('ALTER TABLE order_notification_outbox DROP CONSTRAINT notification_test_reject_owner');
    }
  });

  await t.test('authenticated owner can poll and acknowledge without exposing customer PII', async () => {
    await provisionOwner('Owner notification fixture password 123!', true);
    const login = await server.inject({ method: 'POST', url: '/api/admin/login',
      headers, payload: { password: 'Owner notification fixture password 123!' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const auth = { ...headers, cookie };
    const csrf = login.json().csrfToken as string;
    const route = '/api/admin/notifications';
    assert.equal((await server.inject({ url: route, headers })).statusCode, 401);
    assert.equal((await server.inject({ url: route, headers: auth, remoteAddress: '192.168.1.2' })).statusCode, 403);

    const listed = await server.inject({ url: route, headers: auth });
    assert.equal(listed.statusCode, 200, listed.body);
    const data = listed.json();
    assert.equal(data.externalPush, 'not_configured');
    assert.ok(data.unreadCount >= 1);
    assert.ok(data.items.some((item: { orderId: string }) => item.orderId === realId));
    assert.equal(listed.body.includes(customer.name), false);
    assert.equal(listed.body.includes(customer.phone), false);
    assert.equal(listed.body.includes(customer.address), false);
    assert.ok((await server.inject({ url: '/api/admin/overview', headers: auth })).json().newOrderAlertCount >= 1);

    const id = String(events.rows[0].id);
    const ack = `${route}/${id}/ack`;
    assert.equal((await server.inject({ method: 'POST', url: ack, headers: auth })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: ack,
      headers: { ...auth, 'x-csrf-token': csrf, origin: 'https://evil.test' } })).statusCode, 403);
    const first = await server.inject({ method: 'POST', url: ack,
      headers: { ...auth, 'x-csrf-token': csrf } });
    assert.equal(first.statusCode, 200, first.body);
    const second = await server.inject({ method: 'POST', url: ack,
      headers: { ...auth, 'x-csrf-token': csrf } });
    assert.deepEqual(second.json(), first.json(), 'repeat acknowledgement is idempotent');
    assert.equal((await server.inject({ url: `${route}?unread=1`, headers: auth })).json().items
      .some((item: { id: string }) => item.id === id), false);
    assert.equal((await server.inject({ url: `${route}?after=${id}`, headers: auth })).json().items
      .some((item: { id: string }) => item.id === id), false);
    assert.equal((await server.inject({ method: 'POST', url: `${route}/bad/ack`,
      headers: { ...auth, 'x-csrf-token': csrf } })).statusCode, 400);
    assert.equal((await server.inject({ url: `${route}?limit=101`, headers: auth })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: `${route}/999999999999999999/ack`,
      headers: { ...auth, 'x-csrf-token': csrf } })).statusCode, 404);
  });
});
