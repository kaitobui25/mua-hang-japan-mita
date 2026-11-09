import { db } from '../db/pool.js';
import { setDefaultAutoSelectFamily } from 'node:net';

export const TELEGRAM_CHAT_ID = '7480163903';
export const MAX_TELEGRAM_ATTEMPTS = 5;
const LEASE_MS = 120_000;

export function telegramConfig(environment: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (environment.NODE_ENV !== 'production' || platform !== 'linux' ||
      environment.MITA_TELEGRAM_ALERTS_ENABLED !== '1' || environment.MITA_TELEGRAM_ALERTS_VPS !== '1') return null;
  const token = environment.MITA_TELEGRAM_BOT_TOKEN;
  if (!token || !/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(token)) return null;
  return { token };
}

type FailureCode = 'telegram_transient' | 'telegram_permanent' | 'telegram_rate_limit';
export class TelegramDeliveryError extends Error {
  constructor(readonly code: FailureCode, readonly retryAfterMs = 0) { super(code); }
}
export type TelegramSender = (text: string) => Promise<number>;

/** All external response/error text is discarded, including URLs containing the token. */
export function createTelegramSender(settings: NonNullable<ReturnType<typeof telegramConfig>>,
  request: typeof fetch = fetch): TelegramSender {
  // Hermes VPS can reach Telegram over IPv4 but Node 22's dual-family fetch
  // autodetection times out (ETIMEDOUT/ENETUNREACH). Use the working single-
  // family path for live requests; leave injected mock transport unaffected.
  if (request === fetch) setDefaultAutoSelectFamily(false);
  return async text => {
    try {
      const response = await request(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, protect_content: true })
      });
      const body = await response.json().catch(() => null) as {
        ok?: boolean; error_code?: number; parameters?: { retry_after?: number };
        result?: { message_id?: number };
      } | null;
      if (response.status === 429 || body?.error_code === 429) {
        const seconds = body?.parameters?.retry_after;
        // Honour valid server delays without permitting invalid/overflowing dates.
        const delay = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds, 31_536_000) * 1000 : 30_000;
        throw new TelegramDeliveryError('telegram_rate_limit', delay);
      }
      const messageId = body?.result?.message_id;
      if (response.ok && body?.ok === true && typeof messageId === 'number' &&
          Number.isSafeInteger(messageId) && messageId > 0) return messageId;
      const code = body?.error_code ?? response.status;
      throw new TelegramDeliveryError(code >= 400 && code < 500
        ? 'telegram_permanent' : 'telegram_transient');
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      throw new TelegramDeliveryError('telegram_transient');
    }
  };
}

