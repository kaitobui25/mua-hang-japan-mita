import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/pool.js';
import { specRatingsSql } from '../src/amazon-ratings.js';
import { getProductDetails, listCatalog } from '../src/catalog.js';
import { ingestObservations } from '../src/ingestion/store.js';

after(() => db.end());

test('Customer Reviews parser accepts observed ratings and fails closed on malformed specs', async () => {
  for (const [value, expected] of [
    ['4.2 4.2 out of 5 stars (76)', { averageStars: 4.2, ratingsCount: 76 }],
    ['4.2 4.2 out of 5 stars (1,234)', { averageStars: 4.2, ratingsCount: 1234 }],
    ['0.0 0.0 out of 5 stars (0)', { averageStars: 0, ratingsCount: 0 }],
    [null, null], ['', null], ['4.2 out of 5 stars (76)', null],
    ['4.2 4.3 out of 5 stars (76)', null], ['5.1 5.1 out of 5 stars (76)', null],
    ['4.2 4.2 out of 5 stars (1,23)', null], ['4.2 4.2 out of 5 stars (-76)', null],
    ['4.2 4.2 out of 5 stars (9007199254740992)', null],
    ['4.2 4.2 out of 5 stars (76) invented', null],
  ] as const) {
    const result = await db.query(`SELECT ${specRatingsSql} AS rating FROM (SELECT $1::jsonb AS specs) d`,
      [JSON.stringify({ 'Customer Reviews': value })]);
    assert.deepEqual(result.rows[0].rating, expected, String(value));
  }
});

test('legacy specs populate list/detail, sort before pagination, and never qualify Top100', async () => {
  const client = await db.connect();
  await client.query('BEGIN');
  try {
    const observedAt = '2026-01-02T00:00:00.000Z';
    for (const [asin, count] of [['S000000001', 76], ['S000000002', 1000], ['S000000003', null]] as const) {
      await ingestObservations([{ asin, name: 'Spec ratings regression fixture', categorySlug: 'thuc-pham-bo-sung',
        sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, sourceAdapter: 'fixture', observedAt,
        detail: { features: [], ingredients: [], usage: [], cautions: [], variantAttributes: {}, childAsins: [],
          specs: count === null ? {} : { 'Customer Reviews': `4.2 4.2 out of 5 stars (${count})` },
          sourceObservedAt: observedAt, provenance: { sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, adapter: 'fixture', sections: ['specs'] } }
      }], undefined, client);
      await client.query("UPDATE products SET rights_status='verified' WHERE asin=$1", [asin]);
    }
    const options = { q: 'Spec ratings regression fixture', page: 1, limit: 1 };
    const first = await listCatalog(options, client);
    assert.equal(first.items[0].asin, 'S000000002');
    assert.equal(first.popularity.metric, 'ratings');
    const second = await listCatalog({ ...options, page: 2, sort: 'reviews' }, client);
    assert.equal(second.items[0].asin, 'S000000001');
    const detail = await getProductDetails('S000000001', client);
    assert.deepEqual(second.items[0].amazon, detail?.amazon);
    assert.equal(detail?.amazon?.averageStars, 4.2);
    assert.equal(detail?.amazon?.ratingsCount, 76);
    assert.equal(detail?.amazon?.writtenReviewCount, null);
    assert.equal(detail?.amazon?.qualification, 'unknown');
    assert.equal(detail?.amazon?.observedAt, observedAt);
    assert.equal(detail?.amazon?.stale, true);
    assert.equal((await listCatalog({ ...options, page: 3 }, client)).items[0].amazon, null);
    assert.equal((await listCatalog({ ...options, sort: 'top-reviews' }, client)).total, 0);
    // Structured counts take precedence, including zero; written-review totals
    // must not influence the popular sort, even when they disagree with ratings.
    const metric = { asin: 'S000000002', scope: 'asin', publicationRights: 'verified',
      sourceUrl: 'https://www.amazon.co.jp/dp/S000000002', sourceKind: 'fixture',
      observedAt, averageStars: 3.5, ratingsCount: 0, writtenReviewCount: 5000, reviews: [] };
    await client.query(`UPDATE product_details SET provenance=jsonb_set(provenance,'{amazonMetrics}',$2::jsonb) WHERE asin=$1`,
      [metric.asin, JSON.stringify(metric)]);
    const reordered = await listCatalog({ ...options, limit: 10 }, client);
    assert.deepEqual(reordered.items.map(p => p.asin), ['S000000001', 'S000000002', 'S000000003']);
    assert.equal(reordered.items[1].amazon?.ratingsCount, 0);
    assert.equal(reordered.items[1].amazon?.averageStars, 3.5);
    assert.equal(reordered.items[1].amazon?.writtenReviewCount, 5000);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
