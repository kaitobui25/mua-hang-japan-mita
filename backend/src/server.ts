import Fastify from 'fastify';
import { db } from './db/pool.js';
import { config } from './config.js';
import { getProductDetails, listCatalog } from './catalog.js';
import { CheckoutError, createOrder } from './orders.js';
import { adminRoutes } from './admin/routes.js';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function buildServer(logger = false) {
  const server = Fastify({ logger: logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'], serializers: { req: req => ({ method: req.method, url: req.url?.split('?')[0] }) } } : false, bodyLimit: 32768 });
  server.register(adminRoutes, { prefix: '/api/admin' });

  server.get('/api/health', async () => {
    const result = await db.query('SELECT 1');
    return { ok: result.rowCount === 1, mode: 'local-simulation', database: 'postgresql' };
  });

  server.get('/api/categories', async () => {
    const result = await db.query('SELECT slug,name FROM categories ORDER BY slug');
    return result.rows;
  });

  server.get('/api/catalog', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const page = Number(q.page ?? 1);
    const limit = Number(q.limit ?? 24);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (q.q?.length ?? 0) > 200) return reply.code(400).send({ error: 'Invalid pagination or search' });
    return listCatalog({ category: q.category, q: q.q, sort: q.sort, page, limit });
  });

  server.get('/api/catalog/products/:asin', async (request, reply) => {
    const { asin } = request.params as { asin: string };
    const result = await getProductDetails(asin);
    if (!result) return reply.code(404).send({ error: 'Không tìm thấy sản phẩm' });
    return result;
  });

  server.post('/api/checkout', async (request, reply) => {
    if (config.publicReadOnly) return reply.code(404).send({ error: 'Chức năng tạo đơn đang tạm đóng.' });
    try {
      return await createOrder(request.body);
    } catch (error) {
      if (error instanceof CheckoutError) return reply.code(422).send({ code: error.code, error: error.message });
      request.log.error({ code: 'checkout_failed' }, 'Checkout persistence failed');
      return reply.code(500).send({ code: 'checkout_failed', error: 'Không thể tạo đơn lúc này. Vui lòng thử lại sau.' });
    }
  });

  server.get('/api/sync-status', async () => {
    const runs = await db.query('SELECT id,started_at,finished_at,state,discovered_count,saved_count,error_count,note FROM sync_runs ORDER BY id DESC LIMIT 5');
    return { runs: runs.rows };
  });

  return server;
}

// Production releases are activated through a "current" symlink. Resolve the
// entrypoint before comparing it with the ESM module URL, or node exits without
// starting Fastify even though systemd reports a clean exit.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const server = buildServer(true);
  const shutdown = async () => { await server.close(); await db.end(); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await server.listen({ port: config.port, host: '127.0.0.1' });
}
