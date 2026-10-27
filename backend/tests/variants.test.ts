import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../src/db/pool.js';
import { getProductDetails, listCatalog } from '../src/catalog.js';
import { ingestObservations, observedVariantGroup, type VariantObservation } from '../src/ingestion/store.js';

function asin(): string { return `T${randomBytes(5).toString('hex').toUpperCase().slice(0, 9)}`; }

function observation(id: string, overrides: Partial<VariantObservation> = {}): VariantObservation {
  return {
    asin: id, name: 'Test product with common name', categorySlug: 'thuc-pham-bo-sung',
    sourceUrl: `https://www.amazon.co.jp/dp/${id}`, sourceAdapter: 'test-observation',
    observedAt: new Date().toISOString(), priceJpy: 1000, imageUrl: null, ...overrides
  };
}

test('never derive variant groups from matching names, ASINs, or invalid identifiers', () => {
  assert.equal(observedVariantGroup({}), null);
  assert.equal(observedVariantGroup({ parentAsin: 'similar whey protein' }), null);
  assert.equal(observedVariantGroup({ sourceProductId: 'same product display name' }), null);
  assert.deepEqual(observedVariantGroup({ parentAsin: 'b0abcdef12' }), { basis: 'parent_asin', id: 'B0ABCDEF12' });
  assert.deepEqual(observedVariantGroup({ sourceProductId: 'family-1234' }), { basis: 'source_product_id', id: 'family-1234' });
  assert.deepEqual(observedVariantGroup({ parentAsin: 'B0ABCDEF12', sourceProductId: 'family-1234' }),
    { basis: 'parent_asin', id: 'B0ABCDEF12' });
});

test('detail API groups only products with the same observed key and category', async () => {
  const client = await db.connect();
  const first = asin(), sibling = asin(), noEvidence = asin(), otherCategory = asin();
  const parent = asin();
  try {
    await client.query('BEGIN');
    for (const [id, category, basis, groupId, price] of [
      [first, 'thuc-pham-bo-sung', 'parent_asin', parent, 2000],
      [sibling, 'thuc-pham-bo-sung', 'parent_asin', parent, 1000],
      [noEvidence, 'thuc-pham-bo-sung', null, null, 3000],
      [otherCategory, 'thuc-pham-cho-be', 'parent_asin', parent, 500]
    ] as const) {
      await client.query(`INSERT INTO products
        (asin, category_slug, name, source_url, source_adapter, variant_group_basis, variant_group_id, price_jpy,rights_status)
        VALUES ($1,$2,'Identical name','https://www.amazon.co.jp/dp/test','test',$3,$4,$5,'local_test_only')`,
      [id, category, basis, groupId, price]);
    }

    const result = await getProductDetails(first, client);
    assert.ok(result);
    assert.equal(result.variantGroup?.basis, 'parent_asin');
    assert.equal(result.variantGroup?.id, parent);
    assert.deepEqual(result.variants.map(item => item.asin).sort(), [first, sibling].sort());
    assert.equal(result.variants.every(item => item.name === 'Identical name'), true);

    const ungrouped = await getProductDetails(noEvidence, client);
    assert.ok(ungrouped);
    assert.equal(ungrouped.variantGroup, null);
    assert.deepEqual(ungrouped.variants, []);

    const separateCategory = await getProductDetails(otherCategory, client);
    assert.ok(separateCategory);
    assert.deepEqual(separateCategory.variants, []);
    assert.equal(await getProductDetails(asin(), client), null);

    const listing = await listCatalog({ category: 'thuc-pham-bo-sung', q: 'Identical name', page: 1, limit: 10 }, client);
    assert.equal(listing.total, 2); // one explicit family plus independent ASIN
    assert.equal(listing.items.length, 2);
    assert.equal(listing.items.some(item => item.asin === noEvidence), true);
    assert.equal(listing.items.filter(item => item.variantGroup?.id === parent).length, 1);

    const cheaper = await listCatalog({ category: 'thuc-pham-bo-sung', q: 'Identical name', page: 1, limit: 1, sort: 'price-asc' }, client);
    assert.equal(cheaper.total, 2);
    assert.equal(cheaper.items.length, 1);
    assert.equal(cheaper.items[0].asin, sibling); // choose cheapest observed variant as group representative
    const nextPage = await listCatalog({ category: 'thuc-pham-bo-sung', q: 'Identical name', page: 2, limit: 1, sort: 'price-asc' }, client);
    assert.equal(nextPage.total, 2);
    assert.equal(nextPage.items[0].asin, noEvidence);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('ingestion stores explicit source family IDs, keeps ungrouped ASINs independent', async () => {
  const first = asin(), sibling = asin(), independent = asin();
  const group = `family-${randomBytes(4).toString('hex')}`;
  const ids = [first, sibling, independent];
  try {
    const count = await ingestObservations([
      observation(first, { sourceProductId: group }),
      observation(sibling, { sourceProductId: group }),
      observation(independent, { name: 'Test product with common name' })
    ]);
    assert.equal(count, 3);

    const grouped = await getProductDetails(first);
    assert.ok(grouped);
    assert.equal(grouped.variantGroup?.basis, 'source_product_id');
    assert.deepEqual(grouped.variants.map(item => item.asin).sort(), [first, sibling].sort());

    const single = await getProductDetails(independent);
    assert.ok(single);
    assert.deepEqual(single.variants, []);

    // Daily listing snapshots omit group metadata. Missing evidence does not
    // invent or silently replace a previously observed source identifier.
    await ingestObservations([observation(first)]);
    const persisted = await getProductDetails(first);
    assert.equal(persisted?.variantGroup?.id, group);
    assert.equal(persisted?.variants.length, 2);
  } finally {
    await db.query('DELETE FROM price_observations WHERE asin = ANY($1::varchar(10)[])', [ids]);
    await db.query('DELETE FROM products WHERE asin = ANY($1::varchar(10)[])', [ids]);
    await db.end();
  }
});
