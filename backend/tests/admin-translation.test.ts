import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db/pool.js';
import { recentAdminIssues } from '../src/admin/issues.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';
import { csrfToken, digest } from '../src/admin/security.js';

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

/** Route tests with an in-memory Pool stub; no PostgreSQL or production log writes. */
test('Admin translation settings require owner session, valid origin/CSRF and a current version', async t => {
  const token = 'a'.repeat(64);
  const cookie = `mita_admin=${token}`;
  const csrf = csrfToken(token);
  const local = { host: `127.0.0.1:${config.port}`, origin: `http://127.0.0.1:${config.webPort}` };
  const authenticated = { ...local, cookie };
  const allowedWrite = { ...authenticated, 'x-csrf-token': csrf };
  const state = { version: 1, enabled: false };
  const events: Array<{ actor: unknown; action: unknown; before: unknown; after: unknown }> = [];
  const ok = (rows: Record<string, unknown>[] = []): QueryResult => ({ rows, rowCount: rows.length });
  const settings = () => ok([{ version: state.version, validate_translation_semantics: state.enabled }]);

  const pool = db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
    connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<QueryResult>; release: () => void }>;
  };
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return ok();
      if (sql.includes('SELECT id FROM translation_settings')) return ok([{ id: 1 }]);
      if (sql.includes('SELECT version,validate_translation_semantics FROM translation_settings')) return settings();
      if (sql.includes('UPDATE translation_settings SET')) {
        assert.equal(typeof params[0], 'boolean');
        state.enabled = params[0] as boolean;
        state.version++;
        return ok();
      }
      if (sql.includes('INSERT INTO admin_audit_events')) {
        events.push({ actor: params[0], action: params[1], before: JSON.parse(params[3] as string), after: JSON.parse(params[4] as string) });
        return ok();
      }
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    },
    release: () => undefined,
  };
  mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT account_id,expires_at FROM admin_sessions')) {
      return params[0] === digest(token) ? ok([{ account_id: 1, expires_at: new Date(Date.now() + 60_000) }]) : ok();
    }
    if (sql.includes('SELECT version,validate_translation_semantics FROM translation_settings')) return settings();
    if (sql.includes('FROM sync_errors') || sql.includes('FROM product_translations')) return ok();
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });
  mock.method(pool, 'connect', async () => client);
  const server = buildServer();
  t.after(async () => { await server.close(); mock.restoreAll(); });

  const get = (url: string, headers: Record<string, string> = authenticated) => server.inject({ method: 'GET', url, headers });
  const put = (payload: Record<string, unknown>, headers: Record<string, string> = allowedWrite) => server.inject({
    method: 'PUT', url: '/api/admin/translation-settings', headers, payload,
  });

  await t.test('no session, remote host/IP and forged Origin are blocked', async () => {
    assert.equal((await get('/api/admin/translation-settings', local)).statusCode, 401);
    assert.equal((await get('/api/admin/issues', local)).statusCode, 401);
    assert.equal((await get('/api/admin/issues', { ...authenticated, host: 'evil.test' })).statusCode, 403);
    assert.equal((await server.inject({ url: '/api/admin/issues', headers: authenticated, remoteAddress: '192.0.2.3' })).statusCode, 403);
    assert.equal((await put({ version: 1, validateTranslationSemantics: true }, local)).statusCode, 401);
    assert.equal((await get('/api/admin/translation-settings', { ...authenticated, host: 'evil.test' })).statusCode, 403);
    assert.equal((await server.inject({ url: '/api/admin/translation-settings', headers: authenticated, remoteAddress: '192.0.2.3' })).statusCode, 403);
    assert.equal((await put({ version: 1, validateTranslationSemantics: true }, { ...allowedWrite, origin: 'https://evil.test' })).statusCode, 403);
    assert.deepEqual(state, { version: 1, enabled: false });
    assert.equal(events.length, 0);
  });

  await t.test('session read is no-store; write rejects missing/wrong CSRF', async () => {
    const read = await get('/api/admin/translation-settings');
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.deepEqual(read.json(), { version: 1, validateTranslationSemantics: false });
    const payload = { version: 1, validateTranslationSemantics: true };
    assert.equal((await put(payload, authenticated)).statusCode, 403);
    assert.equal((await put(payload, { ...authenticated, 'x-csrf-token': 'invalid' })).statusCode, 403);
    assert.deepEqual(state, { version: 1, enabled: false });
  });

  await t.test('type validation rejects malformed policy before transaction', async () => {
    const invalid = [
      { version: 0, validateTranslationSemantics: true },
      { version: '1', validateTranslationSemantics: true },
      { version: 1.5, validateTranslationSemantics: true },
      { version: 1, validateTranslationSemantics: 'true' },
      { version: 1 },
      {},
    ];
    for (const payload of invalid) {
      const response = await put(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload) + response.body);
    }
    assert.deepEqual(state, { version: 1, enabled: false });
  });

  await t.test('successful update is versioned and audited; stale version is 409', async () => {
    const enabled = await put({ version: 1, validateTranslationSemantics: true });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.deepEqual(enabled.json(), { version: 2, validateTranslationSemantics: true });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      actor: 1, action: 'translation.semantic_policy',
      before: { version: 1, validateTranslationSemantics: false },
      after: { version: 2, validateTranslationSemantics: true },
    });
    const stale = await put({ version: 1, validateTranslationSemantics: false });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(state, { version: 2, enabled: true });
    assert.equal(events.length, 1);
    const disabled = await put({ version: 2, validateTranslationSemantics: false });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.deepEqual((await get('/api/admin/translation-settings')).json(), { version: 3, validateTranslationSemantics: false });
    assert.equal(events.length, 2);
  });

  await t.test('issues API validates ASIN and remains session-protected', async () => {
    const malformed = await get('/api/admin/issues?asin=invalid');
    assert.equal(malformed.statusCode, 400, malformed.body);
    const all = await get('/api/admin/issues');
    assert.equal(all.statusCode, 200, all.body);
    assert.equal(all.headers['cache-control'], 'no-store');
    const report = all.json();
    assert.ok(Array.isArray(report.amazon));
    assert.ok(Array.isArray(report.translations));
    assert.deepEqual(report.persistedTranslations, []);
    assert.equal(report.logLocation, '.agents/runtime/translation-warnings.jsonl');
  });
});


