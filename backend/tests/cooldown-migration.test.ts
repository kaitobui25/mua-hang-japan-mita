import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../src/config.js';

const sql = (file: string) => readFile(new URL(`../src/db/${file}`, import.meta.url), 'utf8');
test('legacy migration preserves history and attempts, resolves duplicate imports, and retires only the old gate once', async () => {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  const contender = new pg.Client({ connectionString: config.databaseUrl });
  const schema = `cooldown_migration_${randomBytes(6).toString('hex')}`;
  await client.connect(); await contender.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(await sql('schema.sql'));
    await client.query((await sql('admin.sql')).replace("('pending','running','succeeded','failed')", "('pending','running','succeeded','failed','needs_human')"));
    await client.query(`ALTER TABLE product_detail_queue DROP CONSTRAINT product_detail_queue_state_check;
      ALTER TABLE product_detail_queue ADD CONSTRAINT product_detail_queue_state_check CHECK(state IN ('pending','success','failed','needs_human'));
      INSERT INTO admin_accounts(password_hash) VALUES('fixture');
      INSERT INTO product_detail_queue(category_slug,asin,state,last_attempt_at)
      VALUES('thuc-pham-bo-sung','M000000001','needs_human','2026-10-27T01:00:00Z'),
            ('thuc-pham-cho-be','M000000002','needs_human','2026-10-27T02:00:00Z');
      INSERT INTO sync_runs(state,saved_count) VALUES('needs_human',0),('needs_human',3);
      INSERT INTO sync_errors(sync_run_id,state,message) VALUES(1,'needs_human','historic CAPTCHA');
      INSERT INTO source_access_blocks(source,reason,continuation_due_at,timeout_recorded_at) VALUES('amazon.co.jp','old verified CAPTCHA','2026-10-27T01:00:30Z','2026-10-27T01:00:31Z');
      INSERT INTO products(asin,category_slug,name,source_url,source_adapter,price_jpy,price_observed_at)
      VALUES('M000000001','thuc-pham-bo-sung','Good snapshot','https://www.amazon.co.jp/dp/M000000001','fixture',1234,'2026-10-27T01:00:00Z');
      INSERT INTO price_observations(asin,price_jpy,observed_at,source_adapter)
      VALUES('M000000001',1234,'2026-10-27T01:00:00Z','fixture');
      INSERT INTO admin_audit_events(actor_id,action,object_id) VALUES(1,'historic','fixture');
      INSERT INTO catalog_import_requests(id,asin,category_slug,actor_id,state,error) VALUES
      ('00000000-0000-0000-0000-000000000001','M000000003','thuc-pham-bo-sung',1,'needs_human','historic error 1'),
      ('00000000-0000-0000-0000-000000000002','M000000003','thuc-pham-bo-sung',1,'needs_human','historic error 2'),
      ('00000000-0000-0000-0000-000000000003','M000000004','thuc-pham-bo-sung',1,'running',NULL),
      ('00000000-0000-0000-0000-000000000004','M000000004','thuc-pham-bo-sung',1,'needs_human','historic error 4');`);
    const oldBlock = (await client.query('SELECT to_jsonb(b) AS snapshot FROM source_access_blocks b')).rows[0].snapshot;
    const before = await client.query(`SELECT last_attempt_at FROM product_detail_queue ORDER BY asin`);
    const snapshots = await client.query('SELECT row_to_json(p) AS snapshot FROM products p');
    const prices = await client.query('SELECT row_to_json(p) AS snapshot FROM price_observations p');
    await client.query('BEGIN');
    await client.query(await sql('remove-needs-human.sql'));
    assert.equal((await contender.query('SELECT pg_try_advisory_lock(70400200) AS acquired')).rows[0].acquired, false);
    await client.query('COMMIT');
    assert.deepEqual((await client.query('SELECT state FROM sync_runs ORDER BY id')).rows.map(r => r.state), ['failed','partial']);
    assert.deepEqual((await client.query('SELECT state FROM product_detail_queue ORDER BY asin')).rows.map(r => r.state), ['pending','pending']);
    assert.deepEqual((await client.query('SELECT last_attempt_at FROM product_detail_queue ORDER BY asin')).rows, before.rows);
    assert.deepEqual((await client.query('SELECT state,message FROM sync_errors')).rows, [{ state: 'needs_human', message: 'historic CAPTCHA' }]);

    assert.deepEqual((await client.query('SELECT row_to_json(p) AS snapshot FROM products p')).rows, snapshots.rows);
    assert.deepEqual((await client.query('SELECT row_to_json(p) AS snapshot FROM price_observations p')).rows, prices.rows);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM admin_audit_events')).rows[0].n, 1);
    assert.deepEqual((await client.query('SELECT state FROM catalog_import_requests ORDER BY id')).rows.map(r => r.state), ['pending','failed','running','failed']);
    assert.equal((await client.query('SELECT error FROM catalog_import_requests ORDER BY id')).rows[0].error, 'historic error 1');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM source_access_blocks')).rows[0].n, 0);
    assert.equal((await client.query('SELECT reason FROM source_access_block_history')).rows[0].reason, 'old verified CAPTCHA');
    assert.deepEqual((await client.query('SELECT block_snapshot FROM source_access_block_history')).rows[0].block_snapshot, oldBlock);
    await client.query(`INSERT INTO source_access_blocks(source,reason,retry_after_at) VALUES('amazon.co.jp','fresh denial',now()+interval '1 day')`);
    const fresh = (await client.query('SELECT * FROM source_access_blocks')).rows;
    await client.query('BEGIN'); await client.query(await sql('remove-needs-human.sql')); await client.query('COMMIT');
    assert.deepEqual((await client.query('SELECT * FROM source_access_blocks')).rows, fresh);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM source_access_block_history')).rows[0].n, 1);
    // Even on a first migration, a new-format block must survive Q5=A.
    await client.query(`DELETE FROM data_migrations`);
    await client.query('BEGIN'); await client.query(await sql('remove-needs-human.sql')); await client.query('COMMIT');
    assert.deepEqual((await client.query('SELECT * FROM source_access_blocks')).rows, fresh);
    for (const table of ['sync_runs','product_detail_queue','catalog_import_requests']) {
      await assert.rejects(client.query(`UPDATE ${table} SET state='needs_human'`), (error: unknown) => (error as { code?: string }).code === '23514');
    }
  } finally {
    await client.query('ROLLBACK');
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end(); await contender.end();
  }
});
