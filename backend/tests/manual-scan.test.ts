import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManualEvidence, runManualAmazonScan, selectManualCandidates,
  updateOnlyImages, updateOnlyPrice } from '../src/ingestion/manual-scan.js';
import { SourceError } from '../src/ingestion/source.js';

const img = (id:string,size:string) => `https://m.media-amazon.com/images/I/${id}._AC_${size}_.jpg`;
const candidate = (asin:string, urls:string[]=[]) => ({ asin,category_slug:'thuc-pham-cho-be',image_url:urls[0]??null,
  price_observed_at:null,last_seen_at:new Date('2026-10-30'),urls });

function fakeDb(rows: ReturnType<typeof candidate>[] = []) {
  const sql:string[]=[];
  let released=false;
  const client={
    async query(text:string) {
      sql.push(text);
      if (text.includes('pg_try_advisory_lock')) return {rows:[{acquired:true}]};
      if (text.includes('source_access_blocks')) return {rows:[],rowCount:0};
      if (text.includes('FROM products p LEFT JOIN product_images')) return {rows};
      if (text.startsWith('SELECT source_url,source_observed_at')) return {rows:[]};
      if (text.includes('price_observed_at<=')) return {rows:[{asin:'B000000001'}]};
      return {rows:[],rowCount:1};
    },
    release() { released=true; }
  };
  return { client,sql,get released(){return released;} };
}

test('manual Amazon options sort low-resolution galleries first and reject invalid limits', () => {
  const one=candidate('B000000001',[img('a','SL1500'),...Array.from({length:4},(_,i)=>img(`t${i}`,'US40'))]);
  const five=candidate('B000000002',Array.from({length:5},(_,i)=>img(`full${i}`,'SL1500')));
  assert.equal(selectManualCandidates([five,one],'images',1)[0].asin,one.asin);
  assert.throws(()=>selectManualCandidates([one],'presence',301));
  assert.throws(()=>selectManualCandidates([one],'unknown' as never,1));
});

test('presence requires a matching ASIN and title, but no gallery or price', () => {
  const now=new Date('2026-11-05T04:00:00Z');
  const html='<input id="ASIN" value="B000000001"><span id="productTitle">A valid source product name</span><div id="availability">現在お取り扱いできません</div>';
  const item=parseManualEvidence(html,'B000000001',now);
  assert.equal(item.priceJpy,null);
  assert.equal(item.availability,'out_of_stock');
  assert.throws(()=>parseManualEvidence(html,'B000000002',now),/identity/);
});

test('images-only writes only image rows + cover, preserving other catalog fields', async () => {
  const fake=fakeDb();
  const item={asin:'B000000001',observedAt:new Date().toISOString(),imageUrls:[img('cover','SL1500'),img('second','SL1200')],completeGallery:true};
  const updated=await updateOnlyImages(fake.client as never,item.asin,item);
  assert.equal(updated,true);
  assert.ok(fake.sql.some(text=>text.includes('INSERT INTO product_images')));
  assert.ok(fake.sql.some(text=>text.startsWith('UPDATE products SET image_url=')));
  assert.ok(!fake.sql.some(text=>/SET (name|price_jpy|availability|sale_status|variant_group)/.test(text)));
});

test('price-only writes JPY timestamp and price history, preserving image/availability/name', async () => {
  const fake=fakeDb();
  const updated=await updateOnlyPrice(fake.client as never,'B000000001',
    {asin:'B000000001',observedAt:new Date().toISOString(),priceJpy:2380});
  assert.equal(updated,true);
  assert.ok(fake.sql.some(text=>text.includes('INSERT INTO price_observations')));
  assert.ok(fake.sql.some(text=>text.startsWith('UPDATE products SET price_jpy=')));
  assert.ok(!fake.sql.some(text=>/SET (image_url|name|availability|sale_status)/.test(text)));
});

test('presence mode checks existing ASIN without changing catalog rows', async () => {
  const fake=fakeDb([candidate('B000000001')]);
  const result=await runManualAmazonScan({mode:'presence',limit:1,
    connect:async()=>fake.client as never,
    fetch:async asin=>({asin,observedAt:new Date().toISOString(),availability:'out_of_stock'})});
  assert.equal(result.succeeded,1);
  assert.equal(result.present,1);
  assert.equal(result.outOfStock,1);
  assert.equal(result.failed,0);
  assert.equal(fake.released,true);
  assert.ok(!fake.sql.some(text=>/\b(?:INSERT|UPDATE|DELETE)\b/i.test(text)));
});

test('bad Amazon image response fails with a reason without altering product data', async () => {
  const fake=fakeDb([candidate('B000000001')]);
  const result=await runManualAmazonScan({mode:'images',limit:1,
    connect:async()=>fake.client as never,
    fetch:async asin=>({asin,observedAt:new Date().toISOString(),imageUrls:[img('small','US40')]})});
  assert.equal(result.succeeded,0);
  assert.equal(result.failed,1);
  assert.match(result.failures[0].detail,/No suitable Amazon images/);
  assert.ok(!fake.sql.some(text=>text.includes('UPDATE products')));
});

test('404 presence is an observation, not a deletion or out-of-stock claim', async () => {
  const fake=fakeDb([candidate('B000000001')]);
  const result=await runManualAmazonScan({mode:'presence',limit:1,
    connect:async()=>fake.client as never,
    fetch:async asin=>({asin,observedAt:new Date().toISOString(),presence:'not_found_http_404'})});
  assert.equal(result.notFoundHttp404,1);
  assert.equal(result.present,0);
  assert.equal(result.items[0].outcome,'not_found_http_404');
  assert.ok(!fake.sql.some(text=>/UPDATE products|DELETE FROM products/i.test(text)));
});

test('Amazon denial stops future requests and records a source cooldown', async () => {
  const fake=fakeDb([candidate('B000000001'),candidate('B000000002')]);
  let calls=0;
  const result=await runManualAmazonScan({mode:'presence',limit:2,
    connect:async()=>fake.client as never,
    fetch:async () => {calls++;throw new SourceError('blocked','CAPTCHA requires manual verification','scrapling');}});
  assert.equal(calls,1);
  assert.equal(result.state,'blocked');
  assert.equal(result.failed,1);
  assert.equal(result.deferred,1);
  assert.ok(fake.sql.some(text=>text.includes('INSERT INTO source_access_blocks')));
});

test('locked worker refuses a duplicate run before accessing Amazon or the source gate', async () => {
  const fake=fakeDb([candidate('B000000001')]);
  const client={...fake.client,async query(sql:string) {
    if(sql.includes('pg_try_advisory_lock')) return {rows:[{acquired:false}]};
    return fake.client.query(sql);
  }};
  let calls=0;
  const result=await runManualAmazonScan({mode:'images',limit:1,connect:async()=>client as never,
    fetch:async asin=>{calls++;return {asin,observedAt:new Date().toISOString()};}});
  assert.equal(result.state,'busy');
  assert.equal(calls,0);
  assert.ok(!fake.sql.some(text=>text.includes('source_access_blocks')));
});
