import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { db } from '../src/db/pool.js';
import pg from 'pg';
import { config } from '../src/config.js';
import { saveTranslationIfCurrent, saveNamesIfCurrent, markDetailTranslationFailed, sourceHash, nameHash, sourceText, translatePendingProducts } from '../src/translation/jobs.js';

after(async () => { await db.end(); });

test('translation commit is rejected when the product changed during inference', async () => {
  const asin = `Z${randomBytes(5).toString('hex').toUpperCase().slice(0, 9)}`;
  const sourceName = '商品 300g';
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter)
    VALUES($1,'thuc-pham-bo-sung',$2,$3,'test')`, [asin, sourceName, `https://www.amazon.co.jp/dp/${asin}`]);
  const source = sourceText({ name: sourceName, brand: null, features: [], ingredients: [], usage: [], specs: {}, cautions: [] });
  const output = { text: { ...source, name: 'Sản phẩm 300g' }, model: 'mock:free' };
  const connection = await db.connect();
  try {
    assert.equal(await saveTranslationIfCurrent(asin, sourceHash(source), output, connection), true);
    // Keep the pool compatible with DB_POOL_MAX=1: queries on this checked-out
    // session must not wait for another checkout from the same pool.
    await connection.query('UPDATE products SET name=$2 WHERE asin=$1', [asin, '商品 mới 400g']);
    assert.equal(await saveTranslationIfCurrent(asin, sourceHash(source), output, connection), false);
    const state = await connection.query<{ name: string; source_hash: string }>(
      `SELECT name,source_hash FROM product_translations WHERE asin=$1`, [asin]);
    assert.equal(state.rows[0].name, 'Sản phẩm 300g', 'older successful content remains unchanged');
    assert.equal(state.rows[0].source_hash, sourceHash(source));
  } finally {
    connection.release();
    await db.query('DELETE FROM products WHERE asin=$1', [asin]);
  }
});

test('verified name-only translation survives a later detail error and never overwrites current full text', async () => {
  const asin = `Y${randomBytes(5).toString('hex').toUpperCase().slice(0, 9)}`;
  const name = 'DHC ビタミン 60粒';
  await db.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter)
    VALUES($1,'thuc-pham-bo-sung',$2,$3,'test')`, [asin, name, `https://www.amazon.co.jp/dp/${asin}`]);
  const original = sourceText({ name, brand: null, features: [], ingredients: [], usage: [], specs: {}, cautions: [] });
  const hash = nameHash(original);
  const client = await db.connect();
  try {
    assert.equal(await saveNamesIfCurrent([{ asin, hash, name: 'DHC vitamin 60 viên' }], 'mock:free', client), 1);
    const row = await client.query<{ name: string; name_only: boolean; status: string; detail: unknown }>(
      'SELECT name,name_only,status,detail FROM product_translations WHERE asin=$1', [asin]);
    assert.equal(row.rows[0].name_only, true);
    assert.equal(row.rows[0].detail, null);
    assert.equal(row.rows[0].status, 'success');
    await markDetailTranslationFailed(asin, sourceHash(original), client);
    const retained = await client.query<{ name_only: boolean; status: string; source_hash: string }>(
      'SELECT name_only,status,source_hash FROM product_translations WHERE asin=$1', [asin]);
    assert.equal(retained.rows[0].status, 'success', 'free model detail failure cannot hide validated title');
    assert.equal(retained.rows[0].name_only, true);
    assert.equal(retained.rows[0].source_hash, hash, 'retain independent title hash');
    assert.equal(await saveNamesIfCurrent([{ asin, hash, name: 'DHC translation overwritten' }], 'mock:free', client), 0);
    assert.equal(await saveTranslationIfCurrent(asin, sourceHash(original), { text: { ...original, name: 'DHC vitamin 60 viên' }, model: 'mock:free' }, client), true);
    const full = await client.query<{ name_only: boolean }>('SELECT name_only FROM product_translations WHERE asin=$1', [asin]);
    assert.equal(full.rows[0].name_only, false);
    assert.equal(await saveNamesIfCurrent([{ asin, hash, name: 'wrong' }], 'mock:free', client), 0);
  } finally {
    client.release();
    await db.query('DELETE FROM products WHERE asin=$1', [asin]);
  }
});

test('separate worker cannot spend free translation quota while another process owns the DB lock', async () => {
  const owner = new pg.Client({ connectionString: config.databaseUrl });
  await owner.connect();
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    await owner.query('SELECT pg_advisory_lock(70400300)');
    process.env.OPENROUTER_API_KEY = 'fixture-not-a-real-key';
    assert.deepEqual(await translatePendingProducts(1), { translated: 0, failed: 0, skipped: 0 });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await owner.query('SELECT pg_advisory_unlock(70400300)');
    await owner.end();
  }
});
