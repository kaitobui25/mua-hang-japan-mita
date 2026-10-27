import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { translateProduct, readFreeQuota, TranslationUnavailable, type ProductText } from './openrouter.js';

type SourceRow = {
  asin: string; name: string; brand: string | null;
  features: string[] | null; ingredients: string[] | null; usage: string[] | null;
  specs: Record<string, string> | null; cautions: string[] | null;
  source_hash: string | null; status: string | null;
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

export function translationFailureStopsBatch(error: unknown): boolean {
  if (!(error instanceof TranslationUnavailable)) return true;
  if (error.causes.some(reason => ['missing_api_key', 'unauthorized_api_key', 'free_quota_exhausted', 'rate_limit_platform', 'quota_check_unavailable', 'account_budget_exhausted', 'providers_temporarily_unavailable'].includes(reason))) return true;
  // An oversized or unusually formatted product cannot prevent unrelated text being translated.
  if (error.causes.includes('source_too_large')) return false;
  return false;
}

/** PC worker only. At most 30 translations per run to avoid exhausting free daily quota. */
export async function translatePendingProducts(limit = 30): Promise<{ translated: number; failed: number; skipped: number }> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Translation deferred: OPENROUTER_API_KEY not configured on PC worker.');
    return { translated: 0, failed: 0, skipped: 0 };
  }
  let quota;
  try { quota = await readFreeQuota(); }
  catch (error) {
    console.error('Translation deferred: OpenRouter quota status unavailable.');
    return { translated: 0, failed: 0, skipped: 0 };
  }
  // Reserve a few calls for the owner; free models have a shared UTC daily limit.
  let remaining = Math.max(0, quota.remaining - 2);
  if (remaining === 0) {
    console.log('Translation deferred: free daily quota exhausted.');
    return { translated: 0, failed: 0, skipped: 0 };
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
  const { rows } = await db.query<SourceRow>(`SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions,
      t.source_hash,t.status FROM products p
      LEFT JOIN product_details d ON d.asin=p.asin
      LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      LEFT JOIN product_detail_queue q ON q.asin=p.asin AND q.category_slug=p.category_slug
      -- Avoid spending scarce free quota on text about to change in an active backfill.
      WHERE q.asin IS NULL OR q.state <> 'pending' OR q.enqueued_at < now() - interval '6 hours'
      ORDER BY CASE WHEN t.status='failed' THEN 1 ELSE 0 END,
        length(p.name) ASC, COALESCE(t.updated_at, '1970-01-01'::timestamptz) ASC, p.asin ASC`);
  let translated = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const source = sourceText(row);
    const hash = sourceHash(source);
    if (row.status === 'success' && row.source_hash === hash) { skipped++; continue; }
    if (translated + failed >= limit) break;
    try {
      const result = await translateProduct(source, { beforeRequest, unavailableModels });
      await db.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,translated_at)
        VALUES($1,'vi',$2,$3,$4,$5,'success',now())
        ON CONFLICT(asin,locale) DO UPDATE SET
          name=EXCLUDED.name,detail=EXCLUDED.detail,source_hash=EXCLUDED.source_hash,
          model=EXCLUDED.model,status='success',translated_at=now(),updated_at=now()`,
      [row.asin, result.text.name, JSON.stringify(result.text), hash, result.model]);
      translated++;
    } catch (error) {
      failed++;
      if (error instanceof TranslationUnavailable && error.causes.includes('free_quota_exhausted')) break;
      await db.query(`INSERT INTO product_translations(asin,locale,source_hash,status)
        VALUES($1,'vi',$2,'failed')
        ON CONFLICT(asin,locale) DO UPDATE SET status='failed',updated_at=now()`, [row.asin, hash]);
      // Never overwrite a previous valid translation or output raw remote errors.
      console.error(`Translation failed for ASIN ${row.asin}: ${error instanceof TranslationUnavailable ? error.causes.join(', ') : 'unavailable'}`);
      // Shared quota/network outage: defer the remaining batch. Product-specific errors: continue.
      if (translationFailureStopsBatch(error)) break;
    }
  }
  console.log(`Translation: ${translated} updated, ${failed} failed, ${skipped} up-to-date`);
  return { translated, failed, skipped };
}
