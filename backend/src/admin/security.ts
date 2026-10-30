import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/pool.js';
import { config } from '../config.js';

const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, scryptOptions, (error, key) => error ? reject(error) : resolve(key));
});
export const cookieName = 'mita_admin';
const sessionSeconds = 8 * 60 * 60;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const csrfToken = (token: string) => digest(`mita-csrf:${token}`);
export const validPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 12 && value.length <= 128;

export async function hashPassword(password: string) {
  if (!validPassword(password)) throw new Error('Mật khẩu cần từ 12 đến 128 ký tự.');
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [method, salt, key] = hash.split(':');
  if (method !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(key ?? '')) return false;
  const candidate = await scryptAsync(password, salt);
  return timingSafeEqual(candidate, Buffer.from(key, 'hex'));
}
export function readToken(cookie?: string) {
  const token = cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function getSession(cookie?: string) {
  const token = readToken(cookie);
  if (!token) return null;
  const result = await db.query<{ account_id: number; role: 'owner' | 'staff'; expires_at: Date }>(
    'SELECT s.account_id,a.role,s.expires_at FROM admin_sessions s JOIN admin_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.enabled=true',
    [digest(token)]);
  return result.rows[0] ? { actorId: result.rows[0].account_id, role: result.rows[0].role, csrfToken: csrfToken(token), expiresAt: result.rows[0].expires_at } : null;
}
export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionSeconds : 0}${secure ? '; Secure' : ''}`);
}
export function isLocalRequest(request: FastifyRequest) {
  // trustProxy stays disabled. Never accept forwarded host/IP as proof of locality.
  const localIp = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
  const host = request.headers.host ?? '';
  return localIp && /^(localhost|127\.0\.0\.1):[0-9]+$/.test(host);
}
export function validOrigin(request: FastifyRequest) {
  return [config.webPort, config.port].some(port => ['127.0.0.1', 'localhost'].some(host => request.headers.origin === `http://${host}:${port}`));
}

export async function login(password: unknown, username: unknown = 'owner') {
  if (typeof username !== 'string' || !/^[a-z][a-z0-9_-]{2,31}$/.test(username)) return { status: 401 as const };
  // Reserve a bounded attempt in PostgreSQL before expensive password hashing.
  // The owner limit is independent: a staff login must never reset or consume it.
  const reserved = username === 'owner' ? await db.query(`UPDATE admin_login_limit SET
    attempts=CASE WHEN window_started_at <= now()-interval '15 minutes' THEN 1 ELSE attempts+1 END,
    window_started_at=CASE WHEN window_started_at <= now()-interval '15 minutes' THEN now() ELSE window_started_at END
    WHERE id=1 AND (attempts<5 OR window_started_at <= now()-interval '15 minutes') RETURNING id`) :
    await db.query(`INSERT INTO admin_staff_login_limit(username,attempts,window_started_at)
      SELECT username,1,now() FROM admin_accounts WHERE username=$1 AND role='staff' AND enabled=true
      ON CONFLICT (username) DO UPDATE SET
        attempts=CASE WHEN admin_staff_login_limit.window_started_at <= now()-interval '15 minutes' THEN 1 ELSE admin_staff_login_limit.attempts+1 END,
        window_started_at=CASE WHEN admin_staff_login_limit.window_started_at <= now()-interval '15 minutes' THEN now() ELSE admin_staff_login_limit.window_started_at END
      WHERE admin_staff_login_limit.attempts<5 OR admin_staff_login_limit.window_started_at <= now()-interval '15 minutes'
      RETURNING username`, [username]);
  // Unknown/disabled staff and locked staff all return 401; do not reveal accounts.
  if (!reserved.rowCount) return { status: username === 'owner' ? 429 as const : 401 as const };
  if (!validPassword(password)) return { status: 401 as const };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock against a concurrent local password reset until this session is created.
    const account = await client.query<{id: number; password_hash: string}>('SELECT id,password_hash FROM admin_accounts WHERE username=$1 AND enabled=true FOR SHARE', [username]);
    if (!account.rows[0] || !await verifyPassword(password, account.rows[0].password_hash)) {
      await client.query('ROLLBACK');
      return { status: 401 as const };
    }
    await client.query('DELETE FROM admin_sessions WHERE expires_at<=now()');
    const token = randomBytes(32).toString('hex');
    await client.query("INSERT INTO admin_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [digest(token),account.rows[0].id]);
    if (username === 'owner') {
      await client.query('UPDATE admin_login_limit SET attempts=0,window_started_at=now() WHERE id=1');
    } else {
      await client.query('UPDATE admin_staff_login_limit SET attempts=0,window_started_at=now() WHERE username=$1', [username]);
    }
    await client.query('COMMIT');
    return { status: 200 as const, token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
