import type { PoolClient } from 'pg';
import { expectedSyncAt } from './schedule.js';

export const galleryPilotAsins = ['B08FTSH6KP', 'B08F63WK3Z', 'B087JZ84K7', 'B083XCNJTV', 'B07BZ9NR18'] as const;
export const galleryPilotCategory = 'thuc-pham-cho-be';
export const galleryPilotMarker = 'gallery-pilot-v1';

// An explicit date arms one window only. Leaving the setting present never enables broad backfill.
export function galleryPilotDue(date: string, scheduled: boolean, now = new Date()) {
  const due = expectedSyncAt(now);
  const jstDate = new Date(due.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && scheduled && date === jstDate &&
    now.getTime() - due.getTime() <= 5 * 60000;
}

// Caller holds AMAZON_ACCESS_LOCK. A claim survives crashes and consumes the pilot before any request.
export async function claimGalleryPilot(connection: Pick<PoolClient, 'query'>, runId: number) {
  const prior = await connection.query('SELECT id FROM sync_runs WHERE note LIKE $1 LIMIT 1', [`%"galleryPilot":"${galleryPilotMarker}"%`]);
  if (prior.rows.length) return false;
  await connection.query('UPDATE sync_runs SET note=$2 WHERE id=$1', [runId, JSON.stringify({ galleryPilot: galleryPilotMarker })]);
  return true;
}
