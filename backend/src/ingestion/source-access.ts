import type { PoolClient } from 'pg';
import { expectedSyncAt } from './schedule.js';

// Catalog and interactive quotes have independent cooldowns and request mutexes.
// Always hold the matching mutex across the gate check and the source request.
export const AMAZON_ACCESS_LOCK = 70400200;
export const AMAZON_QUOTE_ACCESS_LOCK = 70400201;
export const AMAZON_QUOTE_SOURCE = 'amazon.co.jp:quote';
type Connection = Pick<PoolClient, 'query'>;

/** Persisted catalog pause: daily sync, imports and backfills only. */
export async function amazonPauseStatus(connection: Connection): Promise<{ retryAfterAt: string | null } | null> {
  const result = await connection.query(`SELECT retry_after_at FROM source_access_blocks WHERE source='amazon.co.jp'`);
  if (!result.rowCount) return null;
  const value: unknown = result.rows[0].retry_after_at;
  const retryAfterAt = value instanceof Date ? value.toISOString() :
    typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  return { retryAfterAt };
}

/** Customer-initiated quotes use their own persistent denial marker. */
export async function amazonQuotePauseStatus(connection: Connection): Promise<{ retryAfterAt: string | null } | null> {
  const result = await connection.query('SELECT retry_after_at FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE]);
  if (!result.rowCount) return null;
  const value: unknown = result.rows[0].retry_after_at;
  const retryAfterAt = value instanceof Date ? value.toISOString() :
    typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  return { retryAfterAt };
}

/** 04:00 JST on the following calendar day, even before today's 04:00. */
export function nextAmazonRetryAt(now = new Date()): Date {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 19));
}

export function amazonPauseUntil(now: Date, sourceRetryAfterAt?: string): Date {
  const nextWindow = nextAmazonRetryAt(now);
  // Source Retry-After wins over our daily schedule, but untrusted IPC input
  // never moves the gate earlier or creates an invalid timestamp.
  const sourceTime = sourceRetryAfterAt && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(sourceRetryAfterAt)
    ? Date.parse(sourceRetryAfterAt) : NaN;
  return new Date(Number.isFinite(sourceTime) ? Math.max(nextWindow.getTime(), sourceTime) : nextWindow.getTime());
}
export async function recordAmazonPause(connection: Connection, reason: string, sourceRetryAfterAt?: string) {
  await connection.query(`INSERT INTO source_access_blocks(source,reason,retry_after_at)
    VALUES('amazon.co.jp',$1,$2)
    ON CONFLICT(source) DO UPDATE SET reason=EXCLUDED.reason,blocked_at=now(),
      retry_after_at=GREATEST(source_access_blocks.retry_after_at,EXCLUDED.retry_after_at)`,
    [reason, amazonPauseUntil(new Date(), sourceRetryAfterAt)]);
}

/** Quote-originated access denials do not pause catalog jobs. Never retry a denied quote immediately. */
export async function recordAmazonQuotePause(connection: Connection, reason: string, sourceRetryAfterAt?: string) {
  await connection.query(`INSERT INTO source_access_blocks(source,reason,retry_after_at)
    VALUES($1,$2,$3)
    ON CONFLICT(source) DO UPDATE SET reason=EXCLUDED.reason,blocked_at=now(),
      retry_after_at=GREATEST(source_access_blocks.retry_after_at,EXCLUDED.retry_after_at)`,
    [AMAZON_QUOTE_SOURCE, reason, amazonPauseUntil(new Date(), sourceRetryAfterAt)]);
}

/** A quote may make ONE new source request after its own cooldown expires.
 * Reserve the next window atomically before I/O to prevent concurrent probing.
 * The catalog cooldown never enters this decision.
 */
export async function amazonQuoteGate(connection: Connection, now = new Date()): Promise<boolean> {
  const block = await connection.query('SELECT retry_after_at FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE]);
  if (!block.rowCount) return true;
  const claim = await connection.query(`UPDATE source_access_blocks SET retry_after_at=$3
    WHERE source=$1 AND retry_after_at IS NOT NULL AND retry_after_at<=$2 RETURNING source`,
    [AMAZON_QUOTE_SOURCE, now, nextAmazonRetryAt(now)]);
  return (claim.rowCount ?? 0) > 0;
}

/** A successfully read quote source may clear only its own reservation. */
export async function completeAmazonQuoteReentry(connection: Connection) {
  await connection.query('DELETE FROM source_access_blocks WHERE source=$1', [AMAZON_QUOTE_SOURCE]);
}

/** Caller owns AMAZON_ACCESS_LOCK. Only the scheduled window may claim a due gate.
 * Reserve tomorrow before requesting: a crash cannot expose imports to probing.
 */
export async function amazonGate(connection: Connection, scheduled = false, now = new Date()): Promise<boolean> {
  const block = await connection.query(`SELECT retry_after_at FROM source_access_blocks WHERE source='amazon.co.jp'`);
  if (!block.rowCount) return true;
  const windowAge = now.getTime() - expectedSyncAt(now).getTime();
  if (!scheduled || windowAge < 0 || windowAge > 5 * 60 * 1000) return false;
  const claim = await connection.query(`UPDATE source_access_blocks SET retry_after_at=$2
    WHERE source='amazon.co.jp' AND retry_after_at<=$1 RETURNING source`, [now, nextAmazonRetryAt(now)]);
  return (claim.rowCount ?? 0) > 0;
}

/** Called under the source mutex after an error-free completed re-entry. */
export async function completeAmazonReentry(connection: Connection) {
  await connection.query(`DELETE FROM source_access_blocks WHERE source='amazon.co.jp'`);
}
