import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { createOrder, createSimulationOrder } from '../src/orders.js';
import {
  activateEmailAlertDelivery, EMAIL_RECIPIENTS, MAX_EMAIL_ATTEMPTS, classifyEmailFailure,
  processOrderEmailDeliveries, retryDelayMs, seedOrderEmailDeliveries,
  type OutgoingOrderEmail
} from '../src/notifications/email-delivery.js';
import { gmailSmtpConfig } from '../src/notifications/email-scheduler.js';

const asin = 'EMAIL00001';
const from = 'operator@example.test';
const customer = {
  name: 'Private customer delivery fixture',
  phone: '09012344321',
  address: 'Private address, never email',
  email: 'private-buyer@example.test'
};
const payload = { customer, items: [{ asin, quantity: 1 }] };
const disposableDatabase = /^\/mita_test_[a-f0-9]{16}$/.test(new URL(config.databaseUrl).pathname);
const getDeliveries = async (orderId: string) => (await db.query<{
  id: string;
  recipient_email: string;
  state: string;
  attempt_count: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  last_failure_code: string | null;
  sent_at: Date | null;
}>(`SELECT d.id,d.recipient_email,d.state,d.attempt_count,d.next_attempt_at,d.lease_until,
    d.last_failure_code,d.sent_at FROM order_email_deliveries d
    JOIN order_notification_outbox e ON e.id=d.event_id
    WHERE e.order_id=$1 ORDER BY d.recipient_email`, [orderId])).rows;

const place = async () => (await createOrder(payload)).orderId;
const t0 = new Date('2030-01-02T03:04:05.000Z');
// Most tests freeze their clock; the separate slow-send test advances it deliberately.
const deliverAt = (sender: (mail: OutgoingOrderEmail) => Promise<void>, at = t0) =>
  processOrderEmailDeliveries(sender, from, at, 10, () => at);

after(async () => { await db.end(); });

test('Gmail SMTP requires explicit VPS opt-in + a separate sender identity and app password', () => {
  const good = {
    NODE_ENV: 'production',
    MITA_EMAIL_ALERTS_ENABLED: '1',
    MITA_EMAIL_ALERTS_VPS: '1',
    MITA_GMAIL_SMTP_USER: 'sender@example.test',
    MITA_GMAIL_SMTP_FROM: 'sender@example.test',
    MITA_GMAIL_SMTP_APP_PASSWORD: 'A'.repeat(16)
  };
  assert.equal(gmailSmtpConfig({}, 'linux'), null);
  assert.equal(gmailSmtpConfig(good, 'win32'), null);
  assert.equal(gmailSmtpConfig({ ...good, NODE_ENV: 'development' }, 'linux'), null);
  assert.equal(gmailSmtpConfig({ ...good, MITA_EMAIL_ALERTS_VPS: '0' }, 'linux'), null);
  assert.equal(gmailSmtpConfig({ ...good, MITA_EMAIL_ALERTS_ENABLED: '0' }, 'linux'), null);
  assert.equal(gmailSmtpConfig({ ...good, MITA_GMAIL_SMTP_APP_PASSWORD: '' }, 'linux'), null);
  assert.equal(gmailSmtpConfig({ ...good, MITA_GMAIL_SMTP_FROM: 'other@example.test' }, 'linux'), null);
  assert.equal(gmailSmtpConfig({ ...good, MITA_GMAIL_SMTP_APP_PASSWORD: '123' }, 'linux'), null);
  assert.deepEqual(gmailSmtpConfig(good, 'linux'), {
    user: 'sender@example.test', from: 'sender@example.test', password: 'A'.repeat(16)
  });
  assert.equal(classifyEmailFailure({ responseCode: 550 }), 'smtp_permanent');
  assert.equal(classifyEmailFailure({ responseCode: 421 }), 'smtp_transient');
  assert.equal(classifyEmailFailure(new Error('any secret text')), 'smtp_transient');
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(5), 2 * 60 * 60 * 1000);
});

