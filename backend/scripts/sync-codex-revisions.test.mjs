import test from 'node:test';
import assert from 'node:assert/strict';
import {tableSpecs,insertSql,codexRevisionMissing} from './sync-catalog-vps.mjs';

const row={asin:'B000000001',name:'Tên Việt mới',name_model:'gpt-6.1-sol',status:'warning',
  name_source:{name:'DHC 500mg'},name_generation:'00000000-0000-4000-8000-000000000001',name_revision:'42'};

test('Codex revisions are propagated even over a previously successful VPS title',()=>{
  const spec=tableSpecs.find(([name])=>name==='product_translations');
  assert.ok(spec);
  const sql=insertSql(...spec);
  assert.match(sql,/EXCLUDED\.name_revision>product_translations\.name_revision/);
  assert.match(sql,/EXCLUDED\.name_source->>'name'=\(SELECT p\.name FROM products/);
  assert.match(sql,/name_generation=CASE/);
  assert.match(sql,/name_issues=CASE/);
  assert.match(sql,/detail_approved=CASE WHEN/);
  assert.match(sql,/EXCLUDED\.updated_at>product_translations\.updated_at OR/);
  assert.equal(codexRevisionMissing(row,{name:'Tên cũ',status:'success',name_revision:null},{name:'DHC 500mg'}),true);
  assert.equal(codexRevisionMissing(row,{name:'Tên mới',status:'warning',name_revision:'42',name_generation:row.name_generation},{name:'DHC 500mg'}),true);
  assert.equal(codexRevisionMissing(row,{...row},{name:'DHC 500mg'}),false);
  assert.equal(codexRevisionMissing(row,{name:'VPS mới hơn',name_revision:'43'},{name:'DHC 500mg'}),false);
});

test('Invalid or stale Codex provenance cannot silently overwrite a VPS success',()=>{
  const target={name:'DHC 500mg'};
  assert.equal(codexRevisionMissing({...row,name_revision:null},{name:'Remote'},target),false);
  assert.equal(codexRevisionMissing({...row,name_model:'openrouter'},{name:'Remote'},target),false);
  assert.equal(codexRevisionMissing({...row,status:'failed'},{name:'Remote'},target),false);
  assert.equal(codexRevisionMissing(row,{name:'Remote',name_revision:null},{name:'Amazon changed'}),true);
});
