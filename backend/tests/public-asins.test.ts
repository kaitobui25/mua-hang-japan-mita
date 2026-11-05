import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { PoolClient } from 'pg';
import { db } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { listPublicAsins, publicVisibilitySql } from '../src/catalog.js';
import { buildServer } from '../src/server.js';

after(() => db.end());

test('inventory makes one bounded ASIN-only query using public visibility', async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    return { rows: [{ asin: 'A000000001' }, { asin: 'A000000002' }] };
  } } as unknown as Pick<PoolClient, 'query'>;
  assert.deepEqual(await listPublicAsins(client), { asins: ['A000000001', 'A000000002'], total: 2 });
  assert.deepEqual(statements, [`SELECT asin FROM products WHERE ${publicVisibilitySql} ORDER BY asin ASC LIMIT 50001`]);
  const overflow = { query: async () => ({ rows: Array.from({ length: 50_001 }, () => ({ asin: 'A000000001' })) }) } as unknown as Pick<PoolClient, 'query'>;
  await assert.rejects(listPublicAsins(overflow), /exceeds sitemap capacity/);
});

test('public inventory route exposes only ASINs and fails with 503 on DB errors', async t => {
  const server = buildServer();
  const query = t.mock.method(db, 'query', async () => ({ rows: [{ asin: 'A000000001' }] }));
  try {
    const response = await server.inject({ method: 'GET', url: '/api/catalog/asins' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { asins: ['A000000001'], total: 1 });
    query.mock.mockImplementation(async () => { throw new Error('private database error'); });
    const failed = await server.inject({ method: 'GET', url: '/api/catalog/asins' });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { error: 'Public ASIN inventory unavailable' });
  } finally { query.mock.restore(); await server.close(); }
});

// Execute the real frontend modules with only their external dependencies mocked.
// This covers the complete fetch -> validation -> sitemap path without Next/.next.
function loadModule(path: string, dependencies: Record<string, unknown>, fetcher?: typeof fetch) {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } });
  runInNewContext(outputText, { exports, process: { env: { API_PORT: '4000' } },
    AbortSignal, URLSearchParams, fetch: fetcher, require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    } });
  return exports;
}

function frontend(fetcher: typeof fetch) {
  const catalog = loadModule('../../src/lib/server-catalog.ts', {
    'server-only': {}, react: { cache: (fn: unknown) => fn },
  }, fetcher);
  const format = loadModule('../../src/lib/format.ts', {});
  const sitemap = loadModule('../../src/app/sitemap.ts', {
    '@/lib/server-catalog': catalog, '@/lib/format': format,
  });
  return sitemap.default as () => Promise<{ url: string }[]>;
}

test('sitemap retains all static URLs and all variants using exactly one inventory fetch', async () => {
  const requests: string[] = [];
  const sitemap = frontend((async (input, options) => {
    requests.push(String(input));
    assert.equal(options?.cache, 'no-store');
    return Response.json({ asins: ['A000000001', 'A000000002'], total: 2 });
  }) as typeof fetch);
  const paths = (await sitemap()).map(entry => new URL(entry.url).pathname);
  assert.deepEqual([...paths], ['/', '/san-pham', '/danh-gia', '/cach-mua-hang', '/gio-hang', '/thanh-toan',
    '/mua-ho-amazon', '/danh-muc/thuc-pham-bo-sung', '/danh-muc/thuc-pham-cho-be',
    '/san-pham/A000000001', '/san-pham/A000000002']);
  assert.deepEqual(requests, ['http://127.0.0.1:4000/api/catalog/asins']);
});

test('sitemap fails closed on unavailable, malformed, missing, duplicate or empty inventory', async () => {
  for (const inventory of [null, {}, { asins: [], total: 0 }, { asins: ['A000000001'], total: 2 },
    { asins: ['A000000001'], total: '1' }, { asins: [null], total: 1 },
    { asins: ['a000000001'], total: 1 }, { asins: ['A000000001\n'], total: 1 },
    { asins: ['<invalid>'], total: 1 }, { asins: ['A000000001', 'A000000001'], total: 2 }]) {
    await assert.rejects(frontend((async () => Response.json(inventory)) as typeof fetch)(), /inventory/);
  }
  await assert.rejects(frontend((async () => new Response('unavailable', { status: 503 })) as typeof fetch)(), /HTTP 503/);
  await assert.rejects(frontend((async () => new Response('{')) as typeof fetch)());
  await assert.rejects(frontend((async () => { throw new Error('connection refused'); }) as typeof fetch)());
});

test('sitemap enforces the 50,000 URL limit including static URLs', async () => {
  const inventory = (length: number) => ({
    asins: Array.from({ length }, (_, i) => `A${String(i).padStart(9, '0')}`), total: length,
  });
  assert.equal((await frontend((async () => Response.json(inventory(49_991))) as typeof fetch)()).length, 50_000);
  await assert.rejects(frontend((async () => Response.json(inventory(49_992))) as typeof fetch)(), /50,000/);
  await assert.rejects(frontend((async () => Response.json(inventory(50_001))) as typeof fetch)(), /inventory/);
});

const database = new URL(config.databaseUrl).pathname.slice(1);
const disposable = /^mita_test_[a-f0-9]{16}$/.test(database) && process.env.MITA_DISPOSABLE_TEST_DATABASE === database;
test('inventory includes non-checkout public variants, excludes hidden ASINs and follows owner policy',
  { skip: !disposable }, async () => {
    const client = await db.connect();
    try {
      assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, database);
      await client.query('BEGIN');
      // Only the runner-created disposable DB is ever modified by this fixture.
      for (const [asin, rights, hidden] of [
        ['G100000001', 'verified', false], ['G100000002', 'verified', false],
        ['G100000003', 'verified', true], ['G100000004', 'local_test_only', false],
        ['G100000005', 'unverified', false], ['G100000006', 'local_test_only', true],
      ] as const) {
        await client.query(`INSERT INTO products(asin,category_slug,name,source_url,source_adapter,
          rights_status,admin_hidden_at,variant_group_basis,variant_group_id)
          VALUES($1,'thuc-pham-bo-sung','Inventory fixture','https://www.amazon.co.jp/dp/test','test',
          $2,CASE WHEN $3 THEN now() ELSE NULL END,'parent_asin','G100000000')`, [asin, rights, hidden]);
      }
      for (const hide of [false, true]) {
        await client.query('UPDATE catalog_settings SET hide_local_test_only=$1 WHERE id=1', [hide]);
        const expected = hide ? ['G100000001', 'G100000002'] : ['G100000001', 'G100000002', 'G100000004', 'G100000005'];
        const inventory = await listPublicAsins(client);
        assert.deepEqual(inventory.asins.filter(asin => asin.startsWith('G1')), expected);
        assert.equal(inventory.total, inventory.asins.length);
        assert.deepEqual(inventory.asins, [...inventory.asins].sort());
        const sitemap = await frontend((async () => Response.json(inventory)) as typeof fetch)();
        assert.deepEqual([...sitemap.filter(entry => /\/san-pham\//.test(entry.url)).map(entry => entry.url.split('/').pop())], inventory.asins);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
