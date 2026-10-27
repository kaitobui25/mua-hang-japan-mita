import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '../src/db/pool.js';
import { buildServer } from '../src/server.js';
import { provisionOwner } from '../src/admin/owner.js';
import { digest, hashPassword, verifyPassword } from '../src/admin/security.js';
import { enqueueImport, processNextImport } from '../src/admin/imports.js';
import { overview, savePolicy, setVisibility } from '../src/admin/data.js';
import { getProductDetails, listCatalog } from '../src/catalog.js';
import { createSimulationOrder } from '../src/orders.js';
import { getPricingPolicy, toVnd } from '../src/pricing.js';
import { ingestObservations } from '../src/ingestion/store.js';
import { normalizeAmazonInput, parseDetail } from '../src/ingestion/detail.js';
import { SourceError } from '../src/ingestion/source.js';
import { dailyCron, dailyTimezone, expectedSyncAt, shouldRunDaily } from '../src/ingestion/schedule.js';

const server = buildServer();
after(async () => { await server.close(); await db.end(); });
const origin = 'http://127.0.0.1:3000';
const local = { host: '127.0.0.1:4000', origin };
const password = 'Integration-only password 123!';
const category = 'thuc-pham-bo-sung';
const asin = 'A000000001';
const observation = (id = asin) => ({ asin: id, name: 'Integration Japanese product', categorySlug: category,
  sourceUrl: `https://www.amazon.co.jp/dp/${id}`, sourceAdapter: 'http-detail', imageUrl: 'https://m.media-amazon.com/images/test.jpg',
  priceJpy: 1000, observedAt: new Date().toISOString() });
const checkout = (id = asin) => createSimulationOrder({ customer: { name: 'Private customer', phone: '0901234567', address: 'Private address', email: 'private@example.test' }, items: [{ asin: id, quantity: 2 }] });

test('Amazon input is canonicalized and hostile URLs never become fetch targets', () => {
  assert.equal(normalizeAmazonInput(' b0abcdef12 '), 'B0ABCDEF12');
  assert.equal(normalizeAmazonInput('https://www.amazon.co.jp/title/dp/B0ABCDEF12/ref=test?url=http://127.0.0.1'), 'B0ABCDEF12');
  assert.equal(normalizeAmazonInput('https://amazon.co.jp/gp/product/b0abcdef12'), 'B0ABCDEF12');
  for (const input of ['http://amazon.co.jp/dp/B0ABCDEF12', 'https://amazon.co.jp.evil.test/dp/B0ABCDEF12', 'https://evil@amazon.co.jp/dp/B0ABCDEF12', 'https://amazon.co.jp:444/dp/B0ABCDEF12', 'https://127.0.0.1/dp/B0ABCDEF12', 'https://amazon.co.jp/?asin=B0ABCDEF12', 'https://amzn.to/example', '//amazon.co.jp/dp/B0ABCDEF12']) assert.throws(() => normalizeAmazonInput(input));
});

test('ASIN detail parser requires matching identity and actual product fields', () => {
  const html = `<input id="ASIN" value="${asin}"><span id="productTitle">Valid Japanese product</span><img id="landingImage" src="https://m.media-amazon.com/images/test.jpg"><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">¥1,000</span></span></div>`;
  const result = parseDetail(html, asin, category);
  assert.equal(result.priceJpy, 1000);
  assert.equal(result.asin, asin);
  assert.throws(() => parseDetail(html, 'A000000002', category));
  assert.throws(() => parseDetail(html.replace('¥1,000', ''), asin, category));
  assert.throws(() => parseDetail(html.replace('https://m.media-amazon.com', 'http://evil.test'), asin, category));
  assert.throws(() => parseDetail('captcha ' + html, asin, category), (e: unknown) => e instanceof SourceError && e.state === 'needs_human');
});

