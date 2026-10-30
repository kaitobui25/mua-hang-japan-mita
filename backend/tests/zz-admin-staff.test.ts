import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '../src/db/pool.js';
import { buildServer } from '../src/server.js';
import { provisionOwner } from '../src/admin/owner.js';
import { provisionStaff, disableStaff } from '../src/admin/staff.js';

const app = buildServer();
const local = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:3000' };
const staffUser = 'mita_test_staff';
const staffPassword = 'A distinct staff password 2026!';
const ownerPassword = 'Admin staff integration password 2026!';

after(async () => { await app.close(); await db.end(); });

test('staff can read alerts, cannot acknowledge or edit, and loses access on disable', async () => {
  await provisionOwner(ownerPassword, true);
  await provisionStaff(staffUser, staffPassword);

  const login = await app.inject({
    method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: staffUser, password: staffPassword }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const csrf = login.json().csrfToken as string;
  const headers = { ...local, cookie, 'x-csrf-token': csrf };
  const session = await app.inject({ url: '/api/admin/session', headers });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().role, 'staff');
  assert.equal((await app.inject({ url: '/api/admin/notifications', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/orders', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/pricing', headers })).statusCode, 200);
  for (const [method, url, payload] of [
    ['PUT', '/api/admin/pricing', {}],
    ['PUT', '/api/admin/translation-settings', {}],
    ['PATCH', '/api/admin/products/AAAAAAAAAA/visibility', { hidden: true }],
    ['POST', '/api/admin/notifications/1/ack', {}]
  ] as const) {
    assert.equal((await app.inject({ method, url, headers, payload })).statusCode, 403, url);
  }
  // Logging out is allowed even without owner privileges.
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/logout', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/session', headers })).statusCode, 401);

  const again = await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: staffUser, password: staffPassword } });
  assert.equal(again.statusCode, 200);
  const againCookie = String(again.headers['set-cookie']).split(';')[0];
  // A known staff password must not reset owner's failure budget.
  await db.query('UPDATE admin_login_limit SET attempts=0,window_started_at=now() WHERE id=1');
  for (let i = 0; i < 4; i++) {
    const failedOwner = await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
      payload: { username: 'owner', password: 'Wrong owner password 2026!' } });
    assert.equal(failedOwner.statusCode, 401);
  }
  const staffResetsOnlySelf = await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: staffUser, password: staffPassword } });
  assert.equal(staffResetsOnlySelf.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: 'owner', password: 'Wrong owner password 2026!' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: 'owner', password: ownerPassword } })).statusCode, 429,
    'owner remains locked after staff success');

  // Staff failures cannot consume the owner's independent attempt budget.
  await db.query('UPDATE admin_login_limit SET attempts=0,window_started_at=now() WHERE id=1');
  for (let i = 0; i < 5; i++) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
      payload: { username: staffUser, password: 'Wrong staff password 2026!' } })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: staffUser, password: staffPassword } })).statusCode, 401,
    'staff is rate limited without revealing account existence');
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: 'owner', password: ownerPassword } })).statusCode, 200,
    'staff lock cannot lock the owner out');
  await disableStaff(staffUser);
  assert.equal((await app.inject({ url: '/api/admin/session', headers: { ...local, cookie: againCookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/login', headers: local,
    payload: { username: staffUser, password: staffPassword } })).statusCode, 401);
});
