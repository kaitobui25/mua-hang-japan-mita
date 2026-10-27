import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { translateProduct, TranslationUnavailable, type ProductText } from './openrouter.js';

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

/** PC worker only. At most 30 translations per run to avoid exhausting free daily quota. */
export async function translatePendingProducts(limit = 30): Promise<{ translated: number; failed: number; skipped: number }> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Translation deferred: OPENROUTER_API_KEY not configured on PC worker.');
    return { translated: 0, failed: 0, skipped: 0 };
  }
  const { rows } = await db.query<SourceRow>(`SELECT p.asin,p.name,p.brand,d.features,d.ingredients,d.usage,d.specs,d.cautions,
      t.source_hash,t.status FROM products p
      LEFT JOIN product_details d ON d.asin=p.asin
      LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      ORDER BY COALESCE(t.updated_at, '1970-01-01'::timestamptz) ASC, p.asin ASC`);
  let translated = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const source = sourceText(row);
    const hash = sourceHash(source);
    if (row.status === 'success' && row.source_hash === hash) { skipped++; continue; }
    if (translated + failed >= limit) break;
    try {
      const result = await translateProduct(source);
      await db.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,translated_at)
        VALUES($1,'vi',$2,$3,$4,$5,'success',now())
        ON CONFLICT(asin,locale) DO UPDATE SET
          name=EXCLUDED.name,detail=EXCLUDED.detail,source_hash=EXCLUDED.source_hash,
          model=EXCLUDED.model,status='success',translated_at=now(),updated_at=now()`,
      [row.asin, result.text.name, JSON.stringify(result.text), hash, result.model]);
      translated++;
    } catch (error) {
      failed++;
      await db.query(`INSERT INTO product_translations(asin,locale,source_hash,status)
        VALUES($1,'vi',$2,'failed')
        ON CONFLICT(asin,locale) DO UPDATE SET status='failed',updated_at=now()`, [row.asin, hash]);
      // Never overwrite a previous valid translation or output raw remote errors.
      console.error(`Translation failed for ASIN ${row.asin}: ${error instanceof TranslationUnavailable ? error.causes.join(', ') : 'unavailable'}`);
      // When all five failed, likely a shared free quota or network outage.
      break;
    }
  }
  console.log(`Translation: ${translated} updated, ${failed} failed, ${skipped} up-to-date`);
  return { translated, failed, skipped };
}