test('persisted warning summary bounds and allowlists database metadata with a parameterized filter', async t => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const asin = 'B012345678';
  mock.method(db, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    assert.match(sql, /^\s*SELECT/);
    if (sql.includes('FROM sync_errors')) return { rows: [] };
    return { rows: [
      { asin, field: 'name', status: 'warning', issues: ['residual_japanese', null, {}, 1], updated_at: new Date('2026-01-01'), secret: 'do-not-expose' },
      { asin, field: 'features:0', status: 'warning', issues: { invalid: true }, updated_at: null },
      { asin, field: 'x'.repeat(200), status: 'success', issues: Array(30).fill('x'.repeat(200)), updated_at: 'x'.repeat(200) },
      { asin: 'invalid', field: 'name', issues: [] },
      ...Array(110).fill({ asin, field: 'name', status: 'warning', issues: null })
    ] };
  });
  t.after(() => mock.restoreAll());
  const report = await recentAdminIssues(asin);
  assert.equal(report.persistedTranslations.length, 99);
  assert.deepEqual(report.persistedTranslations[0], {
    asin, field: 'name', status: 'warning', issues: ['residual_japanese'], updatedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.deepEqual(report.persistedTranslations[1].issues, []);
  assert.equal(report.persistedTranslations[2].issues.length, 20);
  assert.equal(report.persistedTranslations[2].issues[0].length, 100);
  assert.equal(report.persistedTranslations[2].field.length, 100);
  assert.equal(report.persistedTranslations[2].updatedAt?.length, 100);
  assert.ok(!JSON.stringify(report.persistedTranslations).includes('do-not-expose'));
  const query = calls[1];
  assert.deepEqual(query.params, [asin]);
  assert.ok(!query.sql.includes(asin));
  assert.match(query.sql, /locale='vi'/);
  assert.match(query.sql, /status='warning'/);
  assert.match(query.sql, /warning OR CASE/);
  assert.match(query.sql, /jsonb_typeof\(name_issues\)='array'/);
  assert.match(query.sql, /jsonb_typeof\(issues\)='array'/);
  assert.match(query.sql, /LIMIT 100/);
  const count = calls.length;
  await assert.rejects(recentAdminIssues("' OR true--"), /invalid_asin/);
  assert.equal(calls.length, count);
  await recentAdminIssues();
  assert.deepEqual(calls.at(-1)?.params, [null]);
});