test('04:00 JST scheduler skips downtime and dashboard calculates expected dates', () => {
  assert.equal(dailyCron, '0 4 * * *'); assert.equal(dailyTimezone, 'Asia/Tokyo');
  assert.equal(expectedSyncAt(new Date('2026-10-27T18:59:59Z')).toISOString(), '2026-10-26T19:00:00.000Z');
  assert.equal(expectedSyncAt(new Date('2026-10-27T19:00:00Z')).toISOString(), '2026-10-27T19:00:00.000Z');
  const due = new Date('2026-10-27T19:00:00Z');
  assert.equal(shouldRunDaily(due, new Date('2026-10-27T18:00:00Z'), new Date('2026-10-27T19:00:20Z')), true);
  assert.equal(shouldRunDaily(due, new Date('2026-10-27T19:00:01Z'), new Date('2026-10-27T19:00:20Z')), false);
  assert.equal(shouldRunDaily(due, new Date('2026-10-27T18:00:00Z'), new Date('2026-10-28T01:00:00Z')), false);
});

test('Admin MVP integration', async t => {
  let cookie = '', csrf = '';
  await t.test('checkout rejects malformed typed fields before accessing data', async () => {
    for (const payload of [
      { customer: { name: 'Test', phone: '0901234567', address: 'Address', email: 0 }, items: [{ asin, quantity: 1 }] },
      { customer: { name: 'Test', phone: '0901234567', address: 'Address' }, items: [{ asin: 1234567890, quantity: 1 }] },
    ]) {
      const result = await server.inject({ method: 'POST', url: '/api/checkout', payload });
      assert.equal(result.statusCode, 422);
    }
  });
  await t.test('setup stores a salted scrypt hash and rejects another owner', async () => {
    await provisionOwner(password);
    const account = (await db.query('SELECT * FROM admin_accounts')).rows[0];
    assert.notEqual(account.password_hash, password);
    assert.equal(await verifyPassword(password, account.password_hash), true);
    assert.equal(await verifyPassword('wrong password', account.password_hash), false);
    assert.notEqual(await hashPassword(password), account.password_hash);
    await assert.rejects(provisionOwner('Second owner password 123'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_accounts')).rows[0].n, 1);
  });
  await t.test('all admin reads and mutations require a session, with no PII leakage', async () => {
    for (const url of ['/session', '/overview', '/orders', '/orders/00000000-0000-0000-0000-000000000000', '/products', '/pricing', '/imports']) {
      const result = await server.inject({ url: `/api/admin${url}`, headers: local });
      assert.equal(result.statusCode, 401, url);
      assert.equal(result.body.includes('Private'), false);
      assert.equal(result.headers['cache-control'], 'no-store');
    }
    for (const [method, url] of [['POST', '/imports'], ['PUT', '/pricing'], ['POST', '/pricing/preview'], ['POST', '/logout'], ['PATCH', `/products/${asin}/visibility`]] as const) {
      assert.equal((await server.inject({ method, url: `/api/admin${url}`, headers: local, payload: {} })).statusCode, 401);
    }
    assert.equal((await server.inject({ url: '/api/admin/overview', headers: { host: 'evil.test' } })).statusCode, 403);
    assert.equal((await server.inject({ url: '/api/admin/overview', headers: local, remoteAddress: '192.168.1.2' })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/api/admin/login', headers: { ...local, origin: 'https://evil.test' }, payload: { password } })).statusCode, 403);
  });
  await t.test('login is throttled and succeeds with HttpOnly SameSite cookie', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await server.inject({ method: 'POST', url: '/api/admin/login', headers: local, payload: { password: 'wrong-password-123' } })).statusCode, 401);
    assert.equal((await server.inject({ method: 'POST', url: '/api/admin/login', headers: local, payload: { password } })).statusCode, 429);
    await db.query("UPDATE admin_login_limit SET window_started_at=now()-interval '16 minutes'");
    const result = await server.inject({ method: 'POST', url: '/api/admin/login', headers: local, payload: { password } });
    assert.equal(result.statusCode, 200, result.body);
    const setCookie = String(result.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(';')[0]; csrf = result.json().csrfToken;
    assert.equal((await server.inject({ url: '/api/admin/session', headers: { ...local, cookie } })).statusCode, 200);
    const stored = (await db.query('SELECT token_hash FROM admin_sessions')).rows[0].token_hash;
    assert.equal(stored, digest(cookie.split('=')[1]));
    assert.notEqual(stored, cookie.split('=')[1]);
  });
  await t.test('CSRF, forged Origin and missing token block writes before changes', async () => {
    for (const headers of [{ ...local, cookie }, { ...local, cookie, 'x-csrf-token': csrf, origin: 'https://evil.test' }]) {
      const result = await server.inject({ method: 'PUT', url: '/api/admin/pricing', headers, payload: { version: 1, fxJpyToVnd: 250, serviceFeePercent: 20 } });
      assert.equal(result.statusCode, 403);
    }
    assert.equal((await getPricingPolicy()).version, 1);
  });
  await t.test('hide blocks catalog/detail/checkout, survives sync and duplicate import, preserves history', async () => {
    await ingestObservations([observation(), observation('A000000002')]);
    await db.query("UPDATE products SET variant_group_basis='parent_asin',variant_group_id=$1 WHERE asin=ANY($2)", [asin, [asin, 'A000000002']]);
    const order = await checkout();
    assert.equal(order.subtotalVnd, 426000);
    const hide = await server.inject({ method: 'PATCH', url: `/api/admin/products/${asin}/visibility`, headers: { ...local, cookie, 'x-csrf-token': csrf }, payload: { hidden: true } });
    assert.equal(hide.statusCode, 200);
    assert.equal(await getProductDetails(asin), null);
    assert.equal((await server.inject({ url: `/api/catalog/products/${asin}` })).statusCode, 404);
    const refused = await server.inject({ method: 'POST', url: '/api/checkout', payload: { customer: { name: 'Private customer', phone: '0901234567', address: 'Private address' }, items: [{ asin, quantity: 1 }] } });
    assert.equal(refused.statusCode, 422);
    assert.equal((await listCatalog({ q: asin, page: 1, limit: 10 })).total, 0);
    assert.equal((await getProductDetails('A000000002'))!.variants.some(p => p.asin === asin), false);
    await assert.rejects(checkout());
    await ingestObservations([observation()]);
    assert.equal(await getProductDetails(asin), null);
    const duplicate = await enqueueImport(asin, category, 1);
    assert.ok('existingProduct' in duplicate);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM order_items WHERE order_id=$1', [order.orderId])).rows[0].n, 1);
    assert.ok((await db.query('SELECT * FROM price_observations WHERE asin=$1', [asin])).rowCount);
    await setVisibility(asin, false, 1);
    assert.ok(await getProductDetails(asin));
    await db.query("UPDATE products SET price_observed_at=now()-interval '25 hours' WHERE asin=$1", [asin]);
    assert.equal((await getProductDetails(asin))!.canCheckout, false);
    await assert.rejects(checkout());
    await ingestObservations([observation()]);
    await db.query("UPDATE products SET rights_status='unverified' WHERE asin=$1", [asin]);
    assert.equal(await getProductDetails(asin), null); await assert.rejects(checkout());
    await db.query("UPDATE products SET rights_status='local_test_only',availability='out_of_stock' WHERE asin=$1", [asin]);
    await assert.rejects(checkout());
    await db.query("UPDATE products SET availability='unknown' WHERE asin=$1", [asin]);
  });
  await t.test('policy validation, optimistic conflict, atomic save, and historical order snapshots', async () => {
    const old = await checkout();
    const headers = { ...local, cookie, 'x-csrf-token': csrf };
    for (const patch of [{ fxJpyToVnd: -1 }, { fxJpyToVnd: 10001 }, { serviceFeePercent: -1 }, { serviceFeePercent: 101 }, { fxJpyToVnd: '200' }, { serviceFeePercent: 1.001 }]) {
      const result = await server.inject({ method: 'PUT', url: '/api/admin/pricing', headers, payload: { version: 1, fxJpyToVnd: 200, serviceFeePercent: 15, ...patch } });
      assert.equal(result.statusCode, 400, result.body);
    }
    assert.equal((await getPricingPolicy()).version, 1);
    const preview = await server.inject({ method: 'POST', url: '/api/admin/pricing/preview', headers, payload: { fxJpyToVnd: 200, serviceFeePercent: 15 } });
    assert.equal(preview.json().exampleVnd, 230000);
    const result = await server.inject({ method: 'PUT', url: '/api/admin/pricing', headers, payload: { version: 1, fxJpyToVnd: 200, serviceFeePercent: 15 } });
    assert.equal(result.statusCode, 200); assert.equal(result.json().version, 2);
    await assert.rejects(savePolicy({ version: 1, fxJpyToVnd: 190, serviceFeePercent: 12 }, 1));
    const current = await checkout();
    assert.equal(current.subtotalVnd, 460000); assert.equal(current.version, 2);
    assert.equal((await getProductDetails(asin))!.priceVnd, 230000);
    const persisted = (await db.query('SELECT * FROM orders WHERE id=$1', [old.orderId])).rows[0];
    assert.equal(Number(persisted.merchandise_vnd), 426000);
    assert.equal(Number(persisted.fx_jpy_to_vnd), 190); assert.equal(Number(persisted.service_fee_percent), 12);
    assert.equal(persisted.pricing_policy_version, 1);
    assert.equal(toVnd(1000, await getPricingPolicy()), 230000);
    const audit = (await db.query("SELECT * FROM admin_audit_events WHERE action='pricing.changed'")).rows[0];
    assert.equal(audit.before_value.serviceFeePercent, 12); assert.equal(audit.after_value.fxJpyToVnd, 200);
    // Failure to write the audit must roll back the policy as well.
    await assert.rejects(savePolicy({ version: 2, fxJpyToVnd: 210, serviceFeePercent: 16 }, 999));
    assert.deepEqual(await getPricingPolicy(), { version: 2, fxJpyToVnd: 200, serviceFeePercent: 15 });
  });
  await t.test('queue deduplicates concurrent requests, processes success and records denied/malformed sources', async () => {
    const target = 'A000000003';
    const results = await Promise.all([enqueueImport(target, category, 1), enqueueImport(target, category, 1)]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM catalog_import_requests WHERE asin=$1', [target])).rows[0].n, 1);
    assert.ok(results.some(r => 'duplicate' in r && r.duplicate));
    assert.equal(await getProductDetails(target), null);
    await processNextImport(async id => observation(id));
    assert.ok(await getProductDetails(target));
    assert.equal((await db.query('SELECT state FROM catalog_import_requests WHERE asin=$1', [target])).rows[0].state, 'succeeded');
    for (const [id, denied] of [['A000000004', true], ['A000000005', false]] as const) {
      await enqueueImport(id, category, 1);
      await processNextImport(async () => { throw new SourceError(denied ? 'blocked' : 'parse_error', denied ? 'HTTP 403' : 'Missing product title'); });
      assert.equal((await db.query('SELECT state FROM catalog_import_requests WHERE asin=$1', [id])).rows[0].state, denied ? 'needs_human' : 'failed');
      assert.equal(await getProductDetails(id), null);
    }
    await enqueueImport('A000000006', category, 1);
    await db.query("UPDATE catalog_import_requests SET state='running',started_at=now()-interval '6 minutes' WHERE asin='A000000006'");
    await processNextImport();
    assert.equal((await db.query("SELECT state FROM catalog_import_requests WHERE asin='A000000006'")).rows[0].state, 'needs_human');
  });
  await t.test('import queue bounds hourly submissions and total pending work', async () => {
    const count = (await db.query('SELECT count(*)::int AS n FROM catalog_import_requests')).rows[0].n;
    for (let index = count; index < 20; index++) await enqueueImport(`L${String(index).padStart(9, '0')}`, category, 1);
    await assert.rejects(enqueueImport('L999999999', category, 1), (error: unknown) => error instanceof Error && 'status' in error && error.status === 429);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM catalog_import_requests')).rows[0].n, 20);
  });
  await t.test('overview reports real sync errors and missing scheduled results, with bounded reads', async () => {
    const empty = await overview(); assert.equal(empty.missingScheduledRun, true); assert.equal(empty.latestSync, null);
    for (const state of ['partial', 'failed', 'needs_human']) {
      const run = (await db.query('INSERT INTO sync_runs(state,finished_at,error_count) VALUES($1,now(),1) RETURNING id', [state])).rows[0];
      await db.query("INSERT INTO sync_errors(sync_run_id,state,message) VALUES($1,$2,'Source unavailable')", [run.id, state]);
      const result = await overview(); assert.equal(result.latestSync.state, state); assert.equal(result.syncErrors[0].message, 'Source unavailable');
      assert.equal(result.missingScheduledRun, false); assert.ok(result.recentOrders.length <= 5);
    }
    const orders = await server.inject({ url: '/api/admin/orders?q=0901234567&limit=1', headers: { ...local, cookie } });
    assert.equal(orders.json().items.length, 1);
    const detail = await server.inject({ url: `/api/admin/orders/${orders.json().items[0].id}`, headers: { ...local, cookie } });
    assert.equal(detail.json().customer_address, 'Private address');
    assert.equal((await server.inject({ method: 'PATCH', url: `/api/admin/orders/${orders.json().items[0].id}`, headers: { ...local, cookie, 'x-csrf-token': csrf }, payload: { status: 'paid' } })).statusCode, 404);
    assert.equal((await server.inject({ url: '/api/admin/products?page=-1', headers: { ...local, cookie } })).statusCode, 400);
  });
  await t.test('expired sessions, logout and local password reset revoke access', async () => {
    await db.query("UPDATE admin_sessions SET expires_at=now()-interval '1 second'");
    assert.equal((await server.inject({ url: '/api/admin/orders', headers: { ...local, cookie } })).statusCode, 401);
    const signIn = async () => server.inject({ method: 'POST', url: '/api/admin/login', headers: local, payload: { password } });
    let result = await signIn(); cookie = String(result.headers['set-cookie']).split(';')[0]; csrf = result.json().csrfToken;
    assert.equal((await server.inject({ method: 'POST', url: '/api/admin/logout', headers: { ...local, cookie, 'x-csrf-token': csrf } })).statusCode, 200);
    assert.equal((await server.inject({ url: '/api/admin/orders', headers: { ...local, cookie } })).statusCode, 401);
    result = await signIn(); cookie = String(result.headers['set-cookie']).split(';')[0];
    await provisionOwner('New integration password 123!', true);
    assert.equal((await server.inject({ url: '/api/admin/orders', headers: { ...local, cookie } })).statusCode, 401);
    assert.equal((await signIn()).statusCode, 401);
  });
  await t.test('concurrent pricing saves have one winner and checkouts use one complete policy', async () => {
    const old = await getPricingPolicy();
    const operations = await Promise.allSettled([
      savePolicy({ ...old, fxJpyToVnd: 220, serviceFeePercent: 18 }, 1),
      savePolicy({ ...old, fxJpyToVnd: 230, serviceFeePercent: 20 }, 1),
      checkout(), checkout(), checkout(),
    ]);
    assert.equal(operations.slice(0, 2).filter(r => r.status === 'fulfilled').length, 1);
    for (const result of operations.slice(2)) {
      assert.equal(result.status, 'fulfilled');
      if (result.status !== 'fulfilled') continue;
      const order = result.value as Awaited<ReturnType<typeof checkout>>;
      const persisted = (await db.query('SELECT * FROM orders WHERE id=$1', [order.orderId])).rows[0];
      assert.equal(Number(persisted.merchandise_vnd), toVnd(1000, { fxJpyToVnd: Number(persisted.fx_jpy_to_vnd), serviceFeePercent: Number(persisted.service_fee_percent) }) * 2);
      assert.equal(persisted.pricing_policy_version, order.version);
    }
  });
});
