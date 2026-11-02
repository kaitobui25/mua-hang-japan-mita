import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { parseEvidence, compareProducts, compareOverview, MAX_PRODUCTS } from '../src/admin/desktop-diagnostics-model.js';
import { isPcDatabase, parseSshOutput, sshInvocation, snapshotSql, snapshotSqlWithoutTitles } from '../src/admin/desktop-diagnostics-source.js';
import { diagnosticsQuery, registerDesktopDiagnostics } from '../src/admin/desktop-diagnostics.js';
import { adminRoutes } from '../src/admin/routes.js';

const time = new Date().toISOString();
const streams = ['catalog_issues', 'catalog_runs', 'translation_runs', 'vps_sync_ledger'].map(id => ({ id, status: 'available', truncated: false }));
function product(asin = 'B000000001') {
  return { asin, originalName: 'Original source name', fullVietnameseName: 'Sản phẩm Nhật Bản 100 g',
    shortVietnameseName: 'Sản phẩm 100 g', coverUrl: 'https://m.media-amazon.com/images/I/cover.jpg', brand: null, omittedFacts: [],
    images: [{ url: 'https://m.media-amazon.com/images/I/a.jpg', observedAt: time }],
    sourceAdapter: 'amazon', sourceObservedAt: time, updatedAt: time, translatedAt: time, shortTitleUpdatedAt: time,
    translationStatus: 'success', nameOnly: true };
}
function raw(products = [product()]) {
  return { capturedAt: time, database: 'mita', serverAddress: '127.0.0.1', serverPort: 5432,
    tables: [{ name: 'products', columns: 10, indexes: 2 }], products,
    catalog: { products: products.length, translations: products.length, images: products.length, details: 0 },
    logs: { status: 'available', truncated: false, sources: streams,
      events: [{ timestamp: time, code: 'catalog_issue', message: 'secret token/customer/payload' }] } };
}
function evidence(products = [product()]) { return parseEvidence(raw(products), 'pc'); }

test('compares full ASIN union, unabridged titles, valid compact titles and ordered source images', () => {
  const pc = evidence([product(), product('B000000002')]);
  const changed = product();
  changed.images.push({ url: 'https://m.media-amazon.com/images/I/b.jpg', observedAt: time });
  const vps = evidence([changed, product('B000000003')]);
  const rows = compareProducts(pc.products, vps.products);
  assert.deepEqual(rows.map(row => row.asin), ['B000000001', 'B000000002', 'B000000003']);
  assert.deepEqual(rows[0].differences, ['images']);
  assert.deepEqual(rows[1].differences, ['presence']);
  assert.equal(rows[1].vps, null);
  const reversed = evidence([{ ...changed, images: [...changed.images].reverse() }]);
  assert.deepEqual(compareProducts(vps.products.slice(0, 1), reversed.products)[0].differences, ['images']);
  const renamed = evidence([{ ...product(), fullVietnameseName: 'Sản phẩm Nhật Bản 200 g', shortVietnameseName: 'Sản phẩm 200 g' }]);
  assert.deepEqual(compareProducts(pc.products.slice(0, 1), renamed.products)[0].differences,
    ['fullVietnameseName', 'shortVietnameseName']);
  const observed = evidence([{ ...product(), updatedAt: '2020-01-01T00:00:00Z' }]);
  assert.equal(compareProducts(pc.products.slice(0, 1), observed.products)[0].different, false);
  const replacedCover = evidence([{ ...product(), coverUrl: 'https://m.media-amazon.com/images/I/new-cover.jpg' }]);
  assert.deepEqual(compareProducts(pc.products.slice(0, 1), replacedCover.products)[0].differences, ['images']);
});

test('invalid or unsourced short names fall back; missing Vietnamese preserves original and notice', () => {
  const invalid = evidence([{ ...product(), shortVietnameseName: 'Sản phẩm 999 g' }]).products[0];
  assert.equal(invalid.shortVietnameseName, null);
  assert.equal(invalid.displayName, invalid.fullVietnameseName);
  const missing = parseEvidence({ ...raw(), products: [{ ...product(), fullVietnameseName: null,
    shortVietnameseName: 'Sản phẩm 100 g' }] }, 'pc').products[0];
  assert.equal(missing.displayName, missing.originalName);
  assert.equal(missing.nameNotice, 'Chưa có tên Việt');
  assert.equal(evidence().products[0].displayName, 'Sản phẩm 100 g');
  assert.equal(evidence().products[0].translationScope, 'name_only');
});

