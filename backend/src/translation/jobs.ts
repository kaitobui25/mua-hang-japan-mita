import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { translateProduct, translateNamesBatch, readFreeQuota, TranslationUnavailable, type ProductText } from './openrouter.js';
import type { PoolClient } from 'pg';

type SourceRow = {
  asin: string; name: string; brand: string | null;
  features: string[] | null; ingredients: string[] | null; usage: string[] | null;
  specs: Record<string, string> | null; cautions: string[] | null;
  source_hash: string | null; status: string | null; name_only: boolean | null;
  detail_attempted_at: Date | null;
};

export function sourceText(row: Pick<SourceRow, 'name' | 'brand' | 'features' | 'ingredients' | 'usage' | 'specs' | 'cautions'>): ProductText {
  return {
    name: row.name, brand: row.brand, features: row.features ?? [],
    ingredients: row.ingredients ?? [], usage: row.usage ?? [],
    specs: row.specs ?? {}, cautions: row.cautions ?? []
  };
}

export function sourceHash(text: ProductText): string {
  return createHash('sha256').update(JSON.stringify(text)).digest('hex');
}

/** A translated title stays valid when only scraped specifications change. */
export function nameHash(row: { name: string; brand?: string | null }): string {
  return sourceHash({ name: row.name, brand: row.brand ?? null,
    features: [], ingredients: [], usage: [], specs: {}, cautions: [] });
}

const currentTextSql = `SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions
  FROM products p LEFT JOIN product_details d ON d.asin=p.asin WHERE p.asin=$1`;

/** Store a translation only while its observed source is still current. */
export async function saveTranslationIfCurrent(
  asin: string, hash: string, output: { text: ProductText; model: string }, connection: PoolClient
): Promise<boolean> {
  await connection.query('BEGIN');
  try {
    // Scraper upserts lock this same products row before updating detail.
    const latest = await connection.query<SourceRow>(`${currentTextSql} FOR UPDATE OF p`, [asin]);
    if (!latest.rows[0] || sourceHash(sourceText(latest.rows[0])) !== hash) {
      await connection.query('ROLLBACK');
      return false;
    }
    await connection.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,translated_at,name_only,detail_attempted_at)
      VALUES($1,'vi',$2,$3,$4,$5,'success',now(),false,now())
      ON CONFLICT(asin,locale) DO UPDATE SET
        name=EXCLUDED.name,detail=EXCLUDED.detail,source_hash=EXCLUDED.source_hash,
        model=EXCLUDED.model,status='success',name_only=false,translated_at=now(),
        detail_attempted_at=now(),updated_at=now()`,
      [asin, output.text.name, JSON.stringify(output.text), hash, output.model]);
    await connection.query('COMMIT');
    return true;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

/** Atomically accept matching names; never downgrade a current complete translation. */
export async function saveNamesIfCurrent(
  entries: Array<{ asin: string; hash: string; name: string }>, model: string, connection: PoolClient
): Promise<number> {
  await connection.query('BEGIN');
  try {
    const { rows } = await connection.query<SourceRow>(`SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions,
        t.source_hash,t.status,t.name_only FROM products p
        LEFT JOIN product_details d ON d.asin=p.asin
        LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
        WHERE p.asin=ANY($1::varchar(10)[]) ORDER BY p.asin FOR UPDATE OF p`,
    [entries.map(entry => entry.asin)]);
    const latest = new Map(rows.map(row => [row.asin, row]));
    let saved = 0;
    for (const entry of entries) {
      const row = latest.get(entry.asin);
      if (!row || nameHash(row) !== entry.hash) continue;
      if (row.status === 'success' && (
        row.name_only && row.source_hash === entry.hash ||
        !row.name_only && row.source_hash === sourceHash(sourceText(row)))) continue;
      await connection.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,translated_at,name_only)
        VALUES($1,'vi',$2,NULL,$3,$4,'success',now(),true)
        ON CONFLICT(asin,locale) DO UPDATE SET name=EXCLUDED.name,detail=NULL,
          source_hash=EXCLUDED.source_hash,model=EXCLUDED.model,status='success',
          name_only=true,translated_at=now(),updated_at=now()`,
      [entry.asin, entry.name, entry.hash, model]);
      saved++;
    }
    await connection.query('COMMIT');
    return saved;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
}

