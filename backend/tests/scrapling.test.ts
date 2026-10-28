import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ScraplingSession } from '../src/ingestion/scrapling.js';
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