test('overview counts real schema and treats environment-only tables as information', () => {
  const pc = evidence(); const vps = evidence();
  pc.tables.push({ name: 'orders', columns: 12, indexes: 3 });
  vps.tables.push({ name: 'mita_sync_ledger', columns: 8, indexes: 1 });
  const overview = compareOverview(pc, vps);
  assert.equal(overview.pc.tableCount, 2);
  assert.equal(overview.pc.columnCount, 22);
  assert.equal(overview.pc.indexCount, 5);
  assert.deepEqual(overview.tableDifferences.map(row => [row.name, row.syncError]), [['mita_sync_ledger', false], ['orders', false]]);
});

test('parsers fail closed on duplicates, truncated evidence, invalid URLs, unknown events and unbounded payloads', () => {
  assert.throws(() => evidence([product(), product()]));
  assert.throws(() => parseEvidence({ ...raw(), catalog: { ...raw().catalog, products: 10 } }, 'pc'));
  assert.throws(() => evidence([{ ...product(), images: [{ url: 'https://evil.test/a', observedAt: time }] }]));
  assert.throws(() => evidence([{ ...product(), coverUrl: 'https://evil.test/cover.jpg' }]));
  assert.throws(() => evidence([{ ...product(), images: [{ url: 'https://m.media-amazon.com/a?token=secret', observedAt: time }] }]));
  assert.throws(() => parseEvidence({ ...raw(), products: Array(MAX_PRODUCTS + 1).fill(product()) }, 'vps'));
  assert.throws(() => parseEvidence({ ...raw(), logs: { ...raw().logs, events: [{ timestamp: time, code: 'arbitrary secret text' }] } }, 'pc'));
  assert.throws(() => parseSshOutput('banner\n{}\n[]\nnull\nnull'));
  const result = parseSshOutput([JSON.stringify(raw()), JSON.stringify(raw().logs.events), 'null', '[]', '[]'].join('\n'));
  assert.equal(result.logs.sources[1].status, 'missing');
  assert.equal(result.logs.sources[2].status, 'available');
  assert.equal(result.logs.events[0].source, 'vps');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('payload'));
  const plentiful = Array.from({ length: 900 }, () => ({ timestamp: time, code: 'catalog_issue' }));
  const many = parseSshOutput([JSON.stringify(raw()), ...Array.from({ length: 4 }, () => JSON.stringify(plentiful))].join('\n'));
  assert.equal(many.logs.events.length, 3000);
  assert.equal(many.logs.truncated, true);
});