/** Full description failures cannot revoke an already validated Vietnamese title. */
export async function markDetailTranslationFailed(asin: string, hash: string, connection: Pick<PoolClient, 'query'>) {
  await connection.query(`INSERT INTO product_translations(asin,locale,source_hash,status,detail_attempted_at)
    VALUES($1,'vi',$2,'failed',now())
    ON CONFLICT(asin,locale) DO UPDATE SET
      status=CASE WHEN product_translations.name_only AND product_translations.name IS NOT NULL
        THEN 'success' ELSE 'failed' END,
      source_hash=CASE WHEN product_translations.name_only AND product_translations.name IS NOT NULL
        THEN product_translations.source_hash ELSE EXCLUDED.source_hash END,
      detail_attempted_at=now(),updated_at=now()`, [asin, hash]);
}

/** Products never attempted should not be starved by the same failing details. */
export function prioritizeDetailCandidates<T extends { detail_attempted_at?: Date | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (a.detail_attempted_at?.getTime() ?? 0) - (b.detail_attempted_at?.getTime() ?? 0));
}

export function translationFailureStopsBatch(error: unknown): boolean {
  if (!(error instanceof TranslationUnavailable)) return true;
  if (error.causes.some(reason => ['missing_api_key', 'unauthorized_api_key', 'free_quota_exhausted', 'rate_limit_platform', 'quota_check_unavailable', 'account_budget_exhausted', 'providers_temporarily_unavailable'].includes(reason))) return true;
  // An oversized or unusually formatted product cannot prevent unrelated text being translated.
  if (error.causes.includes('source_too_large')) return false;
  return false;
}

export type TranslationRun = { translated: number; failed: number; skipped: number; paused: boolean };

