import { db } from './db/pool.js';
import { isFresh, toVnd } from './pricing.js';

export type DbProduct = {
  asin: string; name: string; brand: string | null; category_slug: string;
  source_url: string; image_url: string | null; source_adapter: string; rights_status: string;
  price_jpy: number | null; price_observed_at: Date | null;
  availability: string; sale_status: string; last_seen_at: Date;
};

export function publicProduct(p: DbProduct) {
  const fresh = isFresh(p.price_observed_at);
  const canCheckout = p.sale_status === 'ready' && p.price_jpy !== null && fresh;
  return {
    id: p.asin, asin: p.asin, name: p.name, brand: p.brand, categorySlug: p.category_slug,
    sourceUrl: p.source_url, imageUrl: p.image_url, sourceAdapter: p.source_adapter,
    rightsStatus: p.rights_status, priceJpy: p.price_jpy,
    priceVnd: p.price_jpy !== null ? toVnd(p.price_jpy) : null,
    priceObservedAt: p.price_observed_at?.toISOString() ?? null,
    availability: p.availability, status: canCheckout ? 'ready' : 'pending_review',
    canCheckout, lastUpdatedAt: p.last_seen_at.toISOString()
  };
}

export async function listCatalog(options: { category?: string; q?: string; page: number; limit: number; sort?: string }) {
  const { category, q, page, limit, sort } = options;
  const where: string[] = [];
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
  const total = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM products ${clause}`, params);
  const rows = await db.query<DbProduct>(`SELECT * FROM products ${clause} ORDER BY ${sorting[sort ?? ''] ?? 'last_seen_at DESC'}, asin ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]);
  return { items: rows.rows.map(publicProduct), total: Number(total.rows[0].count), page, limit, lastUpdatedAt: rows.rows[0]?.last_seen_at.toISOString() ?? null };
}
