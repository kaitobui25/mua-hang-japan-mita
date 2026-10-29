import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tableSpecs, insertSql, assertCompatibleSnapshots,
  translationCoverageMissing, galleryNeedsSync, verifyContents,
} from './sync-catalog-vps.mjs';

const conflict = table => tableSpecs.find(([name]) => name === table)[2];

test('module can be imported without CLI arguments, credentials or connections', () => {
  assert.equal(tableSpecs.length, 9);
  assert.ok(tableSpecs.some(([name]) => name === 'product_title_presentations'));
});

test('published title metadata uses one preservation decision', () => {
  const sql = conflict('product_translations');
  for (const field of ['name','model','status','translated_at','name_source','name_issues']) {
    const assignment = sql.match(new RegExp(`${field}=CASE WHEN ([\\s\\S]*?) THEN product_translations\\.${field} ELSE EXCLUDED\\.${field} END`));
    assert.ok(assignment, field);
    assert.match(assignment[1], /status='success'/);
    assert.match(assignment[1], /status='warning'/);
    assert.match(assignment[1], /EXCLUDED.name IS NULL/);
  }
  assert.doesNotMatch(sql, /name_source=COALESCE/);
});

test('approved detail, visibility and approval flag stay together', () => {
  const sql = conflict('product_translations');
  for (const field of ['detail','name_only','detail_approved']) {
    assert.match(sql, new RegExp(`${field}=CASE WHEN \\([\\s\\S]*?product_translations.detail_approved[\\s\\S]*? THEN product_translations\\.${field} ELSE EXCLUDED\\.${field} END`));
  }
  assert.doesNotMatch(sql, /detail_approved=\(/);
});

test('price observation timestamp cannot advance on a missing price', () => {
  const sql = conflict('products');
  assert.match(sql, /price_jpy=CASE WHEN EXCLUDED.price_jpy IS NOT NULL AND EXCLUDED.price_observed_at IS NOT NULL/);
  assert.match(sql, /price_observed_at=CASE WHEN EXCLUDED.price_jpy IS NOT NULL THEN/);
  assert.doesNotMatch(sql, /(?:rights_status|admin_hidden_at|sale_status)\s*=/);
});

const snapshots = snapshots => ({local_detail_translations:snapshots});
const target = rows => ({query:async sql => {
  assert.equal(sql, 'SELECT asin,snapshot FROM local_detail_translations');
  return {rows};
}});

test('frozen snapshots compare JSON content independent of object key order', async () => {
  await assertCompatibleSnapshots(snapshots([{asin:'A',snapshot:{a:[],b:{c:1}}}]),
    target([{asin:'A',snapshot:{b:{c:1},a:[]}}]));
});

test('different frozen source generation fails before any slot writes', async () => {
  await assert.rejects(assertCompatibleSnapshots(snapshots([{asin:'A',snapshot:{features:['new']}}]),
    target([{asin:'A',snapshot:{features:['old']}}])), /Frozen detail snapshot differs for A/);
});

test('new immutable snapshot is allowed', async () => {
  await assertCompatibleSnapshots(snapshots([{asin:'A',snapshot:{}}]), target([]));
});

test('newer failed title cannot satisfy per-identity published coverage', () => {
  const source = {name:'published',status:'warning'};
  assert.equal(translationCoverageMissing('product_translations',source,{name:null,status:'failed',updated_at:'2099-01-01'}),true);
  assert.equal(translationCoverageMissing('product_translations',source,{name:'remote',status:'success'}),false);
  assert.equal(translationCoverageMissing('local_detail_translation_items',{translated:'text'},{translated:null}),true);
});

test('approved detail must remain visible', () => {
  const source = {detail_approved:true,detail:{}};
  assert.equal(translationCoverageMissing('product_translations',source,{detail:{},detail_approved:true,name_only:true}),true);
  assert.equal(translationCoverageMissing('product_translations',source,{detail:{},detail_approved:true,name_only:false}),false);
});

const image = (id,position,day) => ({asin:'A',position,source_url:`https://m.media-amazon.com/images/I/${id}.jpg`,source_observed_at:`2026-10-${day}T00:00:00Z`});
test('gallery verification respects newer remote galleries and partial preservation', () => {
  assert.equal(galleryNeedsSync([image('old',1,20)],[image('new',1,21)]),false);
  const remote = [image('old',1,20),image('fresh',2,21)];
  assert.equal(galleryNeedsSync([image('fresh',1,21)],remote),false);
  assert.equal(galleryNeedsSync([image('fresh',1,21)],[image('old',1,20)]),true);
});

test('generated SQL keeps values parameterized and source-bound slot updates', () => {
  for (const [name,columns,policy] of tableSpecs) {
    assert.match(insertSql(name,columns,policy), /jsonb_to_recordset\(\$1::jsonb\)/);
    assert.match(insertSql(name,columns,policy), /WHERE true ON CONFLICT/);
  }
  assert.match(conflict('local_detail_translation_items'), /local_detail_translation_items.source=EXCLUDED.source/);
  assert.match(conflict('local_detail_translation_items'), /EXCLUDED.translated IS NOT NULL OR local_detail_translation_items.translated IS NULL/);
});

// Exercise the verifier against in-memory query results, including extra VPS
// rows that used to mask missing translations in aggregate count checks.
const emptyCatalog = () => Object.fromEntries(
  [...tableSpecs.map(([name]) => name), 'product_images'].map(name => [name, []]));
const catalogClient = catalog => ({query:async sql => {
  const table = sql.match(/^SELECT \* FROM "([a-z_]+)"$/)?.[1];
  assert.ok(table, `Unexpected verifier query: ${sql}`);
  return {rows:catalog[table]};
}});

test('verification rejects a missing title despite extra published VPS rows', async () => {
  const source=emptyCatalog(), remote=emptyCatalog();
  source.product_translations=[{asin:'A',locale:'vi',name:'local',status:'success'}];
  remote.product_translations=[{asin:'B',locale:'vi',name:'extra',status:'success'},
    {asin:'C',locale:'vi',name:'extra',status:'warning'}];
  const result=await verifyContents(source,catalogClient(remote));
  assert.equal(result.mismatched,1);
  assert.equal(result.report.find(row=>row.table==='product_translations').missing,1);
});

test('verification catches lost title coverage even with a newer VPS timestamp', async () => {
  const source=emptyCatalog(), remote=emptyCatalog();
  source.product_translations=[{asin:'A',locale:'vi',name:'local',status:'warning',updated_at:'2026-10-20'}];
  remote.product_translations=[{asin:'A',locale:'vi',name:null,status:'failed',updated_at:'2026-10-21'}];
  assert.equal((await verifyContents(source,catalogClient(remote))).mismatched,1);
});

test('verification accepts preserved clean atomic text and partial gallery positions', async () => {
  const source=emptyCatalog(), remote=emptyCatalog();
  source.local_detail_translation_items=[{asin:'A',slot:'features:0',source:'original',translated:'local',updated_at:'2026-10-21'}];
  remote.local_detail_translation_items=[{asin:'A',slot:'features:0',source:'original',translated:'approved',warning:false,updated_at:'2026-10-20'}];
  source.product_images=[image('fresh',1,21)];
  remote.product_images=[image('old',1,20),image('fresh',2,21)];
  assert.equal((await verifyContents(source,catalogClient(remote))).mismatched,0);
});
