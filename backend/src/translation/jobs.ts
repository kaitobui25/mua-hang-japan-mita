import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { translateNamesBatch, packNameBatches, readFreeQuota, TranslationUnavailable, type ProductText } from './openrouter.js';
import type { PoolClient } from 'pg';

type SourceRow = {
  asin: string; name: string; brand: string | null;
  features: string[] | null; ingredients: string[] | null; usage: string[] | null;
  specs: Record<string, string> | null; cautions: string[] | null;
  source_hash: string | null; status: string | null; name_only: boolean | null;
  detail_attempted_at: Date | null; translated_name?: string | null;
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
        name=COALESCE(product_translations.name,EXCLUDED.name),detail=EXCLUDED.detail,source_hash=EXCLUDED.source_hash,
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

/** Atomically accept the first valid name; never retranslate a successful ASIN. */
export async function saveNamesIfCurrent(
  entries: Array<{ asin: string; hash: string; name: string }>, model: string, connection: PoolClient
): Promise<number> {
  await connection.query('BEGIN');
  try {
    const { rows } = await connection.query<SourceRow>(`SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions,
        t.source_hash,t.status,t.name_only,t.name AS translated_name FROM products p
        LEFT JOIN product_details d ON d.asin=p.asin
        LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
        WHERE p.asin=ANY($1::varchar(10)[]) ORDER BY p.asin FOR UPDATE OF p`,
    [entries.map(entry => entry.asin)]);
    const latest = new Map(rows.map(row => [row.asin, row]));
    let saved = 0;
    for (const entry of entries) {
      const row = latest.get(entry.asin);
      if (!row || nameHash(row) !== entry.hash) continue;
      if (row.status === 'success' && row.translated_name) continue;
      await connection.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,translated_at,name_only)
        VALUES($1,'vi',$2,NULL,$3,$4,'success',now(),true)
        ON CONFLICT(asin,locale) DO UPDATE SET name=EXCLUDED.name,detail=NULL,
          source_hash=EXCLUDED.source_hash,model=EXCLUDED.model,status='success',
          name_only=true,translated_at=now(),updated_at=now()
          WHERE product_translations.status <> 'success' OR product_translations.name IS NULL`,
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

/** Independent 05:00 JST PC worker: names only, until the catalog or free quota runs out. */
export async function translatePendingNames(): Promise<TranslationRun> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Name translation deferred: OPENROUTER_API_KEY not configured on PC.');
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
  const { rows } = await lock.query<SourceRow>(`SELECT p.asin,p.name,p.brand,
      t.source_hash,t.status,t.name_only,t.name AS translated_name FROM products p
      LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      WHERE t.status IS DISTINCT FROM 'success' OR t.name IS NULL
      ORDER BY CASE WHEN t.status='failed' THEN 1 ELSE 0 END,
        length(p.name) ASC, COALESCE(t.updated_at, '1970-01-01'::timestamptz) ASC, p.asin ASC`);
  let translated = 0, failed = 0, skipped = 0, paused = false;
  const markNamesFailed = async (rejected: SourceRow[]) => {
    for (const row of rejected) {
      await lock.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name_only)
        VALUES($1,'vi',$2,'failed',true)
        ON CONFLICT(asin,locale) DO UPDATE SET status='failed',source_hash=EXCLUDED.source_hash,
        name_only=true,updated_at=now()
        WHERE product_translations.status <> 'success' OR product_translations.name IS NULL`,
      [row.asin, nameHash(row)]);
    }
  };
  batches: for (const packed of packNameBatches(rows)) {
    // Bound recovery to two splits: at most seven attempts per packed batch.
    const pending = [{ batch: packed, depth: 0 }];
    while (pending.length) {
      const { batch, depth } = pending.shift()!;
      try {
        const result = await translateNamesBatch(batch.map(row => ({ asin: row.asin, name: row.name, brand: row.brand })),
          { beforeRequest, unavailableModels });
        const entries = batch.filter(row => result.names.has(row.asin)).map(row => ({ asin: row.asin,
          hash: nameHash(row), name: result.names.get(row.asin)! }));
        if (entries.length) translated += await saveNamesIfCurrent(entries, result.model, lock);
        const rejected = new Set(result.rejectedAsins);
        await markNamesFailed(batch.filter(row => rejected.has(row.asin)));
        failed += rejected.size;
        console.log(`Translated names: ${translated} in current batch`);
      } catch (error) {
        if (error instanceof TranslationUnavailable && error.causes.includes('name_batch_truncated') && batch.length > 1 && depth < 2) {
          // Discard the partial reply. Retry both halves through the same quota gate;
          // persist each validated half independently so later exhaustion cannot revoke it.
          const middle = Math.ceil(batch.length / 2);
          pending.unshift({ batch: batch.slice(0, middle), depth: depth + 1 },
            { batch: batch.slice(middle), depth: depth + 1 });
          continue;
        }
        if (error instanceof TranslationUnavailable && error.causes.includes('free_quota_exhausted')) { paused = true; break batches; }
        failed += batch.length;
        console.error(`Title batch unavailable: ${error instanceof TranslationUnavailable ? error.causes.join(', ') : 'unavailable'}`);
        // Failed names are eligible again at the next scheduled run.
        await markNamesFailed(batch);
        if (translationFailureStopsBatch(error)) { paused = true; break batches; }
      }
    }
  }
  console.log(`Name translation: ${translated} updated, ${failed} failed, ${skipped} source-changed`);
  return { translated, failed, skipped, paused: paused || remaining <= 0 };
  } finally {
    try { if (acquired) await lock.query('SELECT pg_advisory_unlock(70400300)'); }
    finally { lock.release(); }
  }
}
