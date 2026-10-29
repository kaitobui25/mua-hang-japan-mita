import { readTranslationPolicy } from './policy.js';
import { usableTranslation, logTranslationEvent } from './warnings.js';
import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { translateNamesBatch, packNameBatches, readFreeQuota, assertTranslation, TranslationUnavailable, type ProductText } from './openrouter.js';
import { hasEnglish, hasJapanese } from './local.js';
import type { PoolClient } from 'pg';

type SourceRow = {
  asin: string; name: string; brand: string | null;
  features: string[] | null; ingredients: string[] | null; usage: string[] | null;
  specs: Record<string, string> | null; cautions: string[] | null;
  source_hash: string | null; status: string | null; name_only: boolean | null;
  name_attempts?: number; name_source?: {name: string; brand: string | null}; detail_attempted_at: Date | null; translated_name?: string | null;
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

export type EnglishTitleCandidate = {
  asin: string; sourceName: string; brand: string | null; translatedName: string;
  sourceHash: string; sourceNameHash: string;
};

type AuditedTitleRow = {
  asin: string; source_name: string; brand: string | null;
  translated_name: string; source_hash: string; status: string;
  name_source: { name: string; brand: string | null } | null;
};

function titleCandidate(row: AuditedTitleRow): EnglishTitleCandidate {
  const source = row.name_source ?? { name: row.source_name, brand: row.brand };
  return { asin: row.asin, sourceName: source.name, brand: source.brand,
    translatedName: row.translated_name, sourceHash: row.source_hash, sourceNameHash: nameHash(source) };
}

/** Read-only, page-by-page audit of approved titles that still contain English. */
export async function auditEnglishSuccessTitles(
  connection: Pick<PoolClient, 'query'>, options: { afterAsin?: string; limit?: number } = {}
): Promise<{ candidates: EnglishTitleCandidate[]; nextAfterAsin: string | null }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
      (options.afterAsin && !/^[A-Z0-9]{10}$/.test(options.afterAsin))) throw new Error('invalid_audit_page');
  const { rows } = await connection.query<AuditedTitleRow>(`SELECT p.asin,p.name AS source_name,p.brand,
      t.name AS translated_name,t.source_hash,t.status,t.name_source
    FROM product_translations t JOIN products p ON p.asin=t.asin
    WHERE t.locale='vi' AND t.status='success' AND t.name IS NOT NULL AND p.asin>$1
    ORDER BY p.asin LIMIT $2`, [options.afterAsin ?? '', limit]);
  return {
    candidates: rows.filter(row => hasEnglish(row.translated_name) && !hasJapanese(row.translated_name))
      .map(titleCandidate),
    nextAfterAsin: rows.length === limit ? rows.at(-1)!.asin : null
  };
}

/** Only an explicitly reviewed replacement can change an already successful title.
 * Locks the source and uses compare-and-swap; full approved detail stays intact. */
