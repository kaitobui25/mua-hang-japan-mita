import { publicMembershipSql } from '../src/publication.js';
import { config } from '../src/config.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/pool.js';
import { listCatalog, getProductDetails } from '../src/catalog.js';
import { buildServer } from '../src/server.js';
import { createOrder, CheckoutError } from '../src/orders.js';
import { qualifyFixture } from './publication-fixture.js';
if (!/^\/mita_test_[a-f0-9]{16}$/.test(new URL(config.databaseUrl).pathname)) {
 throw new Error('Publication tests require a disposable mita_test database');
}
after(() => db.end());
test('group cutoff, ties, sibling evidence, search and stale toggle fail closed', async () => {
 if (!config.strictTop100) return;
 const c=await db.connect(); await c.query('BEGIN');
 try {
  await c.query('UPDATE products SET admin_hidden_at=now()');
  await c.query('UPDATE pricing_policy SET check_price_expiry=true,price_expiry_days=1 WHERE id=1');
  for(let i=0;i<103;i++) {
   const id=`P${String(i).padStart(9,'0')}`;
   await c.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter)
    VALUES($1::varchar(10),'thuc-pham-bo-sung',$1::text,'https://www.amazon.co.jp','fixture')`,[id]);
   await qualifyFixture(id,c,100);
  }
  const full=await listCatalog({page:1,limit:300},c);
  assert.equal(full.total,100); assert.equal(full.items[99].asin,'P000000099');
  for(const sort of [undefined,'popular','reviews','top-reviews','price-asc','price-desc','name','newest']) {
   assert.equal((await listCatalog({q:'P000000102',sort,page:1,limit:300},c)).total,0);
  }
  assert.equal(await getProductDetails('P000000102',c),null);
  assert.equal((await c.query(`SELECT p.asin FROM products p WHERE p.asin='P000000102' AND ${publicMembershipSql('p')}`)).rowCount,0);
  await c.query(`UPDATE products SET variant_group_basis='source_product_id',variant_group_id='low-family' WHERE asin IN ('P000000100','P000000101')`);
  await qualifyFixture('P000000100',c,60); await qualifyFixture('P000000101',c,60);
  assert.equal(await getProductDetails('P000000100',c),null); // max 60, never sum 120
  await qualifyFixture('P000000101',c,999999);
  await c.query(`UPDATE product_details SET provenance=jsonb_set(provenance,'{amazonMetrics,reviews}','[]'::jsonb) WHERE asin='P000000101'`);
  assert.equal(await getProductDetails('P000000100',c),null, 'an unqualified sibling cannot supply the family maximum');
  await c.query(`UPDATE products SET variant_group_basis=NULL,variant_group_id=NULL WHERE asin IN ('P000000100','P000000101')`);
  await qualifyFixture('P000000100',c,100); await qualifyFixture('P000000101',c,100);
  await qualifyFixture('P000000000',c,0);
  assert.equal(await getProductDetails('P000000000',c),null);
  await qualifyFixture('P000000000',c,200);
  await c.query(`UPDATE products SET variant_group_basis='source_product_id',variant_group_id='family' WHERE asin IN ('P000000000','P000000102')`);
  await c.query(`UPDATE product_details SET provenance=provenance-'amazonMetrics' WHERE asin='P000000102'`);
  assert.ok((await getProductDetails('P000000000',c))?.variants.some(p=>p.asin==='P000000102' && p.amazon===null));
  assert.equal((await listCatalog({page:1,limit:300},c)).total,100);
  await c.query(`UPDATE products SET availability='out_of_stock' WHERE asin='P000000102'`);
  assert.equal(await getProductDetails('P000000102',c),null);
  await c.query(`UPDATE products SET price_observed_at=now()-interval '2 days' WHERE asin='P000000000'`);
  assert.equal(await getProductDetails('P000000000',c),null);
  await c.query('UPDATE pricing_policy SET check_price_expiry=false WHERE id=1');
  assert.ok(await getProductDetails('P000000000',c));
  await c.query(`UPDATE products SET price_jpy=0 WHERE asin='P000000000'`);
  assert.equal(await getProductDetails('P000000000',c),null);
  await c.query(`UPDATE product_details SET provenance=provenance-'amazonMetrics'`);
  assert.equal((await listCatalog({page:1,limit:300},c)).total,0);
  assert.ok(Number((await c.query('SELECT count(*) FROM products')).rows[0].count)>=103);
 } finally {await c.query('ROLLBACK');c.release();}
});


test('explicit mode: no evidence stays public by default and fails closed when strict', async () => {
 const c=await db.connect(); await c.query('BEGIN');
 try {
  await c.query('UPDATE products SET admin_hidden_at=now()');
  await c.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,rights_status,price_jpy,sale_status,availability)
    VALUES('Z000000001','thuc-pham-bo-sung','No evidence','https://www.amazon.co.jp','fixture','verified',1000,'ready','in_stock')`);
  const list=await listCatalog({page:1,limit:100},c);
  assert.equal(list.total,config.strictTop100 ? 0 : 1);
  assert.equal(!!await getProductDetails('Z000000001',c),!config.strictTop100);
 } finally {await c.query('ROLLBACK');c.release();}
});

