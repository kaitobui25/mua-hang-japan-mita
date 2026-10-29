import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/pool.js';
import { listCatalog, getProductDetails } from '../src/catalog.js';
import { ingestObservations, validatedAmazonMetrics } from '../src/ingestion/store.js';
import type { AmazonMetrics } from '../src/ingestion/source.js';

after(() => db.end());

const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const year = day.slice(0, 4);
function metric(asin: string, count: number | null, verified = true): AmazonMetrics {
  return { asin, scope: 'asin', sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, sourceKind: 'authorized-test-fixture',
    publicationRights: 'verified', observedAt: new Date(Date.now() - 1000).toISOString(),
    averageStars: 4.3, ratingsCount: 999999, writtenReviewCount: count,
    reviews: [1, 2].map(id => ({ id: String(id), postedAt: day, verifiedPurchase: verified, written: true })) };
}

test('review validation rejects aggregate scope, invented dates, duplicate evidence and ratings as reviews', () => {
  const value = metric('R000000001', 10);
  assert.ok(validatedAmazonMetrics(value, value.asin));
  assert.equal(validatedAmazonMetrics({ ...value, scope: 'parent' } as unknown as AmazonMetrics, value.asin), null);
  assert.equal(validatedAmazonMetrics({ ...value, observedAt: '2999-01-01' }, value.asin), null);
  assert.equal(validatedAmazonMetrics({ ...value, averageStars: NaN }, value.asin), null);
  assert.equal(validatedAmazonMetrics({ ...value, reviews: [{ ...value.reviews[0], postedAt: `${year}-02-30` }] }, value.asin), null);
  const dedup = validatedAmazonMetrics({ ...value, reviews: [value.reviews[0], value.reviews[0]] }, value.asin);
  assert.equal(dedup?.reviews.length, 1);
});

test('backend ranks before pagination, caps each category and retains honest unknown/stale snapshots', async () => {
  const client = await db.connect();
  await client.query('BEGIN');
  try {
    const categories = ['thuc-pham-bo-sung', 'thuc-pham-cho-be'];
    for (const [categoryIndex, category] of categories.entries()) {
      for (let i = 1; i <= 105; i++) {
        const asin = `R${categoryIndex}${String(i).padStart(8, '0')}`;
        const m = metric(asin, i + 2, i !== 105);
        await ingestObservations([{ asin, name: 'Amazon ranking fixture', categorySlug: category,
          sourceUrl: m.sourceUrl, observedAt: m.observedAt, sourceAdapter: 'fixture', amazonMetrics: m }], undefined, client);
        await client.query("UPDATE products SET rights_status='verified' WHERE asin=$1", [asin]);
      }
    }
    const first = await listCatalog({ q: 'Amazon ranking fixture', page: 1, limit: 12 }, client);
    assert.equal(first.items[0].asin, 'R000000105');
    assert.equal(first.items[1].asin, 'R100000105');
    const second = await listCatalog({ q: 'Amazon ranking fixture', page: 2, limit: 12 }, client);
    assert.equal(second.items[0].amazon?.writtenReviewCount, 101);
    const top = await listCatalog({ q: 'Amazon ranking fixture', sort: 'top-reviews', page: 1, limit: 300 }, client);
    assert.equal(top.total, 200);
    assert.equal(top.items.filter(p => p.categorySlug === categories[0]).length, 100);
    assert.equal(top.items[0].amazon?.qualification, 'ordinary');
    assert.equal(top.items[2].amazon?.qualification, 'verified');
    // A ratings-only snapshot cannot establish ranking eligibility.
    const asin = 'R000000105';
    const unknownCount = metric(asin, null);
    unknownCount.observedAt = new Date().toISOString();
    await ingestObservations([{ asin, name: 'Amazon ranking fixture', categorySlug: categories[0], sourceUrl: unknownCount.sourceUrl,
      sourceAdapter: 'fixture', observedAt: unknownCount.observedAt, amazonMetrics: unknownCount }], undefined, client);
    const ratedOnly = await listCatalog({ q: 'Amazon ranking fixture', sort: 'top-reviews', page: 1, limit: 300 }, client);
    assert.ok(!ratedOnly.items.some(p => p.asin === asin));
    const defaultWithNull = await listCatalog({ q: 'Amazon ranking fixture', page: 1, limit: 300 }, client);
    assert.equal(defaultWithNull.items.at(-1)?.asin, asin);
    const before = (await getProductDetails('R100000105', client))?.amazon?.observedAt;
    const older = metric('R100000105', 2000);
    older.observedAt = new Date(Date.now() - 86400_000).toISOString();
    older.reviews = [];
    await ingestObservations([{ asin: older.asin, name: 'Amazon ranking fixture', categorySlug: categories[1],
      sourceUrl: older.sourceUrl, sourceAdapter: 'fixture', observedAt: older.observedAt, amazonMetrics: older }], undefined, client);
    assert.equal((await getProductDetails(older.asin, client))?.amazon?.observedAt, before);
    // Last year's evidence does not qualify this year (JST rollover).
    await client.query(`UPDATE product_details SET provenance=jsonb_set(provenance,'{amazonMetrics,reviews}', $2::jsonb) WHERE asin=$1`,
      [asin, JSON.stringify(metric(asin, 10).reviews.map(r => ({ ...r, postedAt: `${Number(year) - 1}-12-31` })))]);
    assert.equal((await client.query('SELECT qualification FROM amazon_product_metrics WHERE asin=$1', [asin])).rows[0].qualification, 'unknown');
    const stale = new Date(Date.now() - 2 * 86400_000).toISOString();
    await client.query(`UPDATE product_details SET provenance=jsonb_set(provenance,'{amazonMetrics,observedAt}',to_jsonb($2::text)) WHERE asin=$1`, [asin, stale]);
    // Successful ordinary ingestion without review evidence must not renew it.
    await ingestObservations([{ asin, name: 'Amazon ranking fixture', categorySlug: categories[0], sourceUrl: unknownCount.sourceUrl,
      sourceAdapter: 'fixture', observedAt: new Date().toISOString() }], undefined, client);
    const detail = await getProductDetails(asin, client);
    assert.equal(detail?.amazon?.observedAt, stale);
    assert.equal(detail?.amazon?.stale, true);
    assert.equal(detail?.amazon?.ratingsCount, 999999);
    assert.equal(detail?.sourceUrl, `https://www.amazon.co.jp/dp/${asin}`);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
