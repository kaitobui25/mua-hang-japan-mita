import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { config } from '../src/config.js';
// @ts-ignore: synchronization module is a native JS CLI with no declarations.
import { insertSql, tableSpecs } from '../scripts/sync-catalog-vps.mjs';

const database = new URL(config.databaseUrl).pathname.slice(1);
const disposable = /^mita_test_[a-f0-9]{16}$/.test(database) &&
  process.env.MITA_DISPOSABLE_TEST_DATABASE === database;

test('Disposable DB: newer Codex title wins over VPS success without replacing approved details',
  { skip: !disposable }, async () => {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
    const client = await pool.connect();
    const spec = tableSpecs.find(([name]: [string]) => name === 'product_translations');
    assert.ok(spec);
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO categories(slug,name,amazon_seed_url)
        VALUES('codex-sync-test','Synthetic','https://example.com')`);
      await client.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter)
        VALUES('Z000000001','codex-sync-test','DHC 500mg','https://example.com','synthetic')`);
      await client.query(`INSERT INTO product_translations(asin,locale,name,detail,source_hash,model,status,
        name_only,detail_approved,updated_at)
        VALUES('Z000000001','vi','Tên VPS đã duyệt','{"features":["Approved detail"]}',
          'approved-hash','approved-model','success',false,true,'2026-10-01T00:00:00Z')`);
      const incoming = (revision: number, title: string, updatedAt: string) => ({
        asin:'Z000000001',locale:'vi',name:title,detail:null,source_hash:'name-only-hash',
        model:'gpt-6.1-sol',status:'warning',translated_at:updatedAt,updated_at:updatedAt,
        name_only:true,name_attempts:1,detail_approved:false,name_source:{name:'DHC 500mg',brand:'DHC'},
        name_issues:['units_changed'],name_revision:revision,
        name_generation:'00000000-0000-4000-8000-000000000001',name_model:'gpt-6.1-sol'
      });
      const push = (row: unknown) => client.query(insertSql(...spec),[JSON.stringify([row])]);
      await push(incoming(42,'Tên Codex cảnh báo','2026-11-02T00:00:00Z'));
      const read = async () => (await client.query(`SELECT name,detail,source_hash,status,name_revision,
        detail_approved,name_only FROM product_translations WHERE asin='Z000000001'`)).rows[0];
      let result = await read();
      assert.equal(result.name,'Tên Codex cảnh báo');
      assert.equal(result.status,'warning');
      assert.equal(result.name_revision,'42');
      assert.equal(result.source_hash,'approved-hash');
      assert.deepEqual(result.detail,{features:['Approved detail']});
      assert.equal(result.detail_approved,true);
      assert.equal(result.name_only,false);
      await push(incoming(41,'Stale Codex','2026-11-03T00:00:00Z'));
      assert.equal((await read()).name,'Tên Codex cảnh báo');
      // Remote detail/metadata may have a later timestamp than the next title.
      await push(incoming(43,'Tên Codex mới hơn','2026-11-02T12:00:00Z'));
      result = await read();
      assert.equal(result.name,'Tên Codex mới hơn');
      assert.equal(result.name_revision,'43');
      assert.deepEqual(result.detail,{features:['Approved detail']});
    } finally {
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
      await pool.end();
    }
  });
