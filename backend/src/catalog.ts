import { db } from './db/pool.js';
import { getPricingPolicy, isFresh, toVnd, type PricingPolicy } from './pricing.js';
import { config } from './config.js';
import { applyTranslations } from './translation/catalog.js';
import { galleryImageUrl, uniqueImages } from './ingestion/enrichment.js';
import type { DetailSnapshot } from './ingestion/source.js';
import type { PoolClient } from 'pg';

export type DbProduct = {
  asin: string; name: string; brand: string | null; category_slug: string;
  source_url: string; image_url: string | null; source_adapter: string; rights_status: string;
  variant_group_basis: 'parent_asin' | 'source_product_id' | null; variant_group_id: string | null;
  price_jpy: number | null; price_observed_at: Date | null;
  availability: string; sale_status: string; last_seen_at: Date;
  admin_hidden_at: Date | null;
  /** Admin switch OFF permits all DB entries to be ordered; this is not a copyright verification. */
  owner_all_products_enabled?: boolean;
  image_urls?: string[]; detail?: DetailSnapshot | null;
};

// Owner policy is independent of image/content rights metadata.
// Switch OFF: show/order every DB product except explicitly hidden ones.
// Switch ON: retain verified-only publication/ordering.
const allProductsEnabledSql = '(SELECT NOT hide_local_test_only FROM catalog_settings WHERE id=1)';
const publicRightsSql = `(rights_status = 'verified' OR ${allProductsEnabledSql})`;
export const publicVisibilitySql = `admin_hidden_at IS NULL AND ${publicRightsSql}`;
export function canCheckoutProduct(p: DbProduct) {
  return !config.publicReadOnly && !p.admin_hidden_at && (p.rights_status === 'verified' || p.owner_all_products_enabled === true) &&
    p.sale_status === 'ready' && !['unavailable', 'out_of_stock'].includes(p.availability) &&
    p.price_jpy !== null && p.price_jpy > 0 && isFresh(p.price_observed_at);
}
export function publicProduct(p: DbProduct, policy: PricingPolicy) {
  const canCheckout = canCheckoutProduct(p);
  const gallery = uniqueImages(p.image_urls?.length ? p.image_urls : [p.image_url]);
  const cover = galleryImageUrl(p.image_url) ? p.image_url : gallery[0] ?? null;
  return {
    id: p.asin, asin: p.asin, name: p.name, brand: p.brand, categorySlug: p.category_slug,
    sourceUrl: p.source_url, imageUrl: cover,
    imageUrls: gallery,
    detail: p.detail ?? null, variantAttributes: p.detail?.variantAttributes ?? {},
    sourceAdapter: p.source_adapter,
    rightsStatus: p.rights_status, priceJpy: p.price_jpy,
    priceVnd: p.price_jpy !== null ? toVnd(p.price_jpy, policy) : null,
    priceObservedAt: p.price_observed_at?.toISOString() ?? null,
    availability: p.availability, status: canCheckout ? 'ready' : 'pending_review',
    variantGroup: p.variant_group_basis && p.variant_group_id
      ? { basis: p.variant_group_basis, id: p.variant_group_id } : null,
    canCheckout, lastUpdatedAt: p.last_seen_at.toISOString()
  };
}

async function enrichProducts(products: DbProduct[], client: Pick<PoolClient, 'query'>) {
  if (!products.length) return;
  const ids = products.map(p => p.asin);
  const images = await client.query<{ asin: string; urls: string[] }>(
    'SELECT asin,array_agg(source_url ORDER BY position) AS urls FROM product_images WHERE asin=ANY($1::varchar(10)[]) GROUP BY asin', [ids]);
  const details = await client.query<{
    asin: string; features: string[]; ingredients: string[]; usage: string[]; specs: Record<string,string>;
    cautions: string[]; variant_attributes: Record<string,string>; child_asins: string[];
    source_observed_at: Date; provenance: DetailSnapshot['provenance'];
  }>('SELECT * FROM product_details WHERE asin=ANY($1::varchar(10)[])', [ids]);
  for (const product of products) {
    product.image_urls = images.rows.find(row => row.asin === product.asin)?.urls ?? [];
    const d = details.rows.find(row => row.asin === product.asin);
    product.detail = d ? {
      features: d.features, ingredients: d.ingredients, usage: d.usage, specs: d.specs, cautions: d.cautions,
      variantAttributes: d.variant_attributes,
      // Child discovery evidence is private: unverified/hidden child ASINs must not leak here.
      childAsins: [], sourceObservedAt: d.source_observed_at.toISOString(), provenance: d.provenance
    } : null;
  }
  await applyTranslations(products, client);
}

