import type { PoolClient } from 'pg';
import { expectedSyncAt } from './schedule.js';

// Hold the same connection's mutex across the gate check and all Amazon requests.
export const AMAZON_ACCESS_LOCK = 70400200;
type Connection = Pick<PoolClient, 'query'>;

/** 04:00 JST on the following calendar day, even before today's 04:00. */
export function nextAmazonRetryAt(now = new Date()): Date {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 19));
}

export async function recordAmazonPause(connection: Connection, reason: string) {
  await connection.query(`INSERT INTO source_access_blocks(source,reason,retry_after_at)
    VALUES('amazon.co.jp',$1,$2)
    ON CONFLICT(source) DO UPDATE SET reason=EXCLUDED.reason,blocked_at=now(),
      retry_after_at=EXCLUDED.retry_after_at`, [reason, nextAmazonRetryAt()]);
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
