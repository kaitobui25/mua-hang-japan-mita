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
  const result = await db.query('SELECT account_id,expires_at FROM admin_sessions WHERE token_hash=$1 AND expires_at>now()', [digest(token)]);
  return result.rows[0] ? { actorId: result.rows[0].account_id as number, csrfToken: csrfToken(token), expiresAt: result.rows[0].expires_at as Date } : null;
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

export async function login(password: unknown) {
  // Reserve a bounded attempt in PostgreSQL before expensive password hashing.
  // A global owner limit also prevents parallel attempts from bypassing the cap.
  const reserved = await db.query(`UPDATE admin_login_limit SET
    attempts=CASE WHEN window_started_at <= now()-interval '15 minutes' THEN 1 ELSE attempts+1 END,
    window_started_at=CASE WHEN window_started_at <= now()-interval '15 minutes' THEN now() ELSE window_started_at END
    WHERE id=1 AND (attempts<5 OR window_started_at <= now()-interval '15 minutes') RETURNING id`);
  if (!reserved.rowCount) return { status: 429 as const };
  if (!validPassword(password)) return { status: 401 as const };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock against a concurrent local password reset until this session is created.
    const owner = await client.query('SELECT password_hash FROM admin_accounts WHERE id=1 FOR SHARE');
    if (!owner.rows[0] || !await verifyPassword(password, owner.rows[0].password_hash)) {
      await client.query('ROLLBACK');
      return { status: 401 as const };
    }
    await client.query('DELETE FROM admin_sessions WHERE expires_at<=now()');
    const token = randomBytes(32).toString('hex');
    await client.query("INSERT INTO admin_sessions(token_hash,account_id,expires_at) VALUES($1,1,now()+interval '8 hours')", [digest(token)]);
    await client.query('UPDATE admin_login_limit SET attempts=0,window_started_at=now() WHERE id=1');
    await client.query('COMMIT');
    return { status: 200 as const, token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
