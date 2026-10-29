import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/pool.js';
import { buildServer } from '../src/server.js';
import { createOrder, createSimulationOrder } from '../src/orders.js';
import { config } from '../src/config.js';
import { provisionOwner } from '../src/admin/owner.js';

const server = buildServer();
const asin = 'RELAY00001';
const customer = { name: 'Private relay customer', phone: '0907777888', address: 'Private relay address' };
const payload = { customer, items: [{ asin, quantity: 1 }] };
const local = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:3000' };
const token = 'A'.repeat(43);
const url = 'https://mitajapanshop.duckdns.org/api/order-alert-relay';
const environment = {
  inbound: process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN,
  outboundUrl: process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL,
  outboundToken: process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN,
  fetch: globalThis.fetch
};
after(async () => {
  if (environment.inbound === undefined) delete process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN;
  else process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN = environment.inbound;
  if (environment.outboundUrl === undefined) delete process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL;
  else process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL = environment.outboundUrl;
  if (environment.outboundToken === undefined) delete process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN;
  else process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN = environment.outboundToken;
  globalThis.fetch = environment.fetch;
  await server.close();
  await db.end();
});

test('public VPS relay is bearer-only and returns minimal persisted real-order alerts', async () => {
  config.publicReadOnly = false;
  delete process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN;
  delete process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN;
  delete process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL;
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,
      rights_status,price_jpy,price_observed_at,availability,sale_status)
    VALUES($1,'thuc-pham-bo-sung','Relay fixture','https://www.amazon.co.jp/dp/RELAY00001',
      'fixture','verified',1000,now(),'in_stock','ready')`, [asin]);
  const simulation = await createSimulationOrder(payload);
  const real = await createOrder(payload);
  const event = (await db.query('SELECT id FROM order_notification_outbox WHERE order_id=$1',
    [real.orderId])).rows[0];
  assert.ok(event.id);
  const path = '/api/order-alert-relay';
  assert.equal((await server.inject({ url: path })).statusCode, 404, 'disabled relay fails closed');
  process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN = token;
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Basic ' + token }]) {
    const response = await server.inject({ url: path, headers });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    const deniedAck = await server.inject({ method: 'POST', url: `${path}/${event.id}/ack`, headers });
    assert.equal(deniedAck.statusCode, 403, deniedAck.body);
  }
  const headers = { authorization: `Bearer ${token}` };
  const listed = await server.inject({ url: `${path}?unread=1`, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(listed.json().items.some((item: { orderId: string }) => item.orderId === real.orderId));
  assert.ok(!listed.json().items.some((item: { orderId: string }) => item.orderId === simulation.orderId));
  for (const sensitive of [customer.name, customer.phone, customer.address]) {
    assert.equal(listed.body.includes(sensitive), false);
  }
  assert.equal((await server.inject({ url: `${path}?limit=101`, headers })).statusCode, 400);
  assert.equal((await server.inject({ method: 'POST', url: `${path}/nonsense/ack`, headers })).statusCode, 400);
  const ack = await server.inject({ method: 'POST', url: `${path}/${event.id}/ack`, headers });
  assert.equal(ack.statusCode, 200, ack.body);
  const repeated = await server.inject({ method: 'POST', url: `${path}/${event.id}/ack`, headers });
  assert.deepEqual(repeated.json(), ack.json(), 'ack is idempotent at the VPS source');
  assert.ok(!(await server.inject({ url: `${path}?unread=1`, headers })).json().items
    .some((item: { id: string }) => item.id === String(event.id)));
});

test('Windows local owner sees and acknowledges a separate VPS source via authenticated HTTPS polling', async () => {
  process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN = token;
  process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL = url;
  process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN = token;
  await provisionOwner('Owner relay-only integration 123!', true);
  const login = await server.inject({ method: 'POST', url: '/api/admin/login',
    headers: local, payload: { password: 'Owner relay-only integration 123!' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const csrf = login.json().csrfToken as string;
  const owner = { ...local, cookie };
  const vpsOrderId = randomUUID();
  const fakeServer = Fastify({ logger: false });
  let acknowledgedAt: string | null = null;
  const received: string[] = [];
  fakeServer.addHook('onRequest', async (request, reply) => {
    received.push(request.headers.authorization ?? '');
    if (request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  });
  fakeServer.get('/api/order-alert-relay', async () => ({
    unreadCount: acknowledgedAt ? 0 : 1,
    items: acknowledgedAt ? [] : [{
      id: '987', orderId: vpsOrderId, eventType: 'order_placed',
      createdAt: new Date().toISOString(), acknowledgedAt: null, orderStatus: 'pending_confirmation'
    }]
  }));
  fakeServer.post('/api/order-alert-relay/987/ack', async () => {
    acknowledgedAt ??= new Date().toISOString();
    return { id: '987', acknowledgedAt };
  });
  try {
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input));
      assert.equal(target.protocol, 'https:');
      assert.equal(target.hostname, 'mitajapanshop.duckdns.org');
      assert.equal(init?.redirect, 'error', 'redirects may not forward the bearer elsewhere');
      const result = await fakeServer.inject({
        method: init?.method ?? 'GET', url: target.pathname + target.search,
        headers: { authorization: String(new Headers(init?.headers).get('authorization')) }
      });
      return new Response(result.body, { status: result.statusCode,
        headers: { 'content-type': 'application/json' } });
    };

    const unauthenticated = await server.inject({ url: '/api/admin/notifications' });
    assert.equal(unauthenticated.statusCode, 401);
    const listed = await server.inject({ url: '/api/admin/notifications?unread=1', headers: owner });
    assert.equal(listed.statusCode, 200, listed.body);
    const data = listed.json();
    assert.equal(data.relayStatus, 'connected');
    assert.equal(data.items.filter((item: { id: string }) => item.id === 'vps:987').length, 1);
    assert.equal(data.items.find((item: { id: string }) => item.id === 'vps:987').source, 'vps');
    assert.ok(data.unreadCount >= 1);
    assert.ok(data.items.some((item: { source: string }) => item.source === 'local'));
    const overview = await server.inject({ url: '/api/admin/overview', headers: owner });
    assert.equal(overview.statusCode, 200, overview.body);
    assert.equal(overview.json().relayStatus, 'connected');
    assert.ok(overview.json().newOrderAlertCount >= 1);
    assert.ok(!listed.body.includes(customer.phone));
    assert.ok(!listed.body.includes(customer.address));
    const repeatedPoll = await server.inject({ url: '/api/admin/notifications?unread=1', headers: owner });
    assert.equal(repeatedPoll.json().items.filter((item: { id: string }) => item.id === 'vps:987').length, 1);
    const ackPath = '/api/admin/notifications/vps:987/ack';
    assert.equal((await server.inject({ method: 'POST', url: ackPath, headers: owner })).statusCode, 403);
    const ack = await server.inject({ method: 'POST', url: ackPath,
      headers: { ...owner, 'x-csrf-token': csrf } });
    assert.equal(ack.statusCode, 200, ack.body);
    assert.equal(ack.json().id, 'vps:987');
    assert.ok(acknowledgedAt, 'VPS fake server recorded acknowledgement');
    assert.equal((await server.inject({ url: '/api/admin/notifications?unread=1', headers: owner }))
      .json().items.some((item: { id: string }) => item.id === 'vps:987'), false);
    assert.ok(received.every(value => value === `Bearer ${token}`));

    process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN = 'B'.repeat(43);
    const disconnected = await server.inject({ url: '/api/admin/notifications?unread=1', headers: owner });
    assert.equal(disconnected.statusCode, 200);
    assert.equal(disconnected.json().relayStatus, 'unavailable');
    const unavailableOverview = await server.inject({ url: '/api/admin/overview', headers: owner });
    assert.equal(unavailableOverview.json().relayStatus, 'unavailable');
    assert.ok(disconnected.json().items.some((item: { source: string }) => item.source === 'local'),
      'local fallback remains available');
    const badAck = await server.inject({ method: 'POST', url: ackPath,
      headers: { ...owner, 'x-csrf-token': csrf } });
    assert.equal(badAck.statusCode, 503, badAck.body);
    process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL = 'http://127.0.0.1:4100/api/order-alert-relay';
    assert.equal((await server.inject({ url: '/api/admin/notifications', headers: owner }))
      .json().relayStatus, 'unavailable', 'unsafe non-HTTPS target is rejected');
  } finally {
    globalThis.fetch = environment.fetch;
    await fakeServer.close();
  }
});
