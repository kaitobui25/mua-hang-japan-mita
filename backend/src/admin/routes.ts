import type { FastifyInstance } from 'fastify';
import { db } from '../db/pool.js';
import { getPricingPolicy, toVnd, validatePolicy } from '../pricing.js';
import { AdminError, getCatalogSettings, getTranslationSettings, listOrders, listProducts, orderDetail, overview, saveCatalogSettings, savePolicy, saveTranslationSettings, setVisibility, updateOrder } from './data.js';
import { recentAdminIssues } from './issues.js';
import { enqueueImport, listImports } from './imports.js';
import { csrfToken, digest, getSession, isLocalRequest, login, readToken, setSessionCookie, validOrigin } from './security.js';

declare module 'fastify' {
  interface FastifyRequest { adminSession: Awaited<ReturnType<typeof getSession>> }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function adminRoutes(server: FastifyInstance) {
  server.decorateRequest('adminSession', null);
  server.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('X-Content-Type-Options', 'nosniff');
    if (!isLocalRequest(request)) return reply.code(403).send({ error: 'Admin chỉ dùng qua localhost.' });
    const write = !['GET', 'HEAD'].includes(request.method);
    if (write && !validOrigin(request)) return reply.code(403).send({ error: 'Origin không hợp lệ.' });
    const loginRoute = request.routeOptions.url === '/api/admin/login' && request.method === 'POST';
    if (loginRoute) return;
    request.adminSession = await getSession(request.headers.cookie);
    if (!request.adminSession) return reply.code(401).send({ error: 'Vui lòng đăng nhập owner.' });
    if (write && request.headers['x-csrf-token'] !== request.adminSession.csrfToken) return reply.code(403).send({ error: 'Phiên xác nhận không hợp lệ. Tải lại trang.' });
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdminError) return reply.code(error.status).send({ error: error.message });
    const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'Yêu cầu không hợp lệ.' });
    // Do not serialize SQL errors, request bodies or customer details into logs/responses.
    server.log.error({ code: 'admin_operation_failed' }, 'Admin operation failed');
    return reply.code(500).send({ error: 'Không thể xử lý. Kiểm tra cơ sở dữ liệu và thử lại.' });
  });
  server.post('/login', { bodyLimit: 2048 }, async (request, reply) => {
    const body = request.body as { password?: unknown } | null;
    const result = await login(body?.password);
    if (result.status !== 200) {
      if (result.status === 429) reply.header('Retry-After', '900');
      return reply.code(result.status).send({ error: result.status === 429 ? 'Quá nhiều lần thử. Vui lòng chờ 15 phút.' : 'Không thể đăng nhập. Kiểm tra mật khẩu owner.' });
    }
    setSessionCookie(reply, result.token, request.protocol === 'https');
    return { csrfToken: csrfToken(result.token) };
  });
  server.get('/session', async request => request.adminSession);
  server.post('/logout', async (request, reply) => {
    await db.query('DELETE FROM admin_sessions WHERE token_hash=$1', [digest(readToken(request.headers.cookie)!)]);
    setSessionCookie(reply, '', request.protocol === 'https');
    return { ok: true };
  });
  server.get('/overview', overview);
  server.get('/issues', async request => {
    const query = request.query as { asin?: string };
    if (query.asin && !/^[A-Z0-9]{10}$/.test(query.asin)) throw new AdminError(400, 'ASIN không hợp lệ.');
    return recentAdminIssues(query.asin);
  });
  server.get('/products', async request => listProducts(request.query as Record<string, string | undefined>));
  server.patch('/products/:asin/visibility', async request => {
    const { asin } = request.params as { asin: string };
    const body = request.body as { hidden?: unknown } | null;
    if (!/^[A-Z0-9]{10}$/.test(asin) || typeof body?.hidden !== 'boolean') throw new AdminError(400, 'ASIN hoặc trạng thái không hợp lệ.');
    return setVisibility(asin, body.hidden, request.adminSession!.actorId);
  });
  server.get('/imports', async request => listImports(request.query as Record<string, string | undefined>));
  server.post('/imports', { bodyLimit: 4096 }, async (request, reply) => {
    const body = request.body as { input?: unknown; category?: unknown } | null;
    const result = await enqueueImport(body?.input, body?.category, request.adminSession!.actorId);
    return reply.code('existingProduct' in result || result.duplicate ? 200 : 202).send(result);
  });
  server.get('/orders', async request => listOrders(request.query as Record<string, string | undefined>));
  server.get('/orders/:id', async request => {
    const { id } = request.params as { id: string };
    if (!uuid.test(id)) throw new AdminError(400, 'Mã đơn không hợp lệ.');
    return orderDetail(id);
  });
  server.patch('/orders/:id', async request => {
    const { id } = request.params as { id: string };
    if (!uuid.test(id)) throw new AdminError(400, 'Mã đơn hàng không hợp lệ.');
    const body = request.body as { status?: string; paymentStatus?: string; shippingFinalVnd?: number } | null;
    return updateOrder(id, body ?? {}, request.adminSession!.actorId);
  });
  server.get('/pricing', async () => {
    const policy = await getPricingPolicy();
    return { ...policy, exampleVnd: toVnd(1000, policy) };
  });
  server.get('/catalog-settings', async () => getCatalogSettings());
  server.get('/translation-settings', async () => getTranslationSettings());
  server.put('/translation-settings', async request => {
    const body = request.body as Parameters<typeof saveTranslationSettings>[0] | null;
    if (!body) throw new AdminError(400, 'Thiếu cấu hình bản dịch.');
    return saveTranslationSettings(body, request.adminSession!.actorId);
  });
  server.put('/catalog-settings', async request => {
    const body = request.body as Parameters<typeof saveCatalogSettings>[0] | null;
    if (!body) throw new AdminError(400, 'Thiếu cấu hình hiển thị.');
    return saveCatalogSettings(body, request.adminSession!.actorId);
  });
  server.post('/pricing/preview', async request => {
    const body = request.body as { fxJpyToVnd: number; serviceFeePercent: number } | null;
    if (!body) throw new AdminError(400, 'Thiếu cấu hình.');
    try { validatePolicy(body); } catch (error) { throw new AdminError(400, (error as Error).message); }
    return { fxJpyToVnd: body.fxJpyToVnd, serviceFeePercent: body.serviceFeePercent, exampleVnd: toVnd(1000, body) };
  });
  server.put('/pricing', async request => {
    const body = request.body as Parameters<typeof savePolicy>[0] | null;
    if (!body) throw new AdminError(400, 'Thiếu cấu hình.');
    return savePolicy(body, request.adminSession!.actorId);
  });
}
