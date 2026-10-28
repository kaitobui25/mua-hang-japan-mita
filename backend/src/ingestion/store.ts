import { db } from '../db/pool.js';
import { galleryImageUrl, uniqueImages } from './enrichment.js';
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
          name=EXCLUDED.name, brand=COALESCE(EXCLUDED.brand,products.brand),
          image_url=CASE WHEN EXISTS (SELECT 1 FROM product_images WHERE asin=products.asin) THEN products.image_url ELSE COALESCE(EXCLUDED.image_url,products.image_url) END, source_adapter=EXCLUDED.source_adapter,
          variant_group_basis=COALESCE(EXCLUDED.variant_group_basis,products.variant_group_basis),
          variant_group_id=COALESCE(EXCLUDED.variant_group_id,products.variant_group_id),
          price_jpy=CASE WHEN EXCLUDED.price_observed_at >= COALESCE(products.price_observed_at, '-infinity'::timestamptz) THEN EXCLUDED.price_jpy ELSE products.price_jpy END,
          price_observed_at=GREATEST(EXCLUDED.price_observed_at,products.price_observed_at),
          availability=CASE WHEN EXCLUDED.availability='unknown' THEN products.availability ELSE EXCLUDED.availability END,
          sale_status=CASE WHEN COALESCE(EXCLUDED.price_observed_at,products.price_observed_at) IS NOT NULL THEN 'ready' ELSE 'pending_review' END,
          last_seen_at=now(), updated_at=now()`,
        [o.asin, o.categorySlug, o.name, o.brand ?? null, o.imageUrl ?? null, sourceUrl, o.sourceAdapter,
          observedAt ? o.priceJpy : null, observedAt, observedAt ? 'ready' : 'pending_review', group?.basis ?? null, group?.id ?? null, o.availability ?? 'unknown']);
      const detailAt = o.detail && Number.isFinite(Date.parse(o.detail.sourceObservedAt)) && Date.parse(o.detail.sourceObservedAt) <= Date.now()
        ? new Date(o.detail.sourceObservedAt) : null;
      if (o.detail && detailAt) {
        // Product row locking from the upsert serializes gallery/detail replacement.
        const previous = await connection.query<{ source_observed_at: Date }>('SELECT source_observed_at FROM product_details WHERE asin=$1', [o.asin]);
        if (!previous.rows[0] || previous.rows[0].source_observed_at <= detailAt) {
          const images = uniqueImages(o.imageUrls ?? []);
          const d = o.detail;
          // An upstream "complete" label cannot authorize replacing a good
          // gallery when some of its observed URLs are thumbnail sized.
          const completeGallery = d.provenance.sections.includes('gallery:complete') &&
            (o.imageUrls ?? []).every(url => galleryImageUrl(url));
          const existingGallery = images.length && !completeGallery
            ? await connection.query('SELECT 1 FROM product_images WHERE asin=$1 LIMIT 1', [o.asin]) : null;
          const replaceGallery = images.length > 0 && !existingGallery?.rows.length;
          if (replaceGallery) {
            await connection.query('DELETE FROM product_images WHERE asin=$1', [o.asin]);
            for (const [index, url] of images.entries()) {
              await connection.query('INSERT INTO product_images(asin,position,source_url,source_observed_at) VALUES($1,$2,$3,$4)', [o.asin, index + 1, url, detailAt]);
            }
            await connection.query('UPDATE products SET image_url=$2 WHERE asin=$1', [o.asin, images[0]]);
          }
          const fieldObservedAt = { ...d.provenance.fieldObservedAt };
          if (!replaceGallery) delete fieldObservedAt.images;
          await connection.query(`INSERT INTO product_details
            (asin,features,ingredients,usage,specs,cautions,variant_attributes,child_asins,source_observed_at,provenance)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT(asin) DO UPDATE SET
              features=CASE WHEN EXCLUDED.features='[]'::jsonb THEN product_details.features ELSE EXCLUDED.features END,
              ingredients=CASE WHEN EXCLUDED.ingredients='[]'::jsonb THEN product_details.ingredients ELSE EXCLUDED.ingredients END,
              usage=CASE WHEN EXCLUDED.usage='[]'::jsonb THEN product_details.usage ELSE EXCLUDED.usage END,
              specs=CASE WHEN EXCLUDED.specs='{}'::jsonb THEN product_details.specs ELSE EXCLUDED.specs END,
              cautions=CASE WHEN EXCLUDED.cautions='[]'::jsonb THEN product_details.cautions ELSE EXCLUDED.cautions END,
              variant_attributes=CASE WHEN EXCLUDED.variant_attributes='{}'::jsonb THEN product_details.variant_attributes ELSE EXCLUDED.variant_attributes END,
              child_asins=CASE WHEN EXCLUDED.child_asins='[]'::jsonb THEN product_details.child_asins ELSE EXCLUDED.child_asins END,
              source_observed_at=EXCLUDED.source_observed_at,
              provenance=product_details.provenance || EXCLUDED.provenance || jsonb_build_object(
                'fieldObservedAt', COALESCE(product_details.provenance->'fieldObservedAt','{}'::jsonb) || COALESCE(EXCLUDED.provenance->'fieldObservedAt','{}'::jsonb))`,
          [o.asin, JSON.stringify(d.features), JSON.stringify(d.ingredients), JSON.stringify(d.usage), JSON.stringify(d.specs),
            JSON.stringify(d.cautions), JSON.stringify(d.variantAttributes), JSON.stringify(d.childAsins), detailAt, JSON.stringify({ ...d.provenance, fieldObservedAt })]);
        }
      }
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
