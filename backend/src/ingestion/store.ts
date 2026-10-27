import { db } from '../db/pool.js';
import type { Observation } from './source.js';
import type { PoolClient } from 'pg';

// These optional identifiers must be observed explicitly in source product metadata.
// Listings without the matching source attribute remain independent ASINs.
export type VariantObservation = Observation & {
  parentAsin?: string | null;
  sourceProductId?: string | null;
};

export function observedVariantGroup(observation: Pick<VariantObservation, 'parentAsin' | 'sourceProductId'>):
  { basis: 'parent_asin' | 'source_product_id'; id: string } | null {
  const parent = observation.parentAsin?.trim().toUpperCase();
  if (parent && /^[A-Z0-9]{10}$/.test(parent)) return { basis: 'parent_asin', id: parent };
  const sourceId = observation.sourceProductId?.trim();
  if (sourceId && /^[A-Za-z0-9_.:-]{3,128}$/.test(sourceId)) return { basis: 'source_product_id', id: sourceId };
  return null;
}

export async function ingestObservations(observations: VariantObservation[], runId?: number, client?: PoolClient): Promise<number> {
  let stored = 0;
  for (const o of observations) {
    if (!/^[A-Z0-9]{10}$/.test(o.asin) || !o.name.trim() || !['thuc-pham-bo-sung', 'thuc-pham-cho-be'].includes(o.categorySlug)) continue;
    const validPrice = Number.isInteger(o.priceJpy) && (o.priceJpy ?? 0) > 0;
    const observedAt = validPrice && Number.isFinite(new Date(o.observedAt).getTime()) && new Date(o.observedAt).getTime() <= Date.now()
      ? new Date(o.observedAt) : null;
    const sourceUrl = `https://www.amazon.co.jp/dp/${o.asin}`;
    const group = observedVariantGroup(o);
    const connection = client ?? await db.connect();
    try {
      if (!client) await connection.query('BEGIN');
      await connection.query(`INSERT INTO products
        (asin, category_slug, name, brand, image_url, source_url, source_adapter, rights_status, price_jpy, price_observed_at, availability, sale_status, variant_group_basis, variant_group_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'local_test_only',$8,$9,$13,$10,$11,$12)
        ON CONFLICT(asin) DO UPDATE SET
          category_slug=EXCLUDED.category_slug, name=EXCLUDED.name, brand=COALESCE(EXCLUDED.brand,products.brand),
          image_url=COALESCE(EXCLUDED.image_url,products.image_url), source_adapter=EXCLUDED.source_adapter,
          variant_group_basis=COALESCE(EXCLUDED.variant_group_basis,products.variant_group_basis),
          variant_group_id=COALESCE(EXCLUDED.variant_group_id,products.variant_group_id),
          price_jpy=COALESCE(EXCLUDED.price_jpy,products.price_jpy),
          price_observed_at=COALESCE(EXCLUDED.price_observed_at,products.price_observed_at),
          availability=CASE WHEN EXCLUDED.availability='unknown' THEN products.availability ELSE EXCLUDED.availability END,
          sale_status=CASE WHEN COALESCE(EXCLUDED.price_observed_at,products.price_observed_at) IS NOT NULL THEN 'ready' ELSE 'pending_review' END,
          last_seen_at=now(), updated_at=now()`,
        [o.asin, o.categorySlug, o.name, o.brand ?? null, o.imageUrl ?? null, sourceUrl, o.sourceAdapter,
          observedAt ? o.priceJpy : null, observedAt, observedAt ? 'ready' : 'pending_review', group?.basis ?? null, group?.id ?? null, o.availability ?? 'unknown']);
      if (observedAt && validPrice) {
        await connection.query('INSERT INTO price_observations(asin,price_jpy,observed_at,source_adapter,sync_run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [o.asin, o.priceJpy, observedAt, o.sourceAdapter, runId ?? null]);
      }
      if (!client) await connection.query('COMMIT');
      stored++;
    } catch (error) {
      if (!client) await connection.query('ROLLBACK');
      throw error;
    } finally { if (!client) connection.release(); }
  }
  return stored;
}
