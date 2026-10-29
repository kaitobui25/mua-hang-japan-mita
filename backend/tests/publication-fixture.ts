import type { PoolClient } from 'pg';
import { config } from '../src/config.js';
import { db } from '../src/db/pool.js';

// Explicit synthetic evidence only in disposable integration-test databases.
export async function addFixtureReviewEvidence(asin: string, client: Pick<PoolClient, 'query'> = db, ratingsCount = 100) {
  if (!/^\/mita_test_[a-f0-9]{16}$/.test(new URL(config.databaseUrl).pathname)) {
    throw new Error('Publication fixtures require a disposable mita_test database');
  }
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const snapshot = { asin, scope: 'asin', publicationRights: 'verified',
    sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, sourceKind: 'authorized-test-fixture',
    observedAt: new Date().toISOString(), ratingsCount, writtenReviewCount: 2, averageStars: 4,
    reviews: [1, 2].map(id => ({ id: String(id), postedAt: day, written: true, verifiedPurchase: true })) };
  await client.query(`INSERT INTO product_details(asin,source_observed_at,provenance)
    VALUES($1,now(),jsonb_build_object('amazonMetrics',$2::jsonb))
    ON CONFLICT(asin) DO UPDATE SET provenance=product_details.provenance || EXCLUDED.provenance`, [asin, JSON.stringify(snapshot)]);
}

export async function qualifyFixture(asin: string, client: Pick<PoolClient, 'query'> = db, ratingsCount = 100) {
  await addFixtureReviewEvidence(asin, client, ratingsCount);
  await client.query(`UPDATE products SET rights_status='verified', price_jpy=1000,
    price_observed_at=now(), sale_status='ready', availability='in_stock' WHERE asin=$1`, [asin]);
}
