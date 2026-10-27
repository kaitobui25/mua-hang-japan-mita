import { db } from './db/pool.js';
import { getPricingPolicy, isFresh, toVnd, type PricingPolicy } from './pricing.js';
import type { PoolClient } from 'pg';

export type DbProduct = {
  asin: string; name: string; brand: string | null; category_slug: string;
  source_url: string; image_url: string | null; source_adapter: string; rights_status: string;
  variant_group_basis: 'parent_asin' | 'source_product_id' | null; variant_group_id: string | null;
  price_jpy: number | null; price_observed_at: Date | null;
  availability: string; sale_status: string; last_seen_at: Date;
  admin_hidden_at: Date | null;
};

export const publicVisibilitySql = "admin_hidden_at IS NULL AND rights_status IN ('local_test_only','verified')";
export function canCheckoutProduct(p: DbProduct) {
  return !p.admin_hidden_at && ['local_test_only', 'verified'].includes(p.rights_status) &&
    p.sale_status === 'ready' && !['unavailable', 'out_of_stock'].includes(p.availability) &&
    p.price_jpy !== null && p.price_jpy > 0 && isFresh(p.price_observed_at);
}
export function publicProduct(p: DbProduct, policy: PricingPolicy) {
  const canCheckout = canCheckoutProduct(p);
  return {
    id: p.asin, asin: p.asin, name: p.name, brand: p.brand, categorySlug: p.category_slug,
    sourceUrl: p.source_url, imageUrl: p.image_url, sourceAdapter: p.source_adapter,
    rightsStatus: p.rights_status, priceJpy: p.price_jpy,
    priceVnd: p.price_jpy !== null ? toVnd(p.price_jpy, policy) : null,
    priceObservedAt: p.price_observed_at?.toISOString() ?? null,
    availability: p.availability, status: canCheckout ? 'ready' : 'pending_review',
    variantGroup: p.variant_group_basis && p.variant_group_id
      ? { basis: p.variant_group_basis, id: p.variant_group_id } : null,
    canCheckout, lastUpdatedAt: p.last_seen_at.toISOString()
  };
}

export async function getProductDetails(asin: string, connection?: PoolClient) {
  const client = connection ?? db;
  const result = await client.query<DbProduct>(`SELECT * FROM products WHERE asin = $1 AND ${publicVisibilitySql}`, [asin.toUpperCase()]);
  const product = result.rows[0];
  if (!product) return null;
  const policy = await getPricingPolicy(client);
  if (!product.variant_group_basis || !product.variant_group_id) {
    return { ...publicProduct(product, policy), variants: [] };
  }
  // Only an exact, observed identifier within the same source category creates siblings.
  const siblings = await client.query<DbProduct>(`SELECT * FROM products
    WHERE category_slug = $1 AND variant_group_basis = $2 AND variant_group_id = $3 AND ${publicVisibilitySql}
    ORDER BY name ASC, asin ASC`, [product.category_slug, product.variant_group_basis, product.variant_group_id]);
  return { ...publicProduct(product, policy), variants: siblings.rows.length > 1 ? siblings.rows.map(p => publicProduct(p, policy)) : [] };
}

export async function listCatalog(options: { category?: string; q?: string; page: number; limit: number; sort?: string }, connection?: PoolClient) {
  const client = connection ?? db;
  const { category, q, page, limit, sort } = options;
  const where: string[] = [publicVisibilitySql];
  const params: unknown[] = [];
  if (category) { params.push(category); where.push(`category_slug = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR brand ILIKE $${params.length} OR asin ILIKE $${params.length})`); }
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
    SELECT *, row_number() OVER (PARTITION BY ${groupKey} ORDER BY ${ordering}, asin ASC) AS variant_rank
    FROM products ${clause}
  )
  SELECT * FROM ranked WHERE variant_rank = 1
  ORDER BY ${ordering}, asin ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]);
  const policy = await getPricingPolicy(client);
  return { items: rows.rows.map(p => publicProduct(p, policy)), total: Number(total.rows[0].count), page, limit, lastUpdatedAt: rows.rows[0]?.last_seen_at.toISOString() ?? null };
}
