import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { assertDenied, assertVerifiedProduct, parseOptions, percentile, request, run } from './test-vps-smoke.mjs';

test('options require explicit pre-DNS IP or live-DNS mode', () => {
  assert.equal(parseOptions(['--connect-ip', '217.142.225.255']).connectIp, '217.142.225.255');
  assert.equal(parseOptions(['--live-dns']).liveDns, true);
  assert.throws(() => parseOptions([]), /exactly one/);
  assert.throws(() => parseOptions(['--live-dns', '--skip-ekaiwa']), /cannot be skipped/);
  assert.throws(() => parseOptions(['--connect-ip', '127.0.0.1', '--live-dns']), /exactly one/);
  assert.throws(() => parseOptions(['--connect-ip', 'not-an-ip']), /IPv4/);
  assert.throws(() => parseOptions(['--live-dns', '--base-url', 'http://evil.invalid']), /canonical HTTPS/);
  assert.throws(() => parseOptions(['--live-dns', '--requests-per-stage', '1001']), /safety cap/);
});

test('explicit rights and denied statuses fail closed', () => {
  assertVerifiedProduct({ asin: 'B000000001', rightsStatus: 'verified' });
  assert.throws(() => assertVerifiedProduct({ asin: 'B000000001', rightsStatus: 'local_test_only' }), /leaked/);
  assert.throws(() => assertVerifiedProduct({ asin: 'B000000001', rightsStatus: 'unverified' }), /leaked/);
  assertDenied({ status: 404 }, '/admin');
  assert.throws(() => assertDenied({ status: 200 }, '/admin'), /expected/);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  assert.equal(percentile([], 0.95), null);
});

test('HTTP transport follows local redirects and rejects off-origin redirects', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(308, { Location: '/ok' }).end();
    } else if (req.url === '/escape') {
      res.writeHead(302, { Location: 'http://evil.invalid/' }).end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(req.headers.host);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const allowed = await request(base, '/redirect');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, '127.0.0.1:' + server.address().port);
    await assert.rejects(request(base, '/escape'), /Cross-origin redirect/);
    const forged = await request(base, '/ok', { headers: { Host: 'localhost:3100' } });
    assert.equal(forged.body, 'localhost:3100');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function fakeTransport({ exposePrivate = false, exposePrivateOnForgedHost = false, leakRights = false, wildcardHomepage = false } = {}) {
  const stats = { active: 0, peak: 0, total: 0 };
  async function transport(_base, path, options = {}) {
    stats.active++;
    stats.peak = Math.max(stats.active, stats.peak);
    stats.total++;
    await new Promise(resolve => setImmediate(resolve));
    stats.active--;

    const method = options.method ?? 'GET';
    const headers = options.headers ?? {};
    const forgedHost = headers.Host && headers.Host !== '127.0.0.1:9999';
    const isHtml = ['/','/san-pham','/cach-mua-hang','/gio-hang',
      '/danh-muc/thuc-pham-bo-sung','/danh-muc/thuc-pham-cho-be','/san-pham/B000000001'].includes(path);
    const approved = { asin: 'B000000001', rightsStatus: leakRights ? 'local_test_only' : 'verified' };
    let status = 404;
    let body = '';
    let type = 'text/plain';
    if (path === '/admin/login' && ((exposePrivate && !forgedHost) || (exposePrivateOnForgedHost && forgedHost))) {
      status = 200;
      type = 'text/html';
      body = '<html>Admin login</html>';
    } else if ((!forgedHost || (wildcardHomepage && path === '/')) && (method === 'GET' || method === 'HEAD')) {
      if (isHtml) {
        status = 200;
        type = 'text/html';
        body = '<html>Storefront</html>';
      } else if (path === '/api/categories') {
        status = 200;
        type = 'application/json';
        body = '[]';
      } else if (path === '/api/catalog?limit=101') {
        status = 400;
      } else if (path === '/api/catalog' || path === '/api/catalog?limit=100&page=1') {
        status = 200;
        type = 'application/json';
        body = JSON.stringify({ items: [approved], total: 1 });
      } else if (path === '/api/catalog/products/B000000001') {
        status = 200;
        type = 'application/json';
        body = JSON.stringify({ ...approved, variants: [] });
      }
    }
    return {
      status, body, ms: 10, headers: {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY'
      }
    };
  }
  return { transport, stats };
}

const options = parseOptions([
  '--local-only', '--base-url', 'http://127.0.0.1:9999',
  '--skip-ekaiwa', '--requests-per-stage', '2'
]);

test('smoke suite and four benchmark tiers pass a closed mock gateway with <=19 in flight', async () => {
  const mock = fakeTransport();
  const report = await run(options, mock.transport, () => {});
  assert.equal(report.passed, true);
  assert.deepEqual(report.benchmark.map(item => item.concurrency), [1,5,10,19]);
  assert.deepEqual(report.benchmark.map(item => item.errors), [0,0,0,0]);
  assert.equal(mock.stats.peak, 19);
});

test('local-only allows wildcard homepage Host but retains forged admin Host checks and benchmark', async () => {
  const mock = fakeTransport({ wildcardHomepage: true });
  const report = await run(options, mock.transport, () => {});
  assert.equal(report.passed, true);
  assert.equal(report.cases.filter(item => item.label.startsWith('Forged Host cannot reach admin ')).length, 3);
  assert.equal(report.cases.filter(item => item.label.startsWith('Forged Host cannot reach homepage ')).length, 0);
  assert.deepEqual(report.benchmark.map(item => item.concurrency), [1, 5, 10, 19]);
});

test('local-only still rejects a forged Host admin exposure', async () => {
  const mock = fakeTransport({ wildcardHomepage: true, exposePrivateOnForgedHost: true });
  const report = await run(options, mock.transport, () => {});
  assert.equal(report.passed, false);
  assert(report.cases.some(item => !item.pass && item.label.startsWith('Forged Host cannot reach admin ')));
  assert.equal(report.benchmark.length, 0);
});

test('canonical public domain retains strict forged homepage Host checks', async () => {
  const publicOptions = parseOptions(['--connect-ip', '217.142.225.255', '--requests-per-stage', '2']);
  const mock = fakeTransport({ wildcardHomepage: true });
  const report = await run(publicOptions, mock.transport, () => {});
  assert.equal(report.passed, false);
  assert.equal(report.cases.filter(item => item.label.startsWith('Forged Host cannot reach homepage ')).length, 3);
  assert(report.cases.some(item => !item.pass && item.label.startsWith('Forged Host cannot reach homepage ')));
  assert.equal(report.benchmark.length, 0);
});

test('suite fails if private admin becomes visible', async () => {
  const mock = fakeTransport({ exposePrivate: true });
  const report = await run(options, mock.transport, () => {});
  assert.equal(report.passed, false);
  assert(report.cases.some(item => !item.pass && item.label === 'Private route denied /admin/login'));
  assert.equal(report.benchmark.length, 0);
});

test('suite fails if local_test_only appears in public JSON', async () => {
  const mock = fakeTransport({ leakRights: true });
  const report = await run(options, mock.transport, () => {});
  assert.equal(report.passed, false);
  assert(report.cases.some(item => !item.pass && item.label.includes('verified-only')));
  assert.equal(report.benchmark.length, 0);
});
