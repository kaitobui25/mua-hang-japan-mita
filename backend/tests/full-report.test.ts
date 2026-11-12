import test from 'node:test';
import assert from 'node:assert/strict';
import { countFullSavedProduct, emptyFullCategoryCounts, type FullCategoryBreakdown,
  type FullProductSnapshot } from '../src/ingestion/full-report.js';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';
import { ingestObservations } from '../src/ingestion/store.js';
import { syncCatalog } from '../src/ingestion/sync.js';
import type { Observation } from '../src/ingestion/source.js';

const product = (overrides: Partial<FullProductSnapshot> = {}): FullProductSnapshot => ({
  asin:'B000000001', name:'Original', price_jpy:1000,
  image_urls:['image-a','image-b'], ...overrides
});

test('Amazon full counts new products only once and excludes them from field-change counts', () => {
  const report: FullCategoryBreakdown = {};
  countFullSavedProduct(report, 'thuc-pham-bo-sung', undefined, product());
  assert.deepEqual(report['thuc-pham-bo-sung'], { ...emptyFullCategoryCounts(), newProducts:1 });
});

test('Amazon full counts actual changes for existing products, separately per category', () => {
  const report: FullCategoryBreakdown = {};
  const before = product();
  countFullSavedProduct(report, 'thuc-pham-bo-sung', before, product());
  countFullSavedProduct(report, 'thuc-pham-bo-sung', before,
    product({name:'Renamed',price_jpy:1200,image_urls:['image-b','image-a']}));
  countFullSavedProduct(report, 'thuc-pham-cho-be', before, product({price_jpy:null}));
  assert.deepEqual(report['thuc-pham-bo-sung'], {
    newProducts:0, existingProducts:2, nameChanged:1, priceChanged:1, imagesChanged:1
  });
  assert.deepEqual(report['thuc-pham-cho-be'], {
    newProducts:0, existingProducts:1, nameChanged:0, priceChanged:1, imagesChanged:0
  });
});

test('Amazon full does not count refreshed observation timestamps or duplicate gallery values as change', () => {
  const report: FullCategoryBreakdown = {};
  countFullSavedProduct(report,'thuc-pham-bo-sung',product(),product({image_urls:['image-a','image-b']}));
  assert.equal(report['thuc-pham-bo-sung'].nameChanged,0);
  assert.equal(report['thuc-pham-bo-sung'].priceChanged,0);
  assert.equal(report['thuc-pham-bo-sung'].imagesChanged,0);
});

test('manual Amazon full measures committed per-category fields in a disposable DB only', {
  skip: !process.env.MITA_DISPOSABLE_TEST_DATABASE
}, async () => {
  const connection = new pg.Client({connectionString:config.databaseUrl});
  await connection.connect();
  const schema = `full_report_test_${randomBytes(6).toString('hex')}`;
  const images = [
    'https://m.media-amazon.com/images/I/61qps28HV7L._AC_SL1125_.jpg',
    'https://m.media-amazon.com/images/I/61llu6jD3iL._AC_SL1125_.jpg',
    'https://m.media-amazon.com/images/I/71TjRWHqVLL._AC_SL1500_.jpg'
  ];
  const observation = (asin:string, name:string, priceJpy:number, imageUrl:string):Observation => {
    const observedAt = new Date().toISOString();
    return {asin, name, categorySlug:'thuc-pham-bo-sung', priceJpy, observedAt,
      sourceUrl:`https://www.amazon.co.jp/dp/${asin}`,sourceAdapter:'fixture',
      imageUrl,imageUrls:[imageUrl],detail:{
        features:['Fixture source detail'],ingredients:[],usage:[],specs:{},cautions:[],
        variantAttributes:{},childAsins:[],sourceObservedAt:observedAt,
        provenance:{sourceUrl:`https://www.amazon.co.jp/dp/${asin}`,adapter:'fixture',
          sections:['gallery:complete']}
      }};
  };
  try {
    await connection.query(`CREATE SCHEMA ${schema}`);
    await connection.query(`SET search_path TO ${schema}`);
    await connection.query(await readFile(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
    await ingestObservations([
      observation('B000000001','Old name',1000,images[0]),
      observation('B000000002','Same name',2000,images[1])
    ],undefined,connection as never);
    const fresh:Observation[] = [
      observation('B000000001','New name',1100,images[0]),
      observation('B000000002','Same name',2000,images[2]),
      observation('B000000003','Third product',3000,images[0])
    ];
    const lookup = new Map(fresh.map(item=>[item.asin,item]));
    const result = await syncCatalog({connection:connection as never,manualExclusive:true,
      totalLimit:3,categories:['thuc-pham-bo-sung'],
      discover:async () => ({observations:fresh,issues:[]}),
      collect:async asin => lookup.get(asin)! });
    assert.equal(result.state,'success');
    assert.equal(result.saved,3);
    assert.ok('categoryBreakdown' in result);
    if (!('categoryBreakdown' in result)) throw Error('missing category breakdown');
    assert.deepEqual(result.categoryBreakdown?.['thuc-pham-bo-sung'],{
      newProducts:1,existingProducts:2,nameChanged:1,priceChanged:1,imagesChanged:1
    });
    assert.deepEqual(result.categoryBreakdown?.['thuc-pham-cho-be'],emptyFullCategoryCounts());
    const note = (await connection.query('SELECT note FROM sync_runs WHERE id=$1',[result.id])).rows[0].note;
    assert.equal(JSON.parse(note).categoryBreakdown['thuc-pham-bo-sung'].imagesChanged,1);
  } finally {
    await connection.query('RESET search_path');
    await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await connection.end();
  }
});
