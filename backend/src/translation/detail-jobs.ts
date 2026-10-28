import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import { detailItems, type DetailItem, type DetailText } from './detail-text.js';
import { LocalTranslationError, translateLocalString, validateAtomicTranslation } from './local.js';

type Run = { translated: number; failed: number; skipped: number; paused: boolean };
export function detailLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('DETAIL_TRANSLATION_LIMIT must be 1..1000');
  return limit;
}

export async function translatePendingDetails(options: {
  limit?: number; signal?: AbortSignal; translate?: typeof translateLocalString;
  connect?: () => Promise<Pick<PoolClient, 'query' | 'release'>>;
} = {}): Promise<Run> {
  const limit = detailLimit(options.limit ?? process.env.DETAIL_TRANSLATION_LIMIT ?? 100);
  const result: Run = { translated: 0, failed: 0, skipped: 0, paused: false };
  const client = await (options.connect ?? (() => db.connect()))();
  let acquired = false;
  try {
    acquired = Boolean((await client.query('SELECT pg_try_advisory_lock(70400301) AS acquired')).rows[0]?.acquired);
    if (!acquired) return { ...result, paused: true };
    // Completed detail is permanent, including legacy full translations. A local
    // snapshot freezes the source once; changed Amazon content never replaces it.
    const { rows } = await client.query<{ asin: string; snapshot: DetailText }>(`
      SELECT p.asin,COALESCE(l.snapshot,jsonb_build_object(
        'features',d.features,'ingredients',d.ingredients,'usage',d.usage,
        'cautions',d.cautions,'specs',d.specs)) AS snapshot
      FROM products p JOIN product_details d ON d.asin=p.asin
      LEFT JOIN local_detail_translations l ON l.asin=p.asin
      WHERE NOT EXISTS (SELECT 1 FROM product_translations t WHERE t.asin=p.asin
        AND t.locale='vi' AND t.status='success' AND NOT t.name_only AND t.detail IS NOT NULL)
      AND (l.asin IS NULL OR EXISTS (SELECT 1 FROM local_detail_translation_items i
        WHERE i.asin=p.asin AND i.translated IS NULL AND (i.retry_after IS NULL OR i.retry_after<=now())))
      ORDER BY l.created_at NULLS FIRST,p.asin LIMIT $1`, [limit]);
    for (const row of rows) {
      if (options.signal?.aborted) { result.paused = true; break; }
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO local_detail_translations(asin,snapshot) VALUES($1,$2)
          ON CONFLICT(asin) DO NOTHING`, [row.asin, JSON.stringify(row.snapshot)]);
        for (const item of detailItems(row.snapshot)) {
          await client.query(`INSERT INTO local_detail_translation_items(asin,slot,source) VALUES($1,$2,$3)
            ON CONFLICT(asin,slot) DO NOTHING`, [row.asin, item.slot, item.source]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      const { rows: items } = await client.query<DetailItem>(`SELECT slot,source,translated FROM local_detail_translation_items
        WHERE asin=$1 AND translated IS NULL AND (retry_after IS NULL OR retry_after<=now()) ORDER BY slot`, [row.asin]);
      for (const item of items) {
        if (options.signal?.aborted) return { ...result, paused: true };
        try {
          const output = await (options.translate ?? translateLocalString)(item.source, { signal: options.signal });
          const text = validateAtomicTranslation(item.source, output.text);
          // Each accepted string is committed independently, before the next request.
          await client.query(`UPDATE local_detail_translation_items SET translated=$3,model=$4,
            attempts=attempts+1,retry_after=NULL,error_code=NULL,updated_at=now()
            WHERE asin=$1 AND slot=$2 AND translated IS NULL`, [row.asin, item.slot, text, output.model]);
          result.translated++;
        } catch (error) {
          if (!(error instanceof LocalTranslationError)) throw error;
          if (options.signal?.aborted) return { ...result, paused: true };
          result.failed++;
          await client.query(`UPDATE local_detail_translation_items SET attempts=attempts+1,
            retry_after=now()+interval '12 hours',error_code=$3,updated_at=now()
            WHERE asin=$1 AND slot=$2 AND translated IS NULL`, [row.asin, item.slot, error.message]);
          if (error.retryable) return { ...result, paused: true };
        }
      }
    }
    return result;
  } finally {
    try { if (acquired) await client.query('SELECT pg_advisory_unlock(70400301)'); }
    finally { client.release(); }
  }
}