test('transport is Windows-only, pinned, explicitly disableable and cannot accept tunnel/URL/SQL input', () => {
  assert.equal(isPcDatabase('postgresql://user@127.0.0.1:5433/postgres'), true);
  for (const url of ['postgresql://user@127.0.0.1:15432/mita', 'postgresql://remote:5433/mita',
    'postgresql://127.0.0.1:5433/postgres?host=remote', 'garbage']) assert.equal(isPcDatabase(url), false);
  assert.equal(sshInvocation('win32', { MITA_DESKTOP_DIAGNOSTICS_SSH: '0' }), null);
  assert.equal(sshInvocation('linux', { MITA_DESKTOP_DIAGNOSTICS_SSH: '1' }), null);
  const command = sshInvocation('win32', { MITA_DESKTOP_DIAGNOSTICS_SSH: '1', USERPROFILE: 'C:\\Users\\test', SystemRoot: 'C:\\Windows' })!;
  assert.ok(command.args.includes('ubuntu@217.142.225.255'));
  assert.ok(command.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(command.args.includes('BatchMode=yes'));
  assert.ok(command.args.includes('ClearAllForwardings=yes'));
  assert.ok(command.args.at(-1)!.includes('default_transaction_read_only=on'));
  assert.ok(snapshotSql.includes('LIMIT 20001'));
  assert.ok(snapshotSql.includes('p.image_url AS "coverUrl"'));
  assert.ok(!snapshotSqlWithoutTitles.includes('LEFT JOIN product_title_presentations'));
  assert.ok(snapshotSqlWithoutTitles.includes('NULL::text'));
  for (const input of [{ sql: 'SELECT secret' }, { url: 'http://remote' }, { path: '/etc/passwd' }, { hours: ['1'] }]) {
    assert.throws(() => diagnosticsQuery(input, ['hours']));
  }
});

test('real admin scope rejects unauthenticated, remote and forged forwarded requests without database access', async () => {
  const server = Fastify();
  server.register(adminRoutes, { prefix: '/api/admin' });
  try {
    for (const path of ['snapshot', 'products', 'overview', 'logs']) {
      const url = `/api/admin/desktop/${path}`;
      assert.equal((await server.inject({ url, headers: { host: 'localhost:4000' } })).statusCode, 401);
      assert.equal((await server.inject({ url, remoteAddress: '192.0.2.1', headers: {
        host: 'localhost:4000', 'x-forwarded-for': '127.0.0.1' } })).statusCode, 403);
      assert.equal((await server.inject({ url, headers: { host: 'evil.test:4000' } })).statusCode, 403);
    }
  } finally { await server.close(); }
});

test('Staff reads stable pages, snapshots bind sessions and refresh failure never reuses data', async () => {
  const server = Fastify();
  let session = 'session-one'; let fail = false; let reads = 0;
  server.decorateRequest('adminSession', null);
  server.addHook('onRequest', async request => {
    request.adminSession = { actorId: 1, role: 'staff', csrfToken: session, expiresAt: new Date(Date.now() + 60000) };
  });
  server.setErrorHandler((error, _request, reply) => reply.code((error as { status?: number }).status ?? 500).send({ error: 'safe' }));
  registerDesktopDiagnostics(server, { pc: async () => { reads++; return evidence([product(), product('B000000002')]); },
    vps: async () => { if (fail) throw new Error('secret remote stderr'); return evidence(); } },
    async () => ({ events: [{ source: 'pc', timestamp: time, category: 'sync', severity: 'warning', title: 'Đồng bộ VPS giữ lại ảnh' }],
      streams: [{ id: 'supervisor', status: 'available', truncated: false },
        { id: 'port_control', status: 'empty', truncated: false },
        { id: 'backend_control', status: 'missing', truncated: false }], truncated: false }));
  try {
    const refresh = await server.inject('/desktop/snapshot');
    assert.equal(refresh.statusCode, 200);
    const id = refresh.json().snapshotId;
    const first = await server.inject(`/desktop/products?snapshotId=${id}&pageSize=1`);
    assert.equal(first.json().total, 2);
    assert.equal(first.json().items[0].asin, 'B000000001');
    assert.equal((await server.inject(`/desktop/products?snapshotId=${id}&q=B000000002`)).json().total, 1);
    assert.equal((await server.inject(`/desktop/products?snapshotId=${id}&q=Nh%E1%BA%ADt`)).json().total, 2);
    assert.equal((await server.inject(`/desktop/products?snapshotId=${id}&q=${'x'.repeat(121)}`)).statusCode, 400);
    const second = await server.inject(`/desktop/products?snapshotId=${id}&pageSize=1&page=2&onlyDifferent=1`);
    assert.equal(second.json().total, 1);
    assert.equal(reads, 1);
    assert.equal((await server.inject(`/desktop/overview?snapshotId=${id}`)).json().comparison.pc.catalog.products, 2);
    const logs = (await server.inject(`/desktop/logs?snapshotId=${id}`)).json();
    assert.equal(logs.hours, 24);
    assert.equal(logs.items.length, 3);
    assert.equal(logs.sources[0].runtimeLogStatus, 'available');
    assert.ok(logs.items.some((item: { category: string }) => item.category === 'sync'));
    assert.ok(!JSON.stringify(logs).includes('secret'));
    for (const suffix of ['&hours=169', '&limit=501', '&source=arbitrary', '&severity=stderr']) {
      assert.equal((await server.inject(`/desktop/logs?snapshotId=${id}${suffix}`)).statusCode, 400);
    }
    session = 'other-session';
    assert.equal((await server.inject(`/desktop/products?snapshotId=${id}`)).statusCode, 410);
    session = 'session-one'; fail = true;
    const failedId = (await server.inject('/desktop/snapshot')).json().snapshotId;
    const failed = (await server.inject(`/desktop/products?snapshotId=${failedId}&onlyDifferent=1`)).json();
    assert.equal(failed.comparisonStatus, 'unavailable');
    assert.equal(failed.total, 0);
    assert.deepEqual(failed.items, []);
    const offlinePc = (await server.inject(`/desktop/products?snapshotId=${failedId}`)).json();
    assert.equal(offlinePc.total, 2);
    assert.equal(offlinePc.items[0].different, false);
    assert.equal(offlinePc.items[0].pc.asin, 'B000000001');
    assert.equal(offlinePc.items[0].vps, null);
    assert.equal((await server.inject(`/desktop/overview?snapshotId=${failedId}`)).json().comparison, null);
    assert.equal((await server.inject(`/desktop/products?snapshotId=${id}`)).statusCode, 410);
    assert.equal(reads, 2);
    assert.equal((await server.inject('/desktop/snapshot?sql=bad')).statusCode, 400);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60 * 60 * 1000 + 1;
      assert.equal((await server.inject(`/desktop/logs?snapshotId=${failedId}`)).statusCode, 410);
    } finally { Date.now = realNow; }
  } finally { await server.close(); }
});