export async function saveReviewedEnglishTitle(
  review: { candidate: EnglishTitleCandidate; replacement: string; approved: true },
  connection: Pick<PoolClient, 'query'>
): Promise<boolean> {
  if (review.approved !== true) throw new Error('review_required');
  const { candidate, replacement } = review;
  if (!candidate || !/^[A-Z0-9]{10}$/.test(candidate.asin) ||
      replacement.trim() === candidate.translatedName.trim() || hasJapanese(replacement)) {
    throw new Error('invalid_review');
  }
  await connection.query('BEGIN');
  try {
    const { rows } = await connection.query<AuditedTitleRow>(`SELECT p.asin,p.name AS source_name,p.brand,
        t.name AS translated_name,t.source_hash,t.status,t.name_source
      FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      WHERE p.asin=$1 FOR UPDATE OF p,t`, [candidate.asin]);
    const row = rows[0];
    const current = row && titleCandidate(row);
    if (!row || row.status !== 'success' || !hasEnglish(row.translated_name) ||
        !current || current.sourceName !== candidate.sourceName || current.brand !== candidate.brand ||
        current.translatedName !== candidate.translatedName || current.sourceHash !== candidate.sourceHash ||
        current.sourceNameHash !== candidate.sourceNameHash) {
      await connection.query('ROLLBACK');
      return false;
    }
    // Same checks as an ordinary title translation: numbers, units, codes, brand.
    assertTranslation({ name: current.sourceName, brand: current.brand,
      features: [], ingredients: [], usage: [], cautions: [], specs: {} },
    { name: replacement, features: [], ingredients: [], usage: [], cautions: [], specs: {} });
    const saved = await connection.query(`UPDATE product_translations
      SET name=$2,name_issues='[]'::jsonb,translated_at=now(),updated_at=now()
      WHERE asin=$1 AND locale='vi' AND status='success' AND name=$3 AND source_hash=$4
      RETURNING asin`, [candidate.asin, replacement.trim(), candidate.translatedName, candidate.sourceHash]);
    await connection.query('COMMIT');
    return Boolean(saved.rowCount);
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
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
    const saved = await connection.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,translated_at,name_only,detail_attempted_at,detail_approved)
      VALUES($1,'vi',$2,$3,$4,$5,'success',now(),false,now(),true)
      ON CONFLICT(asin,locale) DO UPDATE SET
        name=COALESCE(product_translations.name,EXCLUDED.name),detail=EXCLUDED.detail,source_hash=EXCLUDED.source_hash,
        model=EXCLUDED.model,status='success',name_only=false,detail_approved=true,translated_at=now(),
        detail_attempted_at=now(),updated_at=now()
        WHERE NOT product_translations.detail_approved AND NOT (product_translations.status='success' AND NOT product_translations.name_only AND product_translations.detail IS NOT NULL)
        RETURNING asin`,
      [asin, output.text.name, JSON.stringify(output.text), hash, output.model]);
    await connection.query('COMMIT');
    return Boolean(saved.rowCount);
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

/** Retry warned names; the first approved title is permanent. */
export async function saveNamesIfCurrent(
  entries: Array<{ asin: string; hash: string; name: string; issues?: string[] }>, model: string, connection: PoolClient
): Promise<number> {
  await connection.query('BEGIN');
  try {
    const { rows } = await connection.query<SourceRow>(`SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions,
        t.source_hash,t.status,t.name_only,t.name_source,t.name AS translated_name FROM products p
        LEFT JOIN product_details d ON d.asin=p.asin
        LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
        WHERE p.asin=ANY($1::varchar(10)[]) ORDER BY p.asin FOR UPDATE OF p`,
    [entries.map(entry => entry.asin)]);
    const latest = new Map(rows.map(row => [row.asin, row]));
    const policy = await readTranslationPolicy(connection);
    let saved = 0;
    for (const entry of entries) {
      if (!/^[A-Z0-9]{10}$/.test(entry.asin)) throw new Error('invalid_asin');
      usableTranslation(entry.name, 600);
      if (policy.validateTranslationSemantics && entry.issues?.length) continue;
      const row = latest.get(entry.asin);
      if (!row || nameHash(row.name_source ?? row) !== entry.hash) continue;
      if (row.status === 'success' && row.translated_name) continue;
      await connection.query(`INSERT INTO product_translations(asin,locale,name,source_hash,model,status,translated_at,name_only,name_issues)
        VALUES($1,'vi',$2,$3,$4,$5,now(),true,$6)
        ON CONFLICT(asin,locale) DO UPDATE SET name=EXCLUDED.name,
          source_hash=CASE WHEN product_translations.detail IS NULL THEN EXCLUDED.source_hash ELSE product_translations.source_hash END,
          model=EXCLUDED.model,status=EXCLUDED.status,name_issues=EXCLUDED.name_issues,
          translated_at=now(),updated_at=now()
          WHERE product_translations.status <> 'success' OR product_translations.name IS NULL`,
      [entry.asin, entry.name, entry.hash, model, entry.issues?.length ? 'warning' : 'success', JSON.stringify(entry.issues ?? [])]);
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
      status=CASE WHEN product_translations.status IN ('success','warning') THEN product_translations.status ELSE 'failed' END,
      source_hash=CASE WHEN product_translations.status IN ('success','warning')
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
export async function translatePendingNames(options: { log?: typeof logTranslationEvent; connect?: () => Promise<PoolClient> } = {}): Promise<TranslationRun> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Name translation deferred: OPENROUTER_API_KEY not configured on PC.');
    return { translated: 0, failed: 0, skipped: 0, paused: true };
  }
  // One translator across manual CLI, scheduled PC workers and remote DB-tunnel
  // connections. Session-scoped PG lock is released even when inference fails.
  const lock = await (options.connect ?? (() => db.connect()))();
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
  const { rows } = await lock.query<SourceRow>(`SELECT p.asin,COALESCE(t.name_source->>'name',p.name) AS name,
      CASE WHEN t.name_source IS NOT NULL THEN t.name_source->>'brand' ELSE p.brand END AS brand,
      t.name_attempts,t.source_hash,t.status,t.name_only,t.name_source,t.name AS translated_name FROM products p
      LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      WHERE (t.status IS DISTINCT FROM 'success' OR t.name IS NULL) AND COALESCE(t.name_attempts,0)<3
      ORDER BY CASE WHEN t.status='failed' THEN 1 ELSE 0 END,
        length(p.name) ASC, COALESCE(t.updated_at, '1970-01-01'::timestamptz) ASC, p.asin ASC`);
  let translated = 0, failed = 0, skipped = 0, paused = false;
  const markNamesFailed = async (rejected: SourceRow[]) => {
    for (const row of rejected) {
      await lock.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name_only)
        VALUES($1,'vi',$2,'failed',true)
        ON CONFLICT(asin,locale) DO UPDATE SET status=CASE WHEN product_translations.status='warning' THEN 'warning' ELSE 'failed' END,updated_at=now()
        WHERE product_translations.status <> 'success' OR product_translations.name IS NULL`,
      [row.asin, nameHash(row)]);
    }
  };
  const attempts = new Map(rows.map(row => [row.asin, row.name_attempts ?? 0]));
  batches: for (const packed of packNameBatches(rows)) {
    // At most two split levels, still bounded by three requests per ASIN.
    const pending = [{ batch: packed, depth: 0 }];
    while (pending.length) {
      let { batch, depth } = pending.shift()!;
      batch = batch.filter(row => (attempts.get(row.asin) ?? 0)<3);
      if (!batch.length) continue;
      try {
        const result = await translateNamesBatch(batch.map(row => ({ asin: row.asin, name: row.name, brand: row.brand })),
          { beforeRequest: async () => {
            if (batch.some(row => (attempts.get(row.asin) ?? 0)>=3)) throw new TranslationUnavailable(['attempt_cap']);
            await beforeRequest();
            await lock.query('BEGIN');
            try {
              for (const row of batch) {
                const reserved = await lock.query<{ name_attempts: number }>(`INSERT INTO product_translations
                  (asin,locale,source_hash,status,name_only,name_attempts,name_source)
                  VALUES($1,'vi',$2,'pending',true,1,$3)
                  ON CONFLICT(asin,locale) DO UPDATE SET name_attempts=product_translations.name_attempts+1,
                    name_source=COALESCE(product_translations.name_source,EXCLUDED.name_source)
                  WHERE product_translations.name_attempts<3 AND
                    (product_translations.status<>'success' OR product_translations.name IS NULL)
                  RETURNING name_attempts`, [row.asin, nameHash(row), JSON.stringify({ name: row.name, brand: row.brand })]);
                if (!reserved.rows.length) throw new TranslationUnavailable(['attempt_cap']);
                // Commit the batch reservations together.
              }
              await lock.query('COMMIT');
              for (const row of batch) attempts.set(row.asin, (attempts.get(row.asin) ?? 0)+1);
            } catch (error) { await lock.query('ROLLBACK'); throw error; }
          }, onFailure: async (model, issues) => {
            for (const row of batch) await (options.log ?? logTranslationEvent)({ asin: row.asin, locale: 'vi',
              field: 'name', engine: 'openrouter', model, attempt: attempts.get(row.asin) ?? 0,
              original: row.name, issues, result: 'failed' });
          }, unavailableModels });
        const entries = batch.filter(row => result.names.has(row.asin)).map(row => ({ asin: row.asin,
          hash: nameHash(row), name: result.names.get(row.asin)!, issues: result.warnings.get(row.asin) }));
        const policy = await readTranslationPolicy(lock);
        const rejected = new Set([...result.rejectedAsins,
          ...entries.filter(entry => policy.validateTranslationSemantics && entry.issues?.length).map(entry => entry.asin)]);
        if (entries.length) translated += await saveNamesIfCurrent(entries, result.model, lock);
        for (const row of batch) await (options.log ?? logTranslationEvent)({ asin: row.asin, locale: 'vi', field: 'name',
          engine: 'openrouter', model: result.model, attempt: attempts.get(row.asin) ?? 0, original: row.name,
          candidate: result.names.get(row.asin), issues: result.warnings.get(row.asin) ??
            (result.names.has(row.asin) ? [] : ['invalid_output']),
          published: rejected.has(row.asin) ? false : undefined,
          result: result.warnings.has(row.asin) ? 'warning' : result.names.has(row.asin) ? 'success' : 'failed' });
        await markNamesFailed(batch.filter(row => rejected.has(row.asin)));
        failed += rejected.size;
        console.log(`Translated names: ${translated} in current batch`);
      } catch (error) {
        if (!(error instanceof TranslationUnavailable)) throw error;
        if (error.causes.includes('attempt_cap')) { await markNamesFailed(batch); failed += batch.length; continue; }
        if (error.causes.includes('invalid_name_batch')) {
          // Oversized input fails without making a provider request, but is still capped.
          for (const row of batch) {
            await lock.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name_only,name_attempts,name_source)
              VALUES($1,'vi',$2,'failed',true,1,$3) ON CONFLICT(asin,locale) DO UPDATE
              SET name_attempts=LEAST(3,product_translations.name_attempts+1),
                name_source=COALESCE(product_translations.name_source,EXCLUDED.name_source)
              WHERE product_translations.status<>'success' OR product_translations.name IS NULL`,
            [row.asin, nameHash(row), JSON.stringify({ name: row.name, brand: row.brand })]);
            attempts.set(row.asin, (attempts.get(row.asin) ?? 0)+1);
            await (options.log ?? logTranslationEvent)({ asin: row.asin, locale: 'vi', field: 'name',
              engine: 'openrouter', model: null, attempt: attempts.get(row.asin)!, original: row.name,
              issues: ['source_too_large'], result: 'failed' });
          }
        }
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
        // Failed names remain eligible only while their attempt budget remains.
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
