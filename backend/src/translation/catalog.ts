import type { PoolClient } from 'pg';
import type { DetailSnapshot } from '../ingestion/source.js';
import { sourceHash, sourceText } from './jobs.js';
import type { ProductText } from './openrouter.js';

type CatalogText = {
  asin: string;
  name: string;
  brand: string | null;
  detail?: DetailSnapshot | null;
};

/** Successful names stay visible forever; only old full descriptions require a matching source. */
export async function applyTranslations(products: CatalogText[], client: Pick<PoolClient, 'query'>) {
  if (!products.length) return;
  const { rows } = await client.query<{
    asin: string; name: string; detail: ProductText | null; source_hash: string; name_only: boolean;
  }>(`SELECT asin,name,detail,source_hash,name_only FROM product_translations
      WHERE locale='vi' AND status='success' AND asin=ANY($1::varchar(10)[])`,
    [products.map(product => product.asin)]);
  const byAsin = new Map(rows.map(row => [row.asin, row]));
  for (const product of products) {
    const translated = byAsin.get(product.asin);
    if (!translated) continue;
    const d = product.detail;
    const original = sourceText({
      name: product.name, brand: product.brand, features: d?.features ?? [],
      ingredients: d?.ingredients ?? [], usage: d?.usage ?? [], specs: d?.specs ?? {},
      cautions: d?.cautions ?? []
    });
    if (!translated.name) continue;
    product.name = translated.name;
    if (d && translated.detail && !translated.name_only && sourceHash(original) === translated.source_hash) product.detail = {
      ...d,
      features: translated.detail.features,
      ingredients: translated.detail.ingredients,
      usage: translated.detail.usage,
      specs: translated.detail.specs,
      cautions: translated.detail.cautions
    };
  }
}