export async function getProductDetails(asin: string, connection?: PoolClient) {
  const client = connection ?? db;
  const result = await client.query<DbProduct>(`SELECT *, ${allProductsEnabledSql} AS owner_all_products_enabled FROM products WHERE asin = $1 AND ${publicVisibilitySql}`, [asin.toUpperCase()]);
  const product = result.rows[0];
  if (!product) return null;
  await enrichProducts([product], client);
  const policy = await getPricingPolicy(client);
  if (!product.variant_group_basis || !product.variant_group_id) {
    return { ...publicProduct(product, policy), variants: [] };
  }
  // Only an exact, observed identifier within the same source category creates siblings.
  const siblings = await client.query<DbProduct>(`SELECT *, ${allProductsEnabledSql} AS owner_all_products_enabled FROM products
    WHERE category_slug = $1 AND variant_group_basis = $2 AND variant_group_id = $3 AND ${publicVisibilitySql}
    ORDER BY name ASC, asin ASC`, [product.category_slug, product.variant_group_basis, product.variant_group_id]);
  await enrichProducts(siblings.rows, client);
  return { ...publicProduct(product, policy), variants: siblings.rows.length > 1 ? siblings.rows.map(p => publicProduct(p, policy)) : [] };
}

export async function listCatalog(options: { category?: string; q?: string; page: number; limit: number; sort?: string }, connection?: PoolClient) {
  const client = connection ?? db;
  const { category, q, page, limit, sort } = options;
  const where: string[] = [publicVisibilitySql];
  const params: unknown[] = [];
  if (category) { params.push(category); where.push(`category_slug = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR brand ILIKE $${params.length} OR asin ILIKE $${params.length}
    OR EXISTS (SELECT 1 FROM product_translations tr WHERE tr.asin=products.asin AND tr.locale='vi' AND tr.status IN ('success','warning') AND tr.name ILIKE $${params.length}))`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sorting: Record<string, string> = {
    name: 'name ASC',
    'price-asc': 'price_jpy ASC NULLS LAST',
    'price-desc': 'price_jpy DESC NULLS LAST',
    newest: 'last_seen_at DESC'
  };
  // Only verified group identifiers collapse multiple ASINs to one catalog card.
  // Every ASIN without an identifier is its own independent catalog product.
  const groupKey = `CASE WHEN variant_group_basis IS NOT NULL AND variant_group_id IS NOT NULL
    THEN 'group:' || category_slug || ':' || variant_group_basis || ':' || variant_group_id
    ELSE 'asin:' || asin END`;
  const ordering = sorting[sort ?? ''] ?? 'last_seen_at DESC';
  const total = await client.query<{ count: string }>(`SELECT count(DISTINCT ${groupKey})::text AS count FROM products ${clause}`, params);
  const rows = await client.query<DbProduct>(`WITH ranked AS (
    SELECT *, ${allProductsEnabledSql} AS owner_all_products_enabled,
      row_number() OVER (PARTITION BY ${groupKey} ORDER BY ${ordering}, asin ASC) AS variant_rank
    FROM products ${clause}
  )
  SELECT * FROM ranked WHERE variant_rank = 1
  ORDER BY ${ordering}, asin ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]);
  await enrichProducts(rows.rows, client);
  const policy = await getPricingPolicy(client);
  return { items: rows.rows.map(p => publicProduct(p, policy)), total: Number(total.rows[0].count), page, limit, lastUpdatedAt: rows.rows[0]?.last_seen_at.toISOString() ?? null };
}
