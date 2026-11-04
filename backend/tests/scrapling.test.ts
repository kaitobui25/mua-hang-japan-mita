import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ScraplingSession, QuoteTransportError } from '../src/ingestion/scrapling.js';
import { SourceError } from '../src/ingestion/source.js';
import { uniqueImages } from '../src/ingestion/enrichment.js';
const category = 'thuc-pham-bo-sung';
const make = (timeoutMs = 5000) => new ScraplingSession({
  executable: process.env.MITA_SCRAPLING_TEST_PYTHON || 'python',
  script: fileURLToPath(new URL('./fixtures/scrapling-ipc.py', import.meta.url)), timeoutMs
});

test('persistent JSONL handles Unicode and excludes application secrets', async () => {
  const session = make();
  try {
    for (let i = 0; i < 2; i++) {
      const item = await session.detail('B000000001', category);
      assert.equal(item.name, '日本語 fixture');
      assert.equal((item as unknown as { secretPresent: boolean }).secretPresent, false);
    }
  } finally { session.close(); }
  await assert.rejects(session.detail('B000000001', category), /stopped/);
});

test('timeout kills subprocess and closes session', async () => {
  const session = make(200);
  await assert.rejects(session.detail('B000000002', category), /stopped/);
  await assert.rejects(session.detail('B000000001', category), /stopped/);
});

test('explicit cancellation kills pending request', async () => {
  const session = make();
  const pending = session.detail('B000000002', category);
  session.close();
  await assert.rejects(pending, /stopped/);
});

test('oversized IPC output is rejected and process terminated', async () => {
  const session = make();
  await assert.rejects(session.detail('B000000003', category), /stopped/);
});

test('source denial propagates as Scrapling blocked', async () => {
  const session = make();
  try {
    await assert.rejects(session.detail('B000000004', category), (error: unknown) => error instanceof SourceError && error.state === 'blocked' && error.adapter === 'scrapling');
  } finally { session.close(); }
});

test('persistence gallery normalization keeps at most five evidenced photos', () => {
  const images = Array.from({ length: 8 }, (_, i) => `https://m.media-amazon.com/images/I/photo${i}.jpg`);
  assert.deepEqual(uniqueImages(images), images.slice(0, 5));
});

test('detail denial is reported before a queue write can fail', async () => {
  const { processCategoryDetails } = await import('../src/ingestion/sync.js');
  let paused = false;
  const connection = { query: async (sql: string) => {
    if (sql.startsWith('SELECT asin')) return { rows: [{ asin: 'B000000001', parent_asin: null, provenance: {} }] };
    if (sql.startsWith('UPDATE product_detail_queue SET state=$3')) {
      assert.equal(paused, true);
      throw Error('fixture queue write failed');
    }
    return { rows: [] };
  } };
  await assert.rejects(processCategoryDetails(category, {
    connection: connection as never,
    collect: async () => { throw new SourceError('blocked', 'fixture CAPTCHA', 'scrapling'); },
    onIssue: async issue => { assert.equal(issue.state, 'blocked'); paused = true; }
  }), /fixture queue write failed/);
  assert.equal(paused, true);
});


test('quote IPC returns validated Unicode and accepts the exact body size limit', async () => {
  const session = make();
  try {
    const result = await session.quote('B000000001', 1, 5000);
    assert.equal(result.html, '\u65e5\u672c\u8a9e fixture');
    assert.ok(Number.isFinite(result.observedAt.getTime()));
    assert.equal((await session.quote('B000000017', 1, 5000)).html.length, 8_000_000);
  } finally { session.close(); }
});

test('quote IPC rejects identity, timestamp, compression and UTF-8 violations', async () => {
  for (const suffix of ['005', '006', '007', '008', '009', '010', '011', '012', '014', '019']) {
    const session = make();
    try {
      await assert.rejects(session.quote('B000000' + suffix, 1, 5000),
        (e: unknown) => e instanceof QuoteTransportError && e.code === 'amazon_unavailable', suffix);
    } finally { session.close(); }
  }
});

test('quote IPC bounds declared, inflated, compressed and wire sizes', async () => {
  for (const suffix of ['003', '013', '016', '018']) {
    const session = make();
    try {
      await assert.rejects(session.quote('B000000' + suffix, 1, 5000),
        (e: unknown) => e instanceof QuoteTransportError && e.code === 'amazon_response_too_large', suffix);
    } finally { session.close(); }
  }
});