export async function activateTelegramAlertDelivery() {
  await db.query('INSERT INTO order_telegram_delivery_activation(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
  return (await db.query<{ activated_at: Date }>(
    'SELECT activated_at FROM order_telegram_delivery_activation WHERE id=1')).rows[0].activated_at;
}

export async function seedOrderTelegramDeliveries(now = new Date()) {
  const result = await db.query(
    `INSERT INTO order_telegram_deliveries(event_id,chat_id,next_attempt_at)
     SELECT e.id,$2,$1 FROM order_notification_outbox e
     JOIN order_telegram_delivery_activation a ON a.id=1
     JOIN orders o ON o.id=e.order_id
     LEFT JOIN order_telegram_deliveries d ON d.event_id=e.id AND d.chat_id=$2
     WHERE e.created_at>=a.activated_at AND e.event_type='order_placed'
       AND e.recipient='owner' AND e.channel='admin' AND o.status<>'simulation_created'
       AND d.id IS NULL
     ORDER BY e.id LIMIT 200 ON CONFLICT(event_id,chat_id) DO NOTHING`, [now, TELEGRAM_CHAT_ID]);
  return result.rowCount ?? 0;
}

type Claim = { id: string; event_id: string; order_id: string; created_at: Date; attempt_count: number };
async function claimTelegram(now: Date): Promise<Claim | null> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      `UPDATE order_telegram_deliveries SET state='failed',lease_until=NULL,
       last_failure_code='telegram_transient',updated_at=$1
       WHERE state='sending' AND lease_until<=$1 AND attempt_count>=$2`, [now, MAX_TELEGRAM_ATTEMPTS]);
    const row = (await connection.query<Claim>(
      `SELECT d.id,d.event_id,d.attempt_count,e.order_id,e.created_at
       FROM order_telegram_deliveries d JOIN order_notification_outbox e ON e.id=d.event_id
       WHERE d.chat_id=$3 AND d.attempt_count<$2 AND
         ((d.state='pending' AND d.next_attempt_at<=$1) OR (d.state='sending' AND d.lease_until<=$1))
       ORDER BY d.next_attempt_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
      [now, MAX_TELEGRAM_ATTEMPTS, TELEGRAM_CHAT_ID])).rows[0];
    if (row) await connection.query(
      `UPDATE order_telegram_deliveries SET state='sending',attempt_count=attempt_count+1,
       lease_until=$2,updated_at=$1 WHERE id=$3`, [now, new Date(now.getTime() + LEASE_MS), row.id]);
    await connection.query('COMMIT');
    return row ? { ...row, attempt_count: row.attempt_count + 1 } : null;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally { connection.release(); }
}

export function telegramRetryDelayMs(attempt: number) {
  return Math.min(7_200_000, 30_000 * 4 ** (attempt - 1));
}

export async function processOrderTelegramDeliveries(send: TelegramSender, now = new Date(), max = 10,
  clock?: () => Date) {
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('Invalid Telegram delivery batch size');
  const started = process.hrtime.bigint();
  const currentTime = clock ?? (() => new Date(now.getTime() + Number((process.hrtime.bigint() - started) / 1_000_000n)));
  await seedOrderTelegramDeliveries(now);
  const summary = { attempted: 0, sent: 0, deferred: 0, failed: 0 };
  for (let index = 0; index < max; index++) {
    const row = await claimTelegram(currentTime());
    if (!row) break;
    summary.attempted++;
    let messageId: number;
    try {
      messageId = await send([
        'Mita Japan: Đơn mới đã đặt, chưa thanh toán.',
        `Mã đơn: ${row.order_id}`, `Sự kiện: ${row.event_id}`,
        `Thời gian (UTC): ${row.created_at.toISOString()}`,
        'Mở Admin qua đường truy cập riêng để xử lý.'
      ].join('\n'));
    } catch (error) {
      const failure = error instanceof TelegramDeliveryError ? error : new TelegramDeliveryError('telegram_transient');
      const exhausted = failure.code === 'telegram_permanent' || row.attempt_count >= MAX_TELEGRAM_ATTEMPTS;
      const failedAt = currentTime();
      await db.query(
        `UPDATE order_telegram_deliveries SET state=$1,next_attempt_at=$2,lease_until=NULL,
         last_failure_code=$3,updated_at=$4 WHERE id=$5 AND state='sending' AND attempt_count=$6`,
        [exhausted ? 'failed' : 'pending',
          new Date(failedAt.getTime() + Math.max(telegramRetryDelayMs(row.attempt_count), failure.retryAfterMs)),
          failure.code, failedAt, row.id, row.attempt_count]);
      if (exhausted) summary.failed++; else summary.deferred++;
      continue;
    }
    // A receipt write failure leaves the lease intact; never immediately resend an uncertain success.
    await db.query(
      `UPDATE order_telegram_deliveries SET state='sent',sent_at=$1,message_id=$2,
       lease_until=NULL,last_failure_code=NULL,updated_at=$1
       WHERE id=$3 AND state='sending' AND attempt_count=$4`,
      [currentTime(), messageId, row.id, row.attempt_count]);
    summary.sent++;
  }
  return summary;
}
