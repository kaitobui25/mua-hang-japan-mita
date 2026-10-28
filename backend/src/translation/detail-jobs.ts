import type { PoolClient } from 'pg';
import { assessTranslation, logTranslationEvent } from './warnings.js';
import { db } from '../db/pool.js';
import { detailItems, detailSections, type DetailItem, type DetailText } from './detail-text.js';
import { hasEnglish, hasJapanese, LocalTranslationError, rejectUnsafeEnglishDetail, translateLocalString, validateAtomicTranslation } from './local.js';

type Run = { translated: number; failed: number; skipped: number; paused: boolean };
export function detailLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('DETAIL_TRANSLATION_LIMIT must be 1..1000');
  return limit;
}

/** Scan frozen snapshots once for English fields missed by the old Japanese-only
 * selector. The nullable checkpoint is added by schema.sql. Never update an
 * existing atomic item: its source, attempts, warnings and approval are durable.
 * The caller holds the same advisory lock as the detail translation worker. */
export async function backfillFrozenEnglishSlots(
  client: Pick<PoolClient, 'query'>, limit = 1000, signal?: AbortSignal
): Promise<{ scanned: number; inserted: number; remaining: boolean }> {
  const batchLimit = detailLimit(limit);
  const { rows } = await client.query<{ asin: string }>(`
    SELECT asin FROM local_detail_translations
    WHERE english_slots_backfilled_at IS NULL
    ORDER BY asin LIMIT $1`, [batchLimit + 1]);
  let scanned = 0, inserted = 0;
  for (const { asin } of rows.slice(0, batchLimit)) {
    if (signal?.aborted) break;
    await client.query('BEGIN');
    try {
      const { rows: snapshots } = await client.query<{ snapshot: DetailText; full_approved: boolean }>(`
        SELECT l.snapshot,EXISTS (SELECT 1 FROM product_translations t
          WHERE t.asin=l.asin AND t.locale='vi'
          AND (t.detail_approved OR (t.status='success' AND NOT t.name_only AND t.detail IS NOT NULL))) AS full_approved
        FROM local_detail_translations l
        WHERE l.asin=$1 AND l.english_slots_backfilled_at IS NULL
        FOR UPDATE OF l`, [asin]);
      const row = snapshots[0];
      if (row && !row.full_approved) {
        const source = row.snapshot;
        // Some legacy snapshots are partial JSON. Skip malformed entries safely.
        if (source && detailSections.every(section =>
          Array.isArray(source[section]) && source[section].every(s => typeof s === 'string')) &&
          source.specs && typeof source.specs === 'object' && !Array.isArray(source.specs)) {
          for (const item of detailItems(source)) {
            if (hasJapanese(item.source) || !hasEnglish(item.source)) continue;
            const saved = await client.query(`
              INSERT INTO local_detail_translation_items(asin,slot,source)
              VALUES($1,$2,$3) ON CONFLICT(asin,slot) DO NOTHING
              RETURNING slot`, [asin, item.slot, item.source]);
            inserted += saved.rowCount ?? saved.rows.length;
          }
        }
      }
      if (row) {
        await client.query(`
          UPDATE local_detail_translations SET english_slots_backfilled_at=now()
          WHERE asin=$1 AND english_slots_backfilled_at IS NULL`, [asin]);
        scanned++;
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  return { scanned, inserted, remaining: (rows.length > batchLimit || Boolean(signal?.aborted)) };
}

export async function translatePendingDetails(options: {
  limit?: number; signal?: AbortSignal; log?: typeof logTranslationEvent; translate?: typeof translateLocalString;
  connect?: () => Promise<Pick<PoolClient, 'query' | 'release'>>;
} = {}): Promise<Run> {
  const limit = detailLimit(options.limit ?? process.env.DETAIL_TRANSLATION_LIMIT ?? 100);
  const result: Run = { translated: 0, failed: 0, skipped: 0, paused: false };
  const client = await (options.connect ?? (() => db.connect()))();
  let acquired = false;
  try {
    acquired = Boolean((await client.query('SELECT pg_try_advisory_lock(70400301) AS acquired')).rows[0]?.acquired);
    if (!acquired) return { ...result, paused: true };
    // Catch up existing immutable snapshots before the normal pending-item
    // selection. A durable checkpoint prevents rescanning completed products.
    await backfillFrozenEnglishSlots(client, 1000, options.signal);
    if (options.signal?.aborted) return { ...result, paused: true };
    // Completed detail is permanent, including legacy full translations. A local
    // snapshot freezes the source once; changed Amazon content never replaces it.
    const { rows } = await client.query<{ asin: string; brand: string | null; snapshot: DetailText }>(`
      SELECT p.asin,p.brand,COALESCE(l.snapshot,jsonb_build_object(
        'features',d.features,'ingredients',d.ingredients,'usage',d.usage,
        'cautions',d.cautions,'specs',d.specs)) AS snapshot
      FROM products p JOIN product_details d ON d.asin=p.asin
      LEFT JOIN local_detail_translations l ON l.asin=p.asin
      WHERE NOT EXISTS (SELECT 1 FROM product_translations t WHERE t.asin=p.asin
        AND t.locale='vi' AND (t.detail_approved OR (t.status='success' AND NOT t.name_only AND t.detail IS NOT NULL)))
      AND (l.asin IS NULL OR EXISTS (SELECT 1 FROM local_detail_translation_items i
        WHERE i.asin=p.asin AND (i.translated IS NULL OR i.warning) AND i.attempts<3 AND (i.retry_after IS NULL OR i.retry_after<=now())))
      ORDER BY l.created_at NULLS FIRST,p.asin LIMIT $1`, [limit]);
    for (const row of rows) {
      if (options.signal?.aborted) { result.paused = true; break; }
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO local_detail_translations(asin,snapshot,english_slots_backfilled_at) VALUES($1,$2,now())
          ON CONFLICT(asin) DO NOTHING`, [row.asin, JSON.stringify(row.snapshot)]);
        for (const item of detailItems(row.snapshot)) {
          await client.query(`INSERT INTO local_detail_translation_items(asin,slot,source) VALUES($1,$2,$3)
            ON CONFLICT(asin,slot) DO NOTHING`, [row.asin, item.slot, item.source]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      const { rows: items } = await client.query<DetailItem>(`SELECT slot,source,translated,attempts,warning FROM local_detail_translation_items
        WHERE asin=$1 AND (translated IS NULL OR warning) AND attempts<3 AND (retry_after IS NULL OR retry_after<=now()) ORDER BY slot`, [row.asin]);
      for (const item of items) {
        if (options.signal?.aborted) return { ...result, paused: true };
        // Reserve before inference so a crash still consumes the attempt.
        const reserved = await client.query<{ attempts: number }>(`UPDATE local_detail_translation_items
          SET attempts=attempts+1,updated_at=now() WHERE asin=$1 AND slot=$2
          AND attempts<3 AND (translated IS NULL OR warning) RETURNING attempts`, [row.asin, item.slot]);
        if (!reserved.rows.length) continue;
        const attempt = reserved.rows[0].attempts;
        try {
          const output = await (options.translate ?? translateLocalString)(item.source, { signal: options.signal, brand: row.brand });
          const { text, issues } = assessTranslation(item.source, output.text,
            (source, candidate) => validateAtomicTranslation(source, candidate, row.brand));
          rejectUnsafeEnglishDetail(item.source, issues);
          // Each accepted string is committed independently, before the next request.
          await client.query(`UPDATE local_detail_translation_items SET translated=$3,model=$4,
            warning=$5,issues=$6,retry_after=CASE WHEN $5 THEN now()+interval '12 hours' ELSE NULL END,
            error_code=NULL,updated_at=now()
            WHERE asin=$1 AND slot=$2 AND (translated IS NULL OR warning)`,
          [row.asin, item.slot, text, output.model, issues.length>0, JSON.stringify(issues)]);
          await (options.log ?? logTranslationEvent)({ asin: row.asin, locale: 'vi', field: item.slot, engine: 'gguf',
            model: output.model, attempt, original: item.source, candidate: text, issues,
            result: issues.length ? 'warning' : 'success' });
          result.translated++;
        } catch (error) {
          if (!(error instanceof LocalTranslationError) && !(error instanceof Error && error.message === 'invalid_output')) throw error;
          if (options.signal?.aborted) return { ...result, paused: true };
          result.failed++;
          await client.query(`UPDATE local_detail_translation_items SET retry_after=now()+interval '12 hours',error_code=$3,updated_at=now()
            WHERE asin=$1 AND slot=$2 AND (translated IS NULL OR warning)`, [row.asin, item.slot, error.message]);
          await (options.log ?? logTranslationEvent)({ asin: row.asin, locale: 'vi', field: item.slot, engine: 'gguf', model: null,
            attempt, original: item.source, issues: [error.message], result: 'failed' });
          if (error instanceof LocalTranslationError && error.retryable) return { ...result, paused: true };
        }
      }
    }
    return result;
  } finally {
    try { if (acquired) await client.query('SELECT pg_advisory_unlock(70400301)'); }
    finally { client.release(); }
  }
}