test('quote IPC preserves source denial and retryAfterAt', async () => {
  for (const [asin, code] of [['B000000004', 'amazon_blocked'], ['B000000015', 'amazon_rate_limited']]) {
    const session = make();
    try {
      await assert.rejects(session.quote(asin, 1, 5000), (e: unknown) => {
        assert.ok(e instanceof QuoteTransportError);
        assert.equal(e.code, code);
        assert.equal(e.retryAfterAt, code === 'amazon_rate_limited' ? '2030-01-01T00:00:00.000Z' : undefined);
        return true;
      });
    } finally { session.close(); }
  }
});

test('quote IPC rejects invalid requests before launching and honors its short deadline', async () => {
  const session = make();
  try {
    for (const asin of ['', 'b000000001', 'B000000001\n', 'https://www.amazon.co.jp/dp/B000000001']) {
      await assert.rejects(session.quote(asin, 1, 5000), QuoteTransportError);
    }
    for (const quantity of [0, 100, 1.5, NaN]) await assert.rejects(session.quote('B000000001', quantity, 5000), QuoteTransportError);
    for (const timeout of [0, 120001, NaN, 1.5]) await assert.rejects(session.quote('B000000001', 1, timeout), QuoteTransportError);
    await assert.rejects(session.quote('B000000002', 1, 200), /stopped/);
    await assert.rejects(session.quote('B000000001', 1, 5000), /stopped/);
  } finally { session.close(); }
});

test('quote decoder validates bounded transport fixtures without a subprocess', async t => {
  const session = make();
  // Inject only the IPC reply so the production quote decoder runs unchanged.
  const request = t.mock.method(session as unknown as { request: () => Promise<unknown> }, 'request', async () => ({}));
  const asin = 'B000000001', quantity = 1, url = `https://www.amazon.co.jp/dp/${asin}?quantity=1`;
  const encode = (body: Buffer) => ({ htmlBytes: body.length, htmlZlibBase64: deflateSync(body).toString('base64') });
  let payload: Record<string, unknown>;
  request.mock.mockImplementation(async () => ({ asin, quantity, url, observedAt: new Date().toISOString(), ...payload }));
  try {
    payload = encode(Buffer.from('\u65e5\u672c\u8a9e fixture'));
    assert.equal((await session.quote(asin, quantity, 5000)).html, '\u65e5\u672c\u8a9e fixture');
    payload = encode(Buffer.alloc(8_000_000, 120));
    assert.equal((await session.quote(asin, quantity, 5000)).html.length, 8_000_000);
    for (const [override, code] of [
      [{ asin: 'B000000002' }, 'amazon_unavailable'],
      [{ quantity: 2 }, 'amazon_unavailable'],
      [{ url: url.replace('quantity=1', 'quantity=2') }, 'amazon_unavailable'],
      [{ observedAt: 'invalid' }, 'amazon_unavailable'],
      [{ observedAt: '2020-01-01T00:00:00.000Z' }, 'amazon_unavailable'],
      [{ observedAt: '2099-01-01T00:00:00.000Z' }, 'amazon_unavailable'],
      [{ htmlBytes: 8_000_001 }, 'amazon_response_too_large'],
      [{ htmlZlibBase64: 'a'.repeat(2_000_004) }, 'amazon_response_too_large'],
      [{ htmlZlibBase64: '%%%%' }, 'amazon_unavailable'],
      [{ htmlZlibBase64: 'abcd' }, 'amazon_unavailable'],
      [{ htmlBytes: 2 }, 'amazon_unavailable'],
      [encode(Buffer.from([255])), 'amazon_unavailable'],
      [{ ...encode(Buffer.alloc(8_000_001)), htmlBytes: 8_000_000 }, 'amazon_response_too_large'],
      [{ htmlZlibBase64: Buffer.concat([deflateSync(Buffer.from('fixture')), Buffer.from('trailing')]).toString('base64') }, 'amazon_unavailable']
    ] as const) {
      payload = { ...encode(Buffer.from('fixture')), ...override };
      await assert.rejects(session.quote(asin, quantity, 5000),
        (e: unknown) => e instanceof QuoteTransportError && e.code === code, JSON.stringify(override).slice(0, 100));
    }
  } finally { session.close(); }
});