test('real orders seed two durable deliveries; simulation never seeds; SMTP is mocked',
  { skip: !disposableDatabase && 'Run database tests through npm test (disposable database harness).' }, async t => {
  config.publicReadOnly = false;
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,
    rights_status,price_jpy,price_observed_at,availability,sale_status)
    VALUES($1,'thuc-pham-bo-sung','Email fixture','https://www.amazon.co.jp/dp/EMAIL00001',
      'fixture','verified',1000,now(),'in_stock','ready')`, [asin]);

  const before = (await db.query('SELECT count(*)::int AS total FROM order_email_deliveries')).rows[0].total;
  const historic = await place();
  const simulation = await createSimulationOrder(payload);
  assert.equal(await seedOrderEmailDeliveries(t0), 0, 'migration without activation sends no mail');
  const activatedAt = await activateEmailAlertDelivery();
  assert.ok(activatedAt instanceof Date);
  assert.equal((await activateEmailAlertDelivery()).getTime(), activatedAt.getTime(),
    'activation watermark is durable and unchanged on later starts');
  const real = await place();
  await seedOrderEmailDeliveries(t0);
  await seedOrderEmailDeliveries(t0);
  assert.equal((await getDeliveries(simulation.orderId)).length, 0);
  assert.equal((await getDeliveries(historic)).length, 0, 'pre-activation real order not mailed');
  assert.equal((await db.query('SELECT count(*)::int AS total FROM order_email_deliveries')).rows[0].total, before + 2);
  assert.deepEqual((await getDeliveries(real)).map(r => r.recipient_email), [...EMAIL_RECIPIENTS].sort());
  assert.ok((await getDeliveries(real)).every(r => r.state === 'pending'));

  await t.test('concurrent workers dedupe each recipient, mail carries no customer PII', async () => {
    const delivered: OutgoingOrderEmail[] = [];
    const sender = async (message: OutgoingOrderEmail) => {
      delivered.push(message);
      await new Promise(resolve => setTimeout(resolve, 8));
    };
    const results = await Promise.all([
      deliverAt(sender),
      deliverAt(sender)
    ]);
    assert.equal(results.reduce((n, r) => n + r.sent, 0), 2);
    assert.deepEqual(delivered.map(mail => mail.to).sort(), [...EMAIL_RECIPIENTS].sort());
    assert.equal(new Set(delivered.map(mail => mail.messageId)).size, 2);
    for (const mail of delivered) {
      assert.equal(mail.from, from);
      assert.ok(mail.subject.includes('Mita Japan'));
      assert.ok(mail.text.includes(real));
      assert.ok(mail.text.includes('pending_confirmation'));
      assert.ok(mail.text.includes('UTC'));
      assert.ok(mail.text.includes('SSH/localhost'));
      for (const detail of Object.values(customer)) {
        assert.equal(JSON.stringify(mail).includes(detail), false, 'do not email customer PII');
      }
    }
    assert.ok((await getDeliveries(real)).every(row => row.state === 'sent' && row.attempt_count === 1 && row.sent_at));
    const again = await deliverAt(sender);
    assert.equal(again.attempted, 0);
    assert.equal(delivered.length, 2);
  });

  await t.test('temporary SMTP failure retries only that recipient after bounded backoff', async () => {
    const id = await place();
    const recipientAttempts = new Map<string, number>();
    const smtp = async (mail: OutgoingOrderEmail) => {
      const count = (recipientAttempts.get(mail.to) ?? 0) + 1;
      recipientAttempts.set(mail.to, count);
      if (mail.to === EMAIL_RECIPIENTS[0] && count === 1) {
        throw Object.assign(new Error('PRIVATE password appears only in mock error'), { responseCode: 421 });
      }
    };
    const first = await deliverAt(smtp);
    assert.equal(first.attempted, 2);
    assert.equal(first.deferred, 1);
    assert.equal(first.sent, 1);
    const rows = await getDeliveries(id);
    const waiting = rows.find(row => row.recipient_email === EMAIL_RECIPIENTS[0])!;
    assert.equal(waiting.state, 'pending');
    assert.equal(waiting.attempt_count, 1);
    assert.equal(waiting.last_failure_code, 'smtp_transient');
    assert.equal(waiting.next_attempt_at.getTime(), t0.getTime() + retryDelayMs(1));
    assert.equal(JSON.stringify(rows).includes('PRIVATE password'), false);
    assert.equal((await deliverAt(smtp, new Date(t0.getTime() + 29_999))).attempted, 0);
    assert.equal((await deliverAt(smtp, new Date(t0.getTime() + 30_000))).sent, 1);
    assert.ok((await getDeliveries(id)).every(row => row.state === 'sent'));
    assert.deepEqual([...recipientAttempts.values()].sort(), [1, 2]);
  });

  await t.test('permanent failure stops without aborting second recipient; no raw errors persisted', async () => {
    const id = await place();
    const sentTo: string[] = [];
    const sender = async (mail: OutgoingOrderEmail) => {
      if (mail.to === EMAIL_RECIPIENTS[0]) {
        throw Object.assign(new Error('contains customer private email and sender password'), { responseCode: 535 });
      }
      sentTo.push(mail.to);
    };
    const result = await deliverAt(sender);
    assert.equal(result.failed, 1);
    assert.equal(result.sent, 1);
    const rows = await getDeliveries(id);
    assert.deepEqual(rows.map(row => row.state).sort(), ['failed', 'sent']);
    assert.ok(rows.every(row => row.attempt_count === 1));
    assert.equal(rows.find(row => row.state === 'failed')?.last_failure_code, 'smtp_permanent');
    assert.deepEqual(sentTo, [EMAIL_RECIPIENTS[1]]);
    assert.equal((await deliverAt(sender, new Date('2031-01-01'))).attempted, 0);
  });

  await t.test('repeated temporary failures exhaust five attempts; expired fifth lease is failed', async () => {
    const id = await place();
    let now = t0;
    let attempts = 0;
    const failOne = async (mail: OutgoingOrderEmail) => {
      if (mail.to === EMAIL_RECIPIENTS[0]) {
        attempts++;
        throw new Error('NO customer PII or sender secrets should be stored');
      }
    };
    for (let attempt = 1; attempt <= MAX_EMAIL_ATTEMPTS; attempt++) {
      const result = await deliverAt(failOne, now);
      if (attempt < MAX_EMAIL_ATTEMPTS) assert.equal(result.deferred, 1);
      else assert.equal(result.failed, 1);
      now = new Date(now.getTime() + retryDelayMs(attempt));
    }
    assert.equal(attempts, MAX_EMAIL_ATTEMPTS);
    const rows = await getDeliveries(id);
    assert.equal(rows.find(row => row.recipient_email === EMAIL_RECIPIENTS[0])?.state, 'failed');
    assert.equal(rows.find(row => row.recipient_email === EMAIL_RECIPIENTS[0])?.attempt_count, MAX_EMAIL_ATTEMPTS);
    assert.equal((await deliverAt(failOne, now)).attempted, 0);

    const crashOrder = await place();
    await seedOrderEmailDeliveries(now);
    await db.query(`UPDATE order_email_deliveries d SET state='sending',attempt_count=5,
        lease_until=$1,sent_at=NULL
        FROM order_notification_outbox e
        WHERE d.event_id=e.id AND e.order_id=$2 AND d.recipient_email=$3`,
      [new Date(now.getTime() - 1_000), crashOrder, EMAIL_RECIPIENTS[0]]);
    const afterCrash = await deliverAt(async () => {}, now);
    assert.equal(afterCrash.attempted, 1, 'other pending recipient is delivered');
    assert.equal((await getDeliveries(crashOrder)).find(row => row.recipient_email === EMAIL_RECIPIENTS[0])?.state, 'failed');
  });

  await t.test('long first send gives next claim a fresh lease; another worker cannot duplicate it', async () => {
    const id = await place();
    let elapsed = 0;
    let calls = 0;
    const clock = () => new Date(t0.getTime() + elapsed);
    const sender = async (mail: OutgoingOrderEmail) => {
      calls++;
      if (calls === 1) {
        elapsed = 90_000;
        return;
      }
      const active = (await getDeliveries(id)).find(row => row.recipient_email === mail.to)!;
      assert.equal(active.state, 'sending');
      assert.equal(active.lease_until?.getTime(), clock().getTime() + 120_000,
        'second lease is measured from second claim, not batch start');
      const overlapping = await processOrderEmailDeliveries(
        async () => assert.fail('another worker cannot take current leased delivery'), from,
        clock(), 2, clock
      );
      assert.equal(overlapping.attempted, 0);
    };
    const result = await processOrderEmailDeliveries(sender, from, t0, 2, clock);
    assert.equal(result.sent, 2);
    assert.equal(calls, 2);
    assert.ok((await getDeliveries(id)).every(row => row.state === 'sent'));
  });
});
