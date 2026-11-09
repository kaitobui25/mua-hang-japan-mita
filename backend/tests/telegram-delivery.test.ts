import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { createOrder, createSimulationOrder } from '../src/orders.js';
import { startAlertPoller } from '../src/notifications/email-scheduler.js';
import {
  activateTelegramAlertDelivery, createTelegramSender, processOrderTelegramDeliveries,
  seedOrderTelegramDeliveries, telegramConfig, TELEGRAM_CHAT_ID, TelegramDeliveryError,
  telegramRetryDelayMs, type TelegramSender
} from '../src/notifications/telegram-delivery.js';

after(async () => { await db.end(); });
const token = '123456789:' + 'A'.repeat(35);
const good = { NODE_ENV: 'production', MITA_TELEGRAM_ALERTS_ENABLED: '1',
  MITA_TELEGRAM_ALERTS_VPS: '1', MITA_TELEGRAM_BOT_TOKEN: token };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('Telegram requires Linux production and both opt-ins with an env token', () => {
  assert.deepEqual(telegramConfig(good, 'linux'), { token });
  for (const env of [{}, { ...good, NODE_ENV: 'development' },
    { ...good, MITA_TELEGRAM_ALERTS_ENABLED: '0' }, { ...good, MITA_TELEGRAM_ALERTS_VPS: '0' },
    { ...good, MITA_TELEGRAM_BOT_TOKEN: '' }, { ...good, MITA_TELEGRAM_BOT_TOKEN: 'invalid' }]) {
    assert.equal(telegramConfig(env, 'linux'), null);
  }
  assert.equal(telegramConfig(good, 'win32'), null);
});

test('Bot API POST locks recipient, uses timeout, stores only message ID', async () => {
  let calls = 0;
  const send = createTelegramSender({ token }, async (url, options) => {
    calls++;
    assert.equal(url, `https://api.telegram.org/bot${token}/sendMessage`);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(options?.body)), {
      chat_id: TELEGRAM_CHAT_ID, text: 'test fixture', protect_content: true
    });
    return Response.json({ ok: true, result: { message_id: 42, text: 'ignored' } });
  });
  assert.equal(await send('test fixture'), 42);
  assert.equal(calls, 1);
});

test('Bot API failures sanitize network, timeout, malformed, auth, 5xx and 429 responses', async () => {
  const cases: [() => Promise<Response>, string, number][] = [
    [async () => { throw new Error(`secret ${token}`); }, 'telegram_transient', 0],
    [async () => { throw new DOMException(token, 'TimeoutError'); }, 'telegram_transient', 0],
    [async () => new Response('not JSON'), 'telegram_transient', 0],
    [async () => Response.json({ ok: true, result: {} }), 'telegram_transient', 0],
    [async () => Response.json({ ok: false, description: token }, { status: 401 }), 'telegram_permanent', 0],
    [async () => Response.json({ ok: false }, { status: 403 }), 'telegram_permanent', 0],
    [async () => Response.json({ ok: false }, { status: 503 }), 'telegram_transient', 0],
    [async () => Response.json({ ok: false, parameters: { retry_after: 120 } }, { status: 429 }), 'telegram_rate_limit', 120_000],
    [async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: -1 } }), 'telegram_rate_limit', 30_000]
  ];
  for (const [request, code, delay] of cases) {
    await assert.rejects(createTelegramSender({ token }, request)('fixture'), error => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, code);
      assert.equal(error.retryAfterMs, delay);
      assert.equal(String(error).includes(token), false);
      return true;
    });
  }
});

