#!/usr/bin/env node
// Read-only deployment gate for Mita's public HTTPS surface. No credentials or SSH required.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const PUBLIC_HOST = 'mitajapanshop.duckdns.org';
const EKAIWA_HOST = 'ekaiwa.duckdns.org';
const MAX_BODY_BYTES = 1024 * 1024;
const DENY_STATUSES = new Set([400, 403, 404, 410, 421]);

export function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)]);
}

export function parseOptions(argv) {
  const options = {
    baseUrl: 'https://' + PUBLIC_HOST, connectIp: null, liveDns: false,
    localOnly: false, skipEkaiwa: false, requestsPerStage: 100,
    timeoutMs: 8000, maxP95Ms: null, ekaiwaMaxP95Ms: null,
    checkHttpRedirect: false, allowLocalTestOnly: false, report: null, help: false
  };
  const keys = new Map([
    ['--base-url', 'baseUrl'], ['--connect-ip', 'connectIp'],
    ['--requests-per-stage', 'requestsPerStage'], ['--timeout-ms', 'timeoutMs'],
    ['--max-p95-ms', 'maxP95Ms'], ['--ekaiwa-max-p95-ms', 'ekaiwaMaxP95Ms'],
    ['--report', 'report']
  ]);
  const flags = new Map([
    ['--live-dns', 'liveDns'], ['--local-only', 'localOnly'],
    ['--skip-ekaiwa', 'skipEkaiwa'], ['--check-http-redirect', 'checkHttpRedirect'],
    ['--allow-local-test-only', 'allowLocalTestOnly'], ['--help', 'help']
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (flags.has(token)) { options[flags.get(token)] = true; continue; }
    if (!keys.has(token) || index + 1 >= argv.length) throw new Error('Unknown or incomplete option: ' + token);
    options[keys.get(token)] = argv[++index];
  }
  if (options.help) return options;
  for (const name of ['requestsPerStage', 'timeoutMs', 'maxP95Ms', 'ekaiwaMaxP95Ms']) {
    if (options[name] === null) continue;
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new Error('Invalid ' + name);
  }
  if (options.requestsPerStage > 1000 || options.timeoutMs > 30000) throw new Error('Workload or timeout exceeds safety cap');
  const base = new URL(options.baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('base-url must be an origin only');
  if (options.localOnly) {
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) {
      throw new Error('--local-only requires an HTTP loopback base-url');
    }
    if (options.connectIp || options.liveDns || options.checkHttpRedirect) throw new Error('Incompatible local-only options');
  } else {
    if (base.protocol !== 'https:' || base.hostname !== PUBLIC_HOST || base.port) throw new Error('Public target must be the canonical HTTPS hostname');
    if (Boolean(options.connectIp) === options.liveDns) throw new Error('Choose exactly one: --connect-ip IPv4 OR --live-dns');
    if (options.connectIp && isIP(options.connectIp) !== 4) throw new Error('--connect-ip requires an IPv4 address');
    if (options.skipEkaiwa) throw new Error('E-KAIWA checks cannot be skipped for public VPS QA');
  }
  return options;
}

function requestOnce(url, { method = 'GET', headers = {}, body, timeoutMs = 8000, connectIp = null } = {}) {
  return new Promise((resolve, reject) => {
    const agent = url.protocol === 'https:' ? https : http;
    const started = performance.now();
    const opts = {
      hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search,
      method, headers: { 'user-agent': 'mita-vps-qa/1', 'accept-encoding': 'identity', ...headers },
      timeout: timeoutMs,
      ...(url.protocol === 'https:' ? { servername: url.hostname, rejectUnauthorized: true } : {}),
      ...(connectIp ? {
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ address: connectIp, family: 4 }]);
          else callback(null, connectIp, 4);
        }
      } : {})
    };
    const req = agent.request(opts, response => {
      let length = 0;
      const parts = [];
      response.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) {
          req.destroy(new Error('Response exceeds 1 MiB safety cap'));
          return;
        }
        parts.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers,
        body: Buffer.concat(parts).toString('utf8'),
        ms: Math.round(performance.now() - started)
      }));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function request(base, path, options = {}) {
  const originalOrigin = new URL(base).origin;
  let url = new URL(path, base);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const result = await requestOnce(url, options);
    if (result.status < 300 || result.status >= 400 || !result.headers.location) return result;
    const next = new URL(result.headers.location, url);
    if (next.origin !== originalOrigin) throw new Error('Cross-origin redirect: ' + next.origin);
    if (redirects === 3) throw new Error('Too many redirects');
    url = next;
  }
  throw new Error('Redirect chain did not terminate');
}