test('public catalog/home/search, detail/cart, variants and checkout share strict membership', async () => {
 if (!config.strictTop100) return;
 // The fixture helper refuses every non-disposable database before any writes.
 const id='Z000000002', sibling='Z000000003', excluded='Z000000004';
 await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter)
   SELECT id,'thuc-pham-bo-sung',id,'https://www.amazon.co.jp','fixture'
   FROM unnest($1::text[]) id`,[[id,sibling,excluded]]);
 const server=buildServer();
 try {
  await qualifyFixture(id); await qualifyFixture(sibling); await qualifyFixture(excluded);
  await db.query(`UPDATE products SET variant_group_basis='source_product_id',variant_group_id='endpoint-family' WHERE asin=ANY($1::text[])`,[[id,sibling]]);
  await db.query(`UPDATE product_details SET provenance=provenance-'amazonMetrics' WHERE asin=$1`,[excluded]);
  for(const url of ['/api/catalog','/api/catalog?q='+excluded,'/api/catalog?sort=price-asc&q='+excluded]) {
   const res=await server.inject({url}); assert.equal(res.statusCode,200);
   assert.ok(!res.json().items.some((p: {asin: string})=>p.asin===excluded));
  }
  assert.equal((await server.inject({url:'/api/catalog/products/'+excluded})).statusCode,404);
  const detail=(await server.inject({url:'/api/catalog/products/'+id})).json();
  assert.deepEqual(detail.variants.map((p: {asin: string})=>p.asin).sort(),[id,sibling]);
  const payload=(asin: string)=>({items:[{asin,quantity:1}],customer:{name:'Fixture',phone:'09012345678',address:'Fixture'}});
  const rejected=await server.inject({method:'POST',url:'/api/checkout',payload:payload(excluded)});
  assert.equal(rejected.statusCode,422); assert.equal(rejected.json().code,'missing_item');
  await assert.rejects(() => createOrder(payload(excluded)), (error: unknown) =>
    error instanceof CheckoutError && error.code === 'missing_item');
  assert.equal((await server.inject({method:'POST',url:'/api/checkout',payload:payload(sibling)})).statusCode,200);
 } finally {await server.close();}
});


test('metrics view requires distinct current-year exact-ASIN written evidence with verified preference', async () => {
 const c=await db.connect(); await c.query('BEGIN');
 try {
  const id='Z000000005';
  await c.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter)
    VALUES($1,'thuc-pham-bo-sung','Evidence test','https://www.amazon.co.jp','fixture')`,[id]);
  await qualifyFixture(id,c);
  const original=(await c.query('SELECT snapshot FROM amazon_product_metrics WHERE asin=$1',[id])).rows[0].snapshot;
  const qualification=async (snapshot: unknown)=>{
   await c.query(`UPDATE product_details SET provenance=jsonb_build_object('amazonMetrics',$2::jsonb) WHERE asin=$1`,[id,JSON.stringify(snapshot)]);
   return (await c.query('SELECT qualification FROM amazon_product_metrics WHERE asin=$1',[id])).rows[0]?.qualification;
  };
  assert.equal(await qualification(original),'verified');
  assert.equal(await qualification({...original,reviews:original.reviews.map((r: object)=>({...r,verifiedPurchase:false}))}),'ordinary');
  assert.equal(await qualification({...original,reviews:[original.reviews[0],original.reviews[0]]}),'unknown');
  assert.equal(await qualification({...original,reviews:original.reviews.map((r: object)=>({...r,postedAt:'2000-01-01'}))}),'unknown');
  assert.equal(await qualification({...original,reviews:original.reviews.map((r: object)=>({...r,written:false}))}),'unknown');
  assert.equal(await qualification({...original,asin:'Z999999999'}),undefined);
  assert.equal(await qualification({...original,scope:'parent'}),undefined);
 } finally {await c.query('ROLLBACK');c.release();}
});
