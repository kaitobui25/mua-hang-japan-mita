// Session-wide Amazon mutex shared by discovery/backfill and Admin imports.
// Hold this on the same PostgreSQL connection until all source requests finish.
import type { PoolClient } from 'pg';
export const AMAZON_ACCESS_LOCK = 70400200;

type Connection = Pick<PoolClient, 'query'>;

/** A CAPTCHA/denial stops Amazon requests.
 * Persist the first 30-second deadline for operator status across restarts.
 * It never triggers translation, unblocks Amazon, or retries requests.
 */
export async function recordAmazonPause(connection: Connection, reason: string) {
  await connection.query(`INSERT INTO source_access_blocks(source,reason,continuation_due_at)
    VALUES('amazon.co.jp',$1,now()+interval '30 seconds')
    ON CONFLICT(source) DO UPDATE SET
      reason=EXCLUDED.reason,blocked_at=now(),
      continuation_due_at=COALESCE(source_access_blocks.continuation_due_at,EXCLUDED.continuation_due_at)`, [reason]);
}

/** Make older human-blocked ASINs visible to the timeout status monitor
 * without claiming they have been manually verified.
 */
export async function seedAmazonPause(connection: Connection) {
  // Serialize startup seeding with owner ACK. Otherwise a stale SELECT could
  // recreate the source-wide gate after the owner has acknowledged it.
  await connection.query('SELECT pg_advisory_lock($1)', [AMAZON_ACCESS_LOCK]);
  try {
    await connection.query(`INSERT INTO source_access_blocks(source,reason,continuation_due_at)
      SELECT 'amazon.co.jp','Existing Amazon queue requires manual verification',now()+interval '30 seconds'
      WHERE EXISTS(SELECT 1 FROM product_detail_queue WHERE state='needs_human')
      ON CONFLICT(source) DO UPDATE SET
        continuation_due_at=COALESCE(source_access_blocks.continuation_due_at,EXCLUDED.continuation_due_at)`);
    await connection.query(`UPDATE source_access_blocks SET continuation_due_at=now()+interval '30 seconds'
      WHERE source='amazon.co.jp' AND continuation_due_at IS NULL AND timeout_recorded_at IS NULL`);
  } finally {
    await connection.query('SELECT pg_advisory_unlock($1)', [AMAZON_ACCESS_LOCK]);
  }
}

/** Atomic one-shot claim; races with manual ACK safely and survives worker restarts. */
export async function claimDueAmazonContinuation(connection: Connection): Promise<boolean> {
  const result = await connection.query(`UPDATE source_access_blocks
    SET timeout_recorded_at=now() WHERE source='amazon.co.jp'
      AND continuation_due_at<=now() AND timeout_recorded_at IS NULL
    RETURNING source`);
  return (result.rowCount ?? 0) > 0;
}