export function assertDenied(result, label) {
  assert(DENY_STATUSES.has(result.status), label + ': expected 400/403/404/410/421; got ' + result.status);
}

export function assertVerifiedProduct(product, allowLocalTestOnly = false) {
  assert(product && typeof product === 'object', 'Catalog product must be an object');
  assert((allowLocalTestOnly ? ['verified', 'local_test_only'] : ['verified']).includes(product.rightsStatus), 'Public catalog leaked non-verified rights status');
  assert.equal(typeof product.asin, 'string', 'Catalog item missing ASIN');
}

function summarize(values) {
  return { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: values.length ? Math.max(...values) : null };
}

export async function run(options, transport = request, log = console.log) {
  const report = { target: options.baseUrl, connectIp: options.connectIp, startedAt: new Date().toISOString(), cases: [], benchmark: [], ekaiwa: {} };
  const base = options.baseUrl;
  const fetchMita = (path, overrides = {}) => transport(base, path, { timeoutMs: options.timeoutMs, connectIp: options.connectIp, ...overrides });
  async function check(label, action) {
    try {
      const result = await action();
      report.cases.push({ label, pass: true, ...(result ? { status: result.status } : {}) });
      log('PASS ' + label);
      return result;
    } catch (error) {
      report.cases.push({ label, pass: false, error: error.message });
      log('FAIL ' + label + ': ' + error.message);
      return null;
    }
  }
  async function finish(stoppedReason = null) {
    report.finishedAt = new Date().toISOString();
    report.passed = !stoppedReason && report.cases.every(item => item.pass);
    if (stoppedReason) {
      report.stoppedReason = stoppedReason;
      log('STOP ' + stoppedReason);
    }
    if (options.report) {
      await writeFile(options.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      log('Report saved: ' + options.report);
    }
    log('RESULT ' + (report.passed ? 'PASS' : 'FAIL') + ': ' + report.cases.filter(item => item.pass).length + '/' + report.cases.length + ' checks');
    return report;
  }
  async function expectHtml(path) {
    const result = await fetchMita(path);
    assert.equal(result.status, 200, path + ' HTTP status');
    assert.match(String(result.headers['content-type'] ?? ''), /text\/html/i, path + ' content type');
    return result;
  }
  async function expectJson(path) {
    const result = await fetchMita(path);
    assert.equal(result.status, 200, path + ' HTTP status');
    assert.match(String(result.headers['content-type'] ?? ''), /application\/json/i, path + ' content type');
    return { response: result, data: JSON.parse(result.body) };
  }
  async function deny(path, overrides = {}) {
    const result = await fetchMita(path, overrides);
    assertDenied(result, (overrides.method || 'GET') + ' ' + path);
    return result;
  }
  log('Target ' + base + (options.connectIp ? ' (connect ' + options.connectIp + ')' : ''));

  const ekaiwaUrl = 'https://' + EKAIWA_HOST + '/';
  const ekaiwaStatuses = [];
  async function sampleEkaiwa(phase, count) {
    if (options.skipEkaiwa) return;
    const results = [];
    for (let index = 0; index < count; index++) {
      const item = await check('E-KAIWA ' + phase + ' #' + (index + 1), async () => {
        const response = await transport(ekaiwaUrl, '/', { timeoutMs: options.timeoutMs });
        assert(response.status >= 200 && response.status < 400, 'E-KAIWA returned ' + response.status);
        if (ekaiwaStatuses.length) assert.equal(response.status, ekaiwaStatuses[0], 'E-KAIWA HTTP status drifted');
        ekaiwaStatuses.push(response.status);
        return response;
      });
      if (item) results.push(item.ms);
    }
    report.ekaiwa[phase] = summarize(results);
    if (options.ekaiwaMaxP95Ms && results.length && percentile(results, 0.95) > options.ekaiwaMaxP95Ms) {
      await check('E-KAIWA p95 threshold ' + phase, async () => { throw new Error('p95 above ' + options.ekaiwaMaxP95Ms + ' ms'); });
    }
  }
  await sampleEkaiwa('before', 3);
  if (report.cases.some(item => !item.pass)) return finish('E-KAIWA baseline failed; no Mita traffic generated');

  if (options.checkHttpRedirect) {
    await check('HTTP redirects to canonical HTTPS', async () => {
      const result = await requestOnce(new URL('http://' + PUBLIC_HOST + '/'), { connectIp: options.connectIp, timeoutMs: options.timeoutMs });
      assert([301, 308].includes(result.status), 'HTTP returned ' + result.status);
      assert.equal(new URL(result.headers.location, 'http://' + PUBLIC_HOST).href, base + '/');
      return result;
    });
  }

  const front = ['/', '/san-pham', '/cach-mua-hang', '/gio-hang', '/danh-muc/thuc-pham-bo-sung', '/danh-muc/thuc-pham-cho-be'];
  for (const path of front) await check('Public page ' + path, () => expectHtml(path));

  await check('Public security headers', async () => {
    const response = await expectHtml('/');
    assert.equal(response.headers['x-content-type-options'], 'nosniff', 'Missing X-Content-Type-Options');
    assert(response.headers['referrer-policy'], 'Missing Referrer-Policy');
    assert(response.headers['x-frame-options'] || /frame-ancestors/i.test(String(response.headers['content-security-policy'] || '')), 'Missing framing protection');
    return response;
  });
  await check('GET /api/categories JSON', async () => {
    const { response, data } = await expectJson('/api/categories');
    assert(Array.isArray(data), 'Expected categories array');
    return response;
  });

  let publicAsin = null;
  await check(options.allowLocalTestOnly ? 'GET /api/catalog local_test_only permitted JSON' : 'GET /api/catalog verified-only JSON', async () => {
    const { response, data } = await expectJson('/api/catalog?limit=100&page=1');
    assert(Array.isArray(data.items), 'Expected catalog items');
    assert(Number.isInteger(data.total) && data.total >= 0, 'Invalid catalog total');
    for (const product of data.items) assertVerifiedProduct(product, options.allowLocalTestOnly);
    publicAsin = data.items[0]?.asin ?? null;
    const pages = Math.ceil(data.total / 100);
    assert(pages <= 50, 'Catalog exceeds 5000 products: explicit QA sampling plan needed');
    let checked = data.items.length;
    for (let page = 2; page <= pages; page++) {
      const next = await expectJson('/api/catalog?limit=100&page=' + page);
      assert(Array.isArray(next.data.items), 'Invalid catalog page ' + page);
      for (const product of next.data.items) assertVerifiedProduct(product, options.allowLocalTestOnly);
      checked += next.data.items.length;
    }
    assert.equal(checked, data.total, 'Catalog count changed or page omitted products during QA');
    return response;
  });
  if (publicAsin) {
    await check('Public detail API ' + publicAsin, async () => {
      const { response, data } = await expectJson('/api/catalog/products/' + encodeURIComponent(publicAsin));
      assertVerifiedProduct(data, options.allowLocalTestOnly);
      for (const variant of data.variants ?? []) assertVerifiedProduct(variant, options.allowLocalTestOnly);
      return response;
    });
    await check('Public detail HTML ' + publicAsin, () => expectHtml('/san-pham/' + encodeURIComponent(publicAsin)));
  } else log('SKIP product detail: no public catalog item');
  await check('Unknown catalog product cannot leak', () => deny('/api/catalog/products/__qa_no_such_asin__'));
  await check('GET catalog bad pagination rejected', async () => {
    const response = await fetchMita('/api/catalog?limit=101');
    assert.equal(response.status, 400);
    return response;
  });
  await check('HEAD catalog allowed', async () => {
    const response = await fetchMita('/api/catalog', { method: 'HEAD' });
    assert.equal(response.status, 200);
    return response;
  });

  const forbidden = [
    '/admin', '/admin/login', '/admin/san-pham', '/api/admin', '/api/admin/session',
    '/api/health', '/api/sync-status', '/thanh-toan', '/thanh-toan/',
    '/api/checkout', '/api', '/api/other',
    '/%61dmin/login', '/admin%2Flogin', '/api/%61dmin/session',
    '/api/admin%2Fsession', '/%74hanh-toan', '/thanh-toan%2F',
    '/api/%68ealth'
  ];
  for (const path of forbidden) await check('Private route denied ' + path, () => deny(path));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await check(method + ' catalog denied', () => deny('/api/catalog', {
      method, headers: method === 'OPTIONS' ? { Origin: 'https://evil.invalid', 'Access-Control-Request-Method': 'POST' } : {}
    }));
  }
  await check('POST checkout denied with empty body', () => deny('/api/checkout', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json', Origin: 'http://localhost:3100' }
  }));
  for (const host of ['localhost:3100', '127.0.0.1:3100', 'evil.invalid']) {
    await check('Forged Host cannot reach admin ' + host, () => deny('/admin/login', { headers: { Host: host } }));
    // A local staging Caddy listener can accept wildcard Host values.
    // The canonical public hostname must continue rejecting them.
    if (!options.localOnly) {
      await check('Forged Host cannot reach homepage ' + host, () => deny('/', { headers: { Host: host } }));
    }
  }
  await check('Forged Origin cannot reach admin', () => deny('/admin/login', { headers: { Origin: 'http://localhost:3100' } }));
  if (report.cases.some(item => !item.pass)) return finish('Smoke gate failed; benchmark not started');

  const paths = ['/', '/san-pham', '/api/categories', '/api/catalog'];
  for (const concurrency of [1, 5, 10, 19]) {
    const count = Math.max(options.requestsPerStage, concurrency);
    const latencies = [];
    const errors = [];
    let dispatched = 0;
    log('BENCH start concurrency=' + concurrency + ' requests=' + count);
    async function client() {
      while (dispatched < count) {
        const index = dispatched++;
        const path = paths[index % paths.length];
        try {
          const response = await fetchMita(path);
          if (response.status !== 200) throw new Error(path + ' returned ' + response.status);
          latencies.push(response.ms);
        } catch (error) {
          errors.push(path + ': ' + error.message);
        }
      }
    }
    // Probe E-KAIWA while Mita has active requests, including the 19-client burst.
    const workload = Promise.all(Array.from({ length: concurrency }, () => client()));
    const ekaiwaProbe = sampleEkaiwa('during-' + concurrency, 3);
    await Promise.all([workload, ekaiwaProbe]);
    const summary = { concurrency, requested: count, ...summarize(latencies), errors: errors.length, errorSamples: errors.slice(0, 3) };
    report.benchmark.push(summary);
    log('BENCH ' + JSON.stringify(summary));
    if (errors.length) await check('Benchmark errors concurrency=' + concurrency, async () => { throw new Error(errors.length + ' unsuccessful HTTP requests'); });
    if (options.maxP95Ms && percentile(latencies, 0.95) > options.maxP95Ms) {
      await check('Benchmark p95 concurrency=' + concurrency, async () => { throw new Error('p95 above ' + options.maxP95Ms + ' ms'); });
    }
    if (report.cases.some(item => !item.pass)) return finish('Benchmark or E-KAIWA regression at concurrency ' + concurrency);
  }
  await sampleEkaiwa('after', 3);
  return finish(report.cases.some(item => !item.pass) ? 'Post-benchmark E-KAIWA regression' : null);
}

const HELP = [
  'Usage: node scripts/test-vps-smoke.mjs --connect-ip <VPS IPv4> [options]',
  '       node scripts/test-vps-smoke.mjs --live-dns [options]',
  '  --connect-ip IPv4         Connect to VPS while preserving HTTPS SNI/Host/certificate validation',
  '  --live-dns                Use the canonical domain DNS after cutover',
  '  --requests-per-stage N    At least N GETs at each of 1,5,10,19 clients (default 100)',
  '  --timeout-ms N            Per-request timeout (default 8000, max 30000)',
  '  --max-p95-ms N            Optional Mita p95 pass/fail threshold',
  '  --ekaiwa-max-p95-ms N     Optional E-KAIWA p95 pass/fail threshold',
  '  --check-http-redirect     Also verify TCP/80 redirects to canonical HTTPS',
  '  --report FILE             Create a JSON report; refuses to overwrite an existing file',
  '  --local-only --base-url http://127.0.0.1:PORT --skip-ekaiwa  Local Caddy QA (skip homepage Host probes)',
  '  --help                    Show this help'
].join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const report = await run(options);
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error('QA aborted: ' + error.message);
    process.exitCode = 2;
  }
}