/** PC worker only. At most 30 translations per run to avoid exhausting free daily quota. */
export async function translatePendingProducts(limit = 30): Promise<TranslationRun> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Translation deferred: OPENROUTER_API_KEY not configured on PC worker.');
    return { translated: 0, failed: 0, skipped: 0, paused: true };
  }
  // One translator across manual CLI, scheduled PC workers and remote DB-tunnel
  // connections. Session-scoped PG lock is released even when inference fails.
  const lock = await db.connect();
  let acquired = false;
  try {
    const result = await lock.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(70400300) AS acquired');
    acquired = Boolean(result.rows[0]?.acquired);
    if (!acquired) {
      console.log('Translation deferred: another worker holds the quota lock.');
      return { translated: 0, failed: 0, skipped: 0, paused: true };
    }
  let quota;
  try { quota = await readFreeQuota(); }
  catch (error) {
    console.error('Translation deferred: OpenRouter quota status unavailable.');
    return { translated: 0, failed: 0, skipped: 0, paused: true };
  }
  // Reserve a few calls for the owner; free models have a shared UTC daily limit.
  let remaining = Math.max(0, quota.remaining - 2);
  if (remaining === 0) {
    console.log('Translation deferred: free daily quota exhausted.');
    return { translated: 0, failed: 0, skipped: 0, paused: true };
  }
  let previousRequestAt = 0;
  const unavailableModels = new Set<string>();
  const beforeRequest = async () => {
    if (remaining <= 0) throw new TranslationUnavailable(['free_quota_exhausted']);
    const delay = Math.max(0, 3200 - (Date.now() - previousRequestAt));
    if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
    // Consume budget even on HTTP errors. 20 requests/minute max, shared across all :free models.
    remaining--;
    previousRequestAt = Date.now();
  };
  const { rows } = await lock.query<SourceRow>(`SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions,
      t.source_hash,t.status,t.name_only,t.detail_attempted_at FROM products p
      LEFT JOIN product_details d ON d.asin=p.asin
      LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      LEFT JOIN product_detail_queue q ON q.asin=p.asin AND q.category_slug=p.category_slug
      -- Avoid spending scarce free quota on text about to change in an active backfill.
      WHERE (q.asin IS NULL OR q.state <> 'pending'
        OR NOT EXISTS (SELECT 1 FROM sync_runs WHERE state='running' AND started_at > now() - interval '6 hours'))
      AND (t.status IS DISTINCT FROM 'failed' OR t.updated_at < now() - interval '6 hours')
      ORDER BY CASE WHEN t.status='failed' THEN 1 ELSE 0 END,
        length(p.name) ASC, COALESCE(t.updated_at, '1970-01-01'::timestamptz) ASC, p.asin ASC`);
  let translated = 0, failed = 0, skipped = 0, paused = false;
  // First, translate short titles in groups of five. Full detail translations
  // remain a separate stage; no made-up descriptions are persisted.
  const candidates = rows.filter(row => !(row.status === 'success' && (
    row.name_only ? row.source_hash === nameHash(row) : row.source_hash === sourceHash(sourceText(row)))));
  const batchSize = 5;
  const titleBudget = limit <= 5 ? limit : Math.max(5, Math.floor(limit * 0.7));
  for (let index = 0; index < candidates.length && translated + failed < titleBudget; index += batchSize) {
    const batch = candidates.slice(index, index + Math.min(batchSize, titleBudget - translated - failed));
    if (!batch.length) break;
    try {
      const result = await translateNamesBatch(batch.map(row => ({ asin: row.asin, name: row.name, brand: row.brand })),
        { beforeRequest, unavailableModels });
      const entries = batch.map(row => ({ asin: row.asin,
        hash: nameHash(row), name: result.names.get(row.asin)! }));
      translated += await saveNamesIfCurrent(entries, result.model, lock);
      console.log(`Translated names: ${translated} in current batch`);
    } catch (error) {
      if (error instanceof TranslationUnavailable && error.causes.includes('free_quota_exhausted')) { paused = true; break; }
      failed += batch.length;
      console.error(`Title batch unavailable: ${error instanceof TranslationUnavailable ? error.causes.join(', ') : 'unavailable'}`);
      // A malformed/limited batch is retried on a later sweep, not every two hours.
      // This prevents one incompatible title from starving unrelated descriptions.
      for (const row of batch) {
        await lock.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name_only)
          VALUES($1,'vi',$2,'failed',true)
          ON CONFLICT(asin,locale) DO UPDATE SET status='failed',source_hash=EXCLUDED.source_hash,
          name_only=true,updated_at=now()
          WHERE product_translations.status <> 'success' OR product_translations.source_hash <> EXCLUDED.source_hash`,
        [row.asin, nameHash(row)]);
      }
      if (translationFailureStopsBatch(error)) { paused = true; break; }
    }
  }
  if (translated + failed >= limit || remaining <= 0) {
    console.log(`Translation: ${translated} title(s) updated, ${failed} unavailable this run; details deferred`);
    return { translated, failed, skipped, paused: paused || remaining <= 0 };
  }
  for (const row of prioritizeDetailCandidates(rows)) {
    // Reload before spending a free inference request: a running backfill may
    // have updated this product since the batch-wide SELECT above.
    const latest = await lock.query<SourceRow>(currentTextSql, [row.asin]);
    if (!latest.rows[0]) continue;
    const source = sourceText(latest.rows[0]);
    const hash = sourceHash(source);
    if (row.status === 'success' && !row.name_only && row.source_hash === hash) { skipped++; continue; }
    if (translated + failed >= limit) break;
    try {
      const result = await translateProduct(source, { beforeRequest, unavailableModels });
      const saved = await saveTranslationIfCurrent(row.asin, hash, result, lock);
      if (!saved) { skipped++; continue; }
      translated++;
      if (translated % 5 === 0) console.log(`Translation: ${translated} ASINs updated in this batch`);
    } catch (error) {
      if (error instanceof TranslationUnavailable && error.causes.includes('free_quota_exhausted')) { paused = true; break; }
      failed++;
      await markDetailTranslationFailed(row.asin, hash, lock);
      // Never overwrite a previous valid translation or output raw remote errors.
      console.error(`Translation failed for ASIN ${row.asin}: ${error instanceof TranslationUnavailable ? error.causes.join(', ') : 'unavailable'}`);
      // Shared quota/network outage: defer the remaining batch. Product-specific errors: continue.
      if (translationFailureStopsBatch(error)) { paused = true; break; }
    }
  }
  console.log(`Translation: ${translated} updated, ${failed} failed, ${skipped} up-to-date`);
  return { translated, failed, skipped, paused: paused || remaining <= 0 };
  } finally {
    try { if (acquired) await lock.query('SELECT pg_advisory_unlock(70400300)'); }
    finally { lock.release(); }
  }
}
