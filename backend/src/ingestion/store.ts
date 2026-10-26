import { db } from '../db/pool.js';
import type { Observation } from './source.js';

export async function ingestObservations(observations: Observation[], runId?: number): Promise<number> {
  let stored = 0;
  for (const o of observations) {
    if (!/^[A-Z0-9]{10}$/.test(o.asin) || !o.name.trim() || !['thuc-pham-bo-sung', 'thuc-pham-cho-be'].includes(o.categorySlug)) continue;
    const validPrice = Number.isInteger(o.priceJpy) && (o.priceJpy ?? 0) > 0;
    const observedAt = validPrice && Number.isFinite(new Date(o.observedAt).getTime()) && new Date(o.observedAt).getTime() <= Date.now()
      ? new Date(o.observedAt) : null;
    const sourceUrl = `https://www.amazon.co.jp/dp/${o.asin}`;
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`INSERT INTO products
        (asin, category_slug, name, brand, image_url, source_url, source_adapter, rights_status, price_jpy, price_observed_at, availability, sale_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'local_test_only',$8,$9,'unknown',$10)
        ON CONFLICT(asin) DO UPDATE SET
          category_slug=EXCLUDED.category_slug, name=EXCLUDED.name, brand=COALESCE(EXCLUDED.brand,products.brand),
          image_url=COALESCE(EXCLUDED.image_url,products.image_url), source_adapter=EXCLUDED.source_adapter,
          price_jpy=COALESCE(EXCLUDED.price_jpy,products.price_jpy),
          price_observed_at=COALESCE(EXCLUDED.price_observed_at,products.price_observed_at),
          sale_status=CASE WHEN COALESCE(EXCLUDED.price_observed_at,products.price_observed_at) IS NOT NULL THEN 'ready' ELSE 'pending_review' END,
          last_seen_at=now(), updated_at=now()`,
        [o.asin, o.categorySlug, o.name, o.brand ?? null, o.imageUrl ?? null, sourceUrl, o.sourceAdapter,
          observedAt ? o.priceJpy : null, observedAt, observedAt ? 'ready' : 'pending_review']);
      if (observedAt && validPrice) {
        await connection.query('INSERT INTO price_observations(asin,price_jpy,observed_at,source_adapter,sync_run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [o.asin, o.priceJpy, observedAt, o.sourceAdapter, runId ?? null]);
      }
      await connection.query('COMMIT');
      stored++;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally { connection.release(); }
  }
  return stored;
}