test('one 15-second timer isolates failed/stalled channels and drains on shutdown', async () => {
  let poll = () => {};
  let timers = 0;
  let cancelled = 0;
  let gmail = 0;
  let telegram = 0;
  let release = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const schedule = ((callback: () => void, delay: number) => {
    timers++; assert.equal(delay, 15_000); poll = callback;
    return { unref() {} };
  }) as unknown as typeof setInterval;
  const cancel = (() => { cancelled++; }) as typeof clearInterval;
  const stop = startAlertPoller([
    { name: 'email', run: async () => { gmail++; throw new Error('fixture'); } },
    { name: 'telegram', run: async () => { telegram++; await blocked; } }
  ], schedule, cancel);
  await flush(); poll(); await flush();
  assert.equal(timers, 1); assert.equal(gmail, 2); assert.equal(telegram, 1);
  let stopped = false;
  const draining = stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  release(); await draining; poll(); await flush();
  assert.equal(cancelled, 1); assert.equal(telegram, 1);
  // Telegram runs alone when Gmail is disabled; reverse failure isolation too.
  const stopSolo = startAlertPoller([{ name: 'telegram', run: async () => { telegram++; } }], schedule, cancel);
  await flush(); await stopSolo(); assert.equal(telegram, 2);
  const stopReverse = startAlertPoller([
    { name: 'telegram', run: async () => { throw new Error('fixture'); } },
    { name: 'email', run: async () => { gmail++; } }
  ], schedule, cancel);
  await flush(); await stopReverse(); assert.equal(gmail, 3);
});

const disposable = new URL(config.databaseUrl).pathname === `/${process.env.MITA_DISPOSABLE_TEST_DATABASE}` &&
  /^mita_test_[a-f0-9]{16}$/.test(process.env.MITA_DISPOSABLE_TEST_DATABASE ?? '');
