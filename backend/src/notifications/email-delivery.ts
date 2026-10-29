import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';

export const EMAIL_RECIPIENTS = ['mitajapan@gmail.com', 'nothink1315@gmail.com'] as const;
export const MAX_EMAIL_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 2 * 60_000;
const MAX_BATCH = 20;
const MAX_NEW_DELIVERIES = 200;

export type OutgoingOrderEmail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
};
export type EmailSender = (mail: OutgoingOrderEmail) => Promise<void>;

type ClaimedEmail = {
  id: string;
  event_id: string;
  order_id: string;
  recipient_email: string;
  attempt_count: number;
  order_status: string;
  created_at: Date;
};

/** Persist the first actual enabled-worker start; never backfill old events. */
export async function activateEmailAlertDelivery() {
  await db.query('INSERT INTO order_email_delivery_activation(id) VALUES(1) ON CONFLICT (id) DO NOTHING');
  const result = await db.query<{ activated_at: Date }>(
    'SELECT activated_at FROM order_email_delivery_activation WHERE id=1'
  );
  return result.rows[0].activated_at;
}

/** Seed only genuine order_placed events; one row per permitted recipient/event. */
export async function seedOrderEmailDeliveries(now = new Date()) {
  const result = await db.query(
    `INSERT INTO order_email_deliveries (event_id,recipient_email,next_attempt_at)
     SELECT e.id, recipients.email,$1 FROM order_notification_outbox e
       JOIN order_email_delivery_activation activation ON activation.id=1
       JOIN orders o ON o.id=e.order_id
       CROSS JOIN (VALUES ('mitajapan@gmail.com'),('nothink1315@gmail.com')) recipients(email)
       LEFT JOIN order_email_deliveries d ON d.event_id=e.id AND d.recipient_email=recipients.email
     WHERE e.created_at>=activation.activated_at
       AND e.event_type='order_placed' AND e.recipient='owner' AND e.channel='admin'
       AND o.status <> 'simulation_created' AND d.id IS NULL
     ORDER BY e.id,recipients.email LIMIT $2
     ON CONFLICT(event_id,recipient_email) DO NOTHING`,
    [now, MAX_NEW_DELIVERIES]
  );
  return result.rowCount ?? 0;
}

/** Lease a delivery in a short transaction, leaving network I/O outside locks. */
async function claimOrderEmail(now: Date): Promise<ClaimedEmail | null> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    // A process can die on its fifth send. Expired leases must become visible failures.
    await connection.query(
      `UPDATE order_email_deliveries SET state='failed',lease_until=NULL,
         last_failure_code='smtp_transient',updated_at=$1
       WHERE state='sending' AND lease_until<=$1 AND attempt_count>=$2`,
      [now, MAX_EMAIL_ATTEMPTS]
    );
    const selected = await connection.query<ClaimedEmail>(
      `SELECT d.id,d.event_id,d.recipient_email,d.attempt_count,e.order_id,
          o.status AS order_status,e.created_at
        FROM order_email_deliveries d
        JOIN order_notification_outbox e ON e.id=d.event_id
        JOIN orders o ON o.id=e.order_id
        WHERE d.attempt_count<$2 AND
          ((d.state='pending' AND d.next_attempt_at<=$1) OR
           (d.state='sending' AND d.lease_until<=$1))
        ORDER BY d.next_attempt_at,d.id
        FOR UPDATE OF d SKIP LOCKED LIMIT 1`, [now, MAX_EMAIL_ATTEMPTS]
    );
    const row = selected.rows[0];
    if (!row) {
      await connection.query('COMMIT');
      return null;
    }
    await connection.query(
      `UPDATE order_email_deliveries SET state='sending',attempt_count=attempt_count+1,
         lease_until=$2,updated_at=$1 WHERE id=$3`,
      [now, new Date(now.getTime() + CLAIM_LEASE_MS), row.id]
    );
    await connection.query('COMMIT');
    return { ...row, attempt_count: row.attempt_count + 1 };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

export function retryDelayMs(attempt: number) {
  return Math.min(2 * 60 * 60 * 1000, 30_000 * (4 ** (attempt - 1)));
}

export function classifyEmailFailure(error: unknown): 'smtp_transient' | 'smtp_permanent' {
  const code = error && typeof error === 'object' && 'responseCode' in error
    ? (error as { responseCode: unknown }).responseCode : null;
  return typeof code === 'number' && code >= 500 && code <= 599
    ? 'smtp_permanent' : 'smtp_transient';
}

function composeOrderEmail(row: ClaimedEmail, from: string): OutgoingOrderEmail {
  const recipientDigest = createHash('sha256').update(row.recipient_email).digest('hex').slice(0, 16);
  const created = row.created_at.toISOString();
  return {
    from,
    to: row.recipient_email,
    subject: 'Mita Japan: Có đơn đặt hàng mới',
    text: [
      'Một đơn hàng Mita Japan đã được lưu thành công.',
      `Mã đơn: ${row.order_id}`,
      `Trạng thái đơn: ${row.order_status}`,
      `Thời điểm tạo (UTC): ${created}`,
      '',
      'Đây là thông báo đặt đơn, không phải xác nhận đã thanh toán.',
      'Vui lòng đăng nhập Admin riêng qua đường SSH/localhost đã được bảo vệ để xem và xử lý.',
      'Không gửi thông tin khách hàng qua email trả lời.'
    ].join('\n'),
    // Stable across retries. Some SMTP services may deduplicate it, but not guaranteed.
    messageId: `<order-${row.event_id}-${recipientDigest}@mitajapanshop.duckdns.org>`
  };
}

/** Never throw SMTP errors into checkout; they are persisted for a later attempt. */
export async function processOrderEmailDeliveries(
  send: EmailSender, from: string, now = new Date(), max = 10,
  clock?: () => Date
) {
  if (!Number.isInteger(max) || max < 1 || max > MAX_BATCH) throw new Error('Invalid email delivery batch size');
  const startedAt = process.hrtime.bigint();
  const currentTime = clock ?? (() =>
    new Date(now.getTime() + Number((process.hrtime.bigint() - startedAt) / 1_000_000n)));
  await seedOrderEmailDeliveries(now);
  const summary = { attempted: 0, sent: 0, deferred: 0, failed: 0 };
  for (let index = 0; index < max; index++) {
    const claimTime = currentTime();
    const row = await claimOrderEmail(claimTime);
    if (!row) break;
    summary.attempted++;
    try {
      await send(composeOrderEmail(row, from));
      await db.query(
        `UPDATE order_email_deliveries SET state='sent',sent_at=$1,lease_until=NULL,
          last_failure_code=NULL,updated_at=$1
         WHERE id=$2 AND state='sending' AND attempt_count=$3`,
        [new Date(), row.id, row.attempt_count]
      );
      summary.sent++;
    } catch (error) {
      const failure = classifyEmailFailure(error);
      const exhausted = failure === 'smtp_permanent' || row.attempt_count >= MAX_EMAIL_ATTEMPTS;
      const failedAt = currentTime();
      await db.query(
        `UPDATE order_email_deliveries SET state=$1,next_attempt_at=$2,
          lease_until=NULL,last_failure_code=$3,updated_at=$4
         WHERE id=$5 AND state='sending' AND attempt_count=$6`,
        [
          exhausted ? 'failed' : 'pending',
          new Date(failedAt.getTime() + retryDelayMs(row.attempt_count)),
          failure, failedAt, row.id, row.attempt_count
        ]
      );
      if (exhausted) summary.failed++;
      else summary.deferred++;
    }
  }
  return summary;
}
