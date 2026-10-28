import type { PoolClient } from 'pg';
import type { DetailSnapshot } from '../ingestion/source.js';
import type { ProductText } from './openrouter.js';
import { renderDetail, type DetailText, type DetailItem } from './detail-text.js';

type CatalogText = {
  asin: string;
  name: string;
  brand: string | null;
  detail?: DetailSnapshot | null;
};

/** Approved and usable warned text remain visible against their frozen sources. */
export async function applyTranslations(products: CatalogText[], client: Pick<PoolClient, 'query'>) {
  if (!products.length) return;
  const { rows } = await client.query<{
    asin: string; name: string; detail: ProductText | null; source_hash: string; name_only: boolean;
  }>(`SELECT asin,name,detail,source_hash,name_only FROM product_translations
      WHERE locale='vi' AND (status IN ('success','warning') OR detail_approved) AND asin=ANY($1::varchar(10)[])`,
    [products.map(product => product.asin)]);
  const byAsin = new Map(rows.map(row => [row.asin, row]));
  for (const product of products) {
    const translated = byAsin.get(product.asin);
    if (!translated) continue;
    const d = product.detail;
    if (translated.name) product.name = translated.name;
    if (d && translated.detail && !translated.name_only) product.detail = {
      ...d,
      features: translated.detail.features,
      ingredients: translated.detail.ingredients,
      usage: translated.detail.usage,
      specs: translated.detail.specs,
      cautions: translated.detail.cautions
    };
  }
  const local = await client.query<{ asin: string; snapshot: DetailText; items: DetailItem[] }>(`
    SELECT l.asin,l.snapshot,COALESCE(jsonb_agg(jsonb_build_object(
      'slot',i.slot,'source',i.source,'translated',i.translated)) FILTER (WHERE i.slot IS NOT NULL),'[]') AS items
    FROM local_detail_translations l LEFT JOIN local_detail_translation_items i ON i.asin=l.asin
    WHERE l.asin=ANY($1::varchar(10)[]) GROUP BY l.asin`, [products.map(p => p.asin)]);
  const localByAsin = new Map(local.rows.map(row => [row.asin, row]));
  for (const product of products) {
    const saved = localByAsin.get(product.asin);
    const legacy = byAsin.get(product.asin);
    if (!product.detail || !saved?.snapshot || (legacy?.detail && !legacy.name_only)) continue;
    product.detail = { ...product.detail, ...renderDetail(saved.snapshot, saved.items) };
  }
}