test('Telegram ledger integration on disposable database only', { skip: !disposable }, async t => {
  config.publicReadOnly = false;
  const sql = await readFile(new URL('../src/db/telegram-delivery.sql', import.meta.url), 'utf8');
  // Simulate upgrading a pre-Telegram schema, then reapply without losing state.
  await db.query('DROP TABLE order_telegram_deliveries, order_telegram_delivery_activation');
  await db.query(sql); await db.query(sql);
  assert.equal((await db.query('SELECT * FROM order_telegram_delivery_activation')).rowCount, 0);
  const asin = 'TELEG00001';
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,
    rights_status,price_jpy,price_observed_at,availability,sale_status)
    VALUES($1,'thuc-pham-bo-sung','Telegram fixture','https://www.amazon.co.jp/dp/TELEG00001',
    'fixture','verified',1000,now(),'in_stock','ready')`, [asin]);
  const customer = { name: 'Private Telegram buyer', phone: '09012344321',
    address: 'Private Telegram address', email: 'private-telegram@example.test' };
  const payload = { customer, items: [{ asin, quantity: 1 }] };
  const place = async () => (await createOrder(payload)).orderId;
  const historic = await place();
  const simulation = await createSimulationOrder(payload);
  assert.equal(await seedOrderTelegramDeliveries(), 0);
  const activated = await activateTelegramAlertDelivery();
  assert.equal((await activateTelegramAlertDelivery()).getTime(), activated.getTime());
  const keyedPayload = { ...payload, checkoutKey: randomUUID() };
  const duplicate = await Promise.all([createOrder(keyedPayload), createOrder(keyedPayload)]);
  const real = duplicate[0].orderId;
  assert.equal(duplicate[1].orderId, real, 'repeated checkout creates only one event/delivery');
  const t0 = new Date('2030-01-02T03:04:05Z');
  const deliver = (send: TelegramSender, at = t0, max = 10) =>
    processOrderTelegramDeliveries(send, at, max, () => at);
  const rows = async (id: string) => (await db.query(
    `SELECT d.* FROM order_telegram_deliveries d JOIN order_notification_outbox e ON e.id=d.event_id
     WHERE e.order_id=$1`, [id])).rows;
  await Promise.all([seedOrderTelegramDeliveries(t0), seedOrderTelegramDeliveries(t0)]);
  assert.equal((await rows(historic)).length, 0);
  assert.equal((await rows(simulation.orderId)).length, 0);
  assert.equal((await rows(real)).length, 1);
  await db.query(sql);
  assert.equal((await activateTelegramAlertDelivery()).getTime(), activated.getTime());

  await t.test('concurrent claims, Admin viewed independence and PII-free messages', async () => {
    await db.query("UPDATE order_notification_outbox SET acknowledged_at=now() WHERE order_id=$1", [real]);
    const messages: string[] = [];
    const send = async (text: string) => { messages.push(text); await flush(); return 42; };
    const result = await Promise.all([deliver(send), deliver(send)]);
    assert.equal(result.reduce((n, r) => n + r.sent, 0), 1);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes(real));
    assert.ok(messages[0].includes(String((await rows(real))[0].event_id)));
    for (const detail of [...Object.values(customer), token, 'https://']) assert.ok(!messages[0].includes(detail));
    assert.equal((await rows(real))[0].message_id, '42');
    assert.equal((await deliver(send)).attempted, 0);
  });

  await t.test('429 delay, no early retry, independent Gmail ledger and successful receipt', async () => {
    const id = await place();
    assert.equal((await deliver(async () => { throw new TelegramDeliveryError('telegram_rate_limit', 120_000); })).deferred, 1);
    let row = (await rows(id))[0];
    assert.equal(row.next_attempt_at.getTime(), t0.getTime() + 120_000);
    assert.equal((await deliver(async () => 1, new Date(t0.getTime() + 119_999))).attempted, 0);
    assert.equal((await deliver(async () => 123, new Date(t0.getTime() + 120_000))).sent, 1);
    row = (await rows(id))[0];
    assert.equal(row.state, 'sent'); assert.equal(row.attempt_count, 2);
    assert.equal((await db.query(`SELECT count(*)::int n FROM order_email_deliveries d
      JOIN order_notification_outbox e ON e.id=d.event_id WHERE e.order_id=$1`, [id])).rows[0].n, 0);
  });

  await t.test('permanent errors fail once; raw error strings are never stored', async () => {
    const id = await place();
    assert.equal((await deliver(async () => { throw new TelegramDeliveryError('telegram_permanent'); })).failed, 1);
    assert.equal((await rows(id))[0].attempt_count, 1);
    assert.equal((await deliver(async () => 1)).attempted, 0);
  });

  await t.test('five bounded retries and expired final lease recovery', async () => {
    const id = await place();
    let now = t0;
    for (let i = 1; i <= 5; i++) {
      const result = await deliver(async () => { throw new Error(token + customer.name); }, now);
      assert.equal(i === 5 ? result.failed : result.deferred, 1);
      now = new Date(now.getTime() + telegramRetryDelayMs(i));
    }
    assert.equal((await rows(id))[0].state, 'failed');
    assert.equal(JSON.stringify(await rows(id)).includes(token), false);
    assert.equal((await deliver(async () => 1, now)).attempted, 0);
    const crash = await place(); await seedOrderTelegramDeliveries(t0);
    await db.query(`UPDATE order_telegram_deliveries d SET state='sending',attempt_count=5,lease_until=$1
      FROM order_notification_outbox e WHERE d.event_id=e.id AND e.order_id=$2`, [t0, crash]);
    assert.equal((await deliver(async () => 1)).attempted, 0);
    assert.equal((await rows(crash))[0].state, 'failed');
  });

  await t.test('active lease excludes another worker and expired lease can retry', async () => {
    const id = await place();
    await deliver(async () => {
      assert.equal((await rows(id))[0].lease_until.getTime(), t0.getTime() + 120_000);
      assert.equal((await deliver(async () => assert.fail('leased'))).attempted, 0);
      return 99;
    });
    const crash = await place(); await seedOrderTelegramDeliveries(t0);
    await db.query(`UPDATE order_telegram_deliveries d SET state='sending',attempt_count=1,lease_until=$1
      FROM order_notification_outbox e WHERE d.event_id=e.id AND e.order_id=$2`, [t0, crash]);
    assert.equal((await deliver(async () => 100)).sent, 1);
    assert.equal((await rows(crash))[0].attempt_count, 2);
  });

  await t.test('receipt write failure preserves uncertain send lease until recovery', async t => {
    const id = await place();
    const query = db.query.bind(db);
    const mock = t.mock.method(db, 'query', (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes("SET state='sent',sent_at=")) {
        throw new Error('synthetic receipt write failure');
      }
      return Reflect.apply(query, db, args);
    });
    try {
      await assert.rejects(deliver(async () => 123), /synthetic receipt write failure/);
    } finally { mock.mock.restore(); }
    assert.equal((await rows(id))[0].state, 'sending');
    assert.equal((await rows(id))[0].attempt_count, 1);
    assert.equal((await deliver(async () => assert.fail('uncertain send remains leased'))).attempted, 0);
    assert.equal((await deliver(async () => 124, new Date(t0.getTime() + 120_000))).sent, 1);
  });
});
