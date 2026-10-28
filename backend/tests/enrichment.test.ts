import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { db } from '../src/db/pool.js';
import { ingestObservations } from '../src/ingestion/store.js';
import { parseDetail } from '../src/ingestion/detail.js';
import { enqueueDetails, processCategoryDetails } from '../src/ingestion/sync.js';
import { getProductDetails, listCatalog } from '../src/catalog.js';
import { SourceError, type Observation } from '../src/ingestion/source.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';

const category = 'thuc-pham-bo-sung';
const html = await readFile(new URL('./fixtures/amazon-detail.html', import.meta.url), 'utf8');
const schema = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
after(async () => { await db.end(); });
const observation = (asin: string): Observation => ({
  asin, name: 'Backend enrichment fixture', categorySlug: category, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
  sourceAdapter: 'fixture', priceJpy: 1000, observedAt: new Date().toISOString()
});

test('additive schema upgrades old products and can be reapplied without data loss', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA enrichment_migration_test');
    await client.query('SET LOCAL search_path TO enrichment_migration_test');
    // Exact pre-enrichment schema, with only the additive block omitted.
    const legacy = (schema.slice(0, schema.indexOf('CREATE TABLE IF NOT EXISTS product_images')) + schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS sync_runs')))
      .split('-- Additive WARNING metadata')[0];
    await client.query(legacy);
    await client.query(`INSERT INTO products(asin,category_slug,name,image_url,source_url,source_adapter) VALUES('M000000001',$1,'Original source name','https://m.media-amazon.com/images/I/legacy.jpg','https://www.amazon.co.jp/dp/M000000001','legacy')`, [category]);
    await client.query(schema);
    await client.query(schema);
    const row = (await client.query('SELECT * FROM products WHERE asin=$1', ['M000000001'])).rows[0];
    assert.equal(row.name, 'Original source name');
    assert.equal(row.rights_status, 'unverified');
    assert.equal(row.image_url, 'https://m.media-amazon.com/images/I/legacy.jpg');
    for (const table of ['product_images', 'product_details', 'product_translations', 'product_detail_queue']) {
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    await assert.rejects(client.query(`INSERT INTO product_images(asin,position,source_url,source_observed_at) VALUES('M000000001',6,'https://m.media-amazon.com/images/I/invalid.jpg',now())`));
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('detail persistence and API retain selected ASIN images, attributes, old quotes, rights and hidden state', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const item = parseDetail(html, 'B000000001', category);
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    item.observedAt = old;
    item.detail!.sourceObservedAt = old;
    item.detail!.provenance.fieldObservedAt = Object.fromEntries(Object.keys(item.detail!.provenance.fieldObservedAt ?? {}).map(field => [field, old]));
    await ingestObservations([item], undefined, client);
    await client.query("UPDATE products SET rights_status='verified',admin_hidden_at=now() WHERE asin=$1", [item.asin]);
    const partial = parseDetail(html.replace('￥2,980', ''), item.asin, category);
    assert.equal(partial.priceJpy, null);
    await ingestObservations([partial], undefined, client);
    const persisted = (await client.query('SELECT * FROM products WHERE asin=$1', [item.asin])).rows[0];
    assert.equal(persisted.name, item.name);
    assert.equal(persisted.price_jpy, 2980);
    assert.equal(persisted.price_observed_at.toISOString(), old);
    assert.equal(persisted.rights_status, 'verified');
    assert.ok(persisted.admin_hidden_at);
    assert.equal(await getProductDetails(item.asin, client), null);
    await client.query('UPDATE products SET admin_hidden_at=NULL WHERE asin=$1', [item.asin]);
    const product = (await getProductDetails(item.asin, client))!;
    assert.equal(product.asin, item.asin);
    assert.equal(product.imageUrl, item.imageUrls![0]);
    assert.deepEqual(product.imageUrls, item.imageUrls);
    assert.deepEqual(product.detail?.ingredients, item.detail!.ingredients);
    assert.equal(product.variantAttributes.Size, '1 kg');
    assert.equal(product.canCheckout, false, 'a detail refresh cannot freshen an old price');
    assert.notEqual(product.detail!.sourceObservedAt, product.priceObservedAt);
    assert.deepEqual(product.detail!.childAsins, [], 'private child discovery must not leak hidden/unverified ASINs');
    const listing = await listCatalog({ q: item.asin, page: 1, limit: 10 }, client);
    assert.deepEqual(listing.items[0].imageUrls, item.imageUrls);
    assert.equal(listing.items[0].variantAttributes.Flavor, 'Vanilla');
    // A daily listing lacking detail cannot clobber the gallery cover.
    await ingestObservations([{ ...observation(item.asin), priceJpy: null, imageUrl: 'https://m.media-amazon.com/images/I/tiny.jpg' }], undefined, client);
    assert.deepEqual((await getProductDetails(item.asin, client))!.imageUrls, item.imageUrls);
    assert.equal((await getProductDetails(item.asin, client))!.imageUrl, item.imageUrls![0]);
    const missingSections = parseDetail(html.replace(/2,980/, '').replace(/<div id="important-information">[\s\S]*?<table/, '<table').replace(/<table id="productDetails_techSpec_section_1">[\s\S]*?<\/table>/, ''), item.asin, category);
    await ingestObservations([missingSections], undefined, client);
    const retained = (await getProductDetails(item.asin, client))!;
    assert.deepEqual(retained.detail!.ingredients, partial.detail!.ingredients);
    assert.equal(retained.detail!.provenance.fieldObservedAt!.ingredients, partial.detail!.sourceObservedAt);
    // Old/out-of-order detail and price observations cannot replace a newer snapshot.
    await ingestObservations([{ ...item, priceJpy: 500, observedAt: '2020-01-01T00:00:00Z', detail: { ...item.detail!, sourceObservedAt: '2020-01-01T00:00:00Z' } }], undefined, client);
    assert.equal((await getProductDetails(item.asin, client))!.priceJpy, 2980);
    assert.equal((await getProductDetails(item.asin, client))!.detail!.sourceObservedAt, missingSections.detail!.sourceObservedAt);
    await client.query("UPDATE products SET rights_status='unverified' WHERE asin=$1", [item.asin]);
    assert.equal((await getProductDetails(item.asin, client))!.rightsStatus, 'unverified', 'owner OFF permits catalog while preserving rights metadata');
    await client.query('UPDATE catalog_settings SET hide_local_test_only=true WHERE id=1');
    assert.equal(await getProductDetails(item.asin, client), null);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('200 unique ASIN budget includes newly found children, persists overflow and rotates fairly next run', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_detail_queue'); // isolate this queue fixture within the rolled-back transaction
    const root = 'Q000000000';
    const initial = Array.from({ length: 199 }, (_, i) => observation(`Q${String(i).padStart(9, '0')}`));
    await enqueueDetails(category, [...initial, initial[0]], client);
    const calls: string[] = [];
    const children = Array.from({ length: 5 }, (_, i) => `R${String(i).padStart(9, '0')}`);
    const collect = async (asin: string) => {
      calls.push(asin);
      const item = observation(asin);
      if (asin === root) item.detail = { features: [], ingredients: [], usage: [], specs: {}, cautions: [], variantAttributes: {},
        childAsins: [...children, children[0]], sourceObservedAt: item.observedAt,
        provenance: { sourceUrl: item.sourceUrl, adapter: 'fixture', sections: ['twister'] } };
      return item;
    };
    const first = await processCategoryDetails(category, { connection: client, collect, save: async () => 1, limit: 999 });
    assert.equal(first.attempted, 200);
    assert.equal(first.saved, 200);
    assert.equal(first.deferred, 4);
    assert.equal(new Set(calls).size, 200);
    assert.equal(calls.filter(id => children.includes(id)).length, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM product_detail_queue WHERE category_slug=$1', [category])).rows[0].n, 204);
    // A second category has an independent allowance.
    const other = 'thuc-pham-cho-be';
    await enqueueDetails(other, [observation(root)], client);
    const separate = await processCategoryDetails(other, { connection: client, collect: async asin => ({ ...observation(asin), categorySlug: other }), save: async () => 1, limit: 1 });
    assert.equal(separate.attempted, 1);
    calls.length = 0;
    const second = await processCategoryDetails(category, { connection: client, collect, save: async () => 1, limit: 4 });
    assert.equal(second.attempted, 4);
    assert.equal(calls.every(id => children.includes(id)), true, 'deferred children precede already attempted products');
    assert.equal(new Set(calls).size, 4);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('temporary errors preserve snapshots and rotate; denial stops queue with failed', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_detail_queue'); // isolate this queue fixture within the rolled-back transaction
    const existing = parseDetail(html, 'B000000001', category);
    await ingestObservations([existing], undefined, client);
    await enqueueDetails(category, [existing, observation('Z000000001'), observation('Z000000002')], client);
    const before = (await client.query('SELECT row_to_json(d) AS data FROM product_details d WHERE asin=$1', [existing.asin])).rows[0].data;
    const issues: { asin?: string; state: string }[] = [];
    const calls: string[] = [];
    const result = await processCategoryDetails(category, {
      connection: client, collect: async asin => { calls.push(asin); throw new SourceError(asin === existing.asin ? 'temporary' : 'blocked', 'fixture'); },
      save: async () => { assert.fail('failure must not be saved'); }, onIssue: async issue => { issues.push(issue); }
    });
    assert.equal(result.attempted, 2);
    assert.equal(result.blocked, true);
    assert.equal(result.deferred, 3);
    assert.deepEqual(issues.map(x => x.state), ['temporary', 'blocked']);
    assert.equal(calls.includes('Z000000002'), false);
    const queue = (await client.query('SELECT asin,state FROM product_detail_queue ORDER BY asin')).rows;
    assert.deepEqual(queue.map(row => row.state), ['failed', 'failed', 'pending']);
    const after = (await client.query('SELECT row_to_json(d) AS data FROM product_details d WHERE asin=$1', [existing.asin])).rows[0].data;
    assert.deepEqual(after, before);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('public read-only HTTP response exposes enriched fields while checkout remains disabled', async () => {
  const server = buildServer();
  const previous = config.publicReadOnly;
  try {
    config.publicReadOnly = true;
    await ingestObservations([parseDetail(html, 'B000000001', category)]);
    const response = await server.inject({ url: '/api/catalog/products/B000000001' });
    assert.equal(response.statusCode, 200);
    const item = response.json();
    assert.equal(item.imageUrls.length, 5);
    assert.equal(item.variantAttributes.Size, '1 kg');
    assert.equal(item.canCheckout, false);
    const checkout = await server.inject({ method: 'POST', url: '/api/checkout', payload: {} });
    assert.equal(checkout.statusCode, 404);
  } finally {
    config.publicReadOnly = previous;
    await server.close();
    await db.query("DELETE FROM price_observations WHERE asin='B000000001'");
    await db.query("DELETE FROM products WHERE asin='B000000001'");
  }
});

test('sibling API data keeps images, quotes and attributes attached to each actual child ASIN', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const first = parseDetail(html, 'B000000001', category);
    const siblingHtml = html.replaceAll('B000000001', 'B000000002').replaceAll('/images/I/', '/images/I/child-')
      .replace('2,980', '3,980').replace('class="selection">Vanilla', 'class="selection">Chocolate');
    const second = parseDetail(siblingHtml, 'B000000002', category);
    await ingestObservations([first, second], undefined, client);
    const result = (await getProductDetails(first.asin, client))!;
    assert.equal(result.variants.length, 2);
    const one = result.variants.find(v => v.asin === first.asin)!;
    const two = result.variants.find(v => v.asin === second.asin)!;
    assert.equal(one.priceJpy, 2980);
    assert.equal(two.priceJpy, 3980);
    assert.equal(one.variantAttributes.Size, '1 kg');
    assert.equal(two.variantAttributes.Size, '2 kg');
    assert.equal(two.variantAttributes.Flavor, 'Chocolate');
    assert.notDeepEqual(one.imageUrls, two.imageUrls);
    await client.query('UPDATE products SET admin_hidden_at=now() WHERE asin=$1', [second.asin]);
    assert.deepEqual((await getProductDetails(first.asin, client))!.variants, []);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('failed detail writes roll back product, gallery, details and quote history together', async () => {
  const asin = 'X000000001';
  const item = parseDetail(html.replaceAll('B000000001', asin), asin, category);
  try {
    await ingestObservations([item]);
    const before = (await db.query('SELECT row_to_json(p) AS data FROM products p WHERE asin=$1', [asin])).rows[0].data;
    const imagesBefore = (await db.query('SELECT * FROM product_images WHERE asin=$1 ORDER BY position', [asin])).rows;
    const bad = { ...item, name: 'Must never persist', priceJpy: 4000,
      imageUrls: ['https://m.media-amazon.com/images/I/replacement.jpg'],
      detail: { ...item.detail!, sourceObservedAt: new Date().toISOString(), specs: [] as unknown as Record<string, string> } };
    await assert.rejects(ingestObservations([bad]));
    assert.deepEqual((await db.query('SELECT row_to_json(p) AS data FROM products p WHERE asin=$1', [asin])).rows[0].data, before);
    assert.deepEqual((await db.query('SELECT * FROM product_images WHERE asin=$1 ORDER BY position', [asin])).rows, imagesBefore);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM price_observations WHERE asin=$1', [asin])).rows[0].n, 1);
  } finally {
    await db.query('DELETE FROM price_observations WHERE asin=$1', [asin]);
    await db.query('DELETE FROM products WHERE asin=$1', [asin]);
  }
});
