import Fastify from 'fastify';
import { db } from './db/pool.js';
import { config } from './config.js';
import { getProductDetails, listCatalog, listPublicAsins } from './catalog.js';
import { CheckoutError, createOrder } from './orders.js';
import { adminRoutes } from './admin/routes.js';
import { orderAlertRelayRoutes } from './order-alert-relay.js';
import { amazonQuoteRoutes } from './amazon-quote-routes.js';
import { QuoteError } from './amazon-quote-source.js';
import { startEmailAlertScheduler } from './notifications/email-scheduler.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// Opt-in local desktop lifecycle only. Never enabled on VPS or ordinary launches.
type LocalLifecycle = { runId: string; stopFile: string };
export function getLocalBackendLifecycle(environment: NodeJS.ProcessEnv = process.env,
  port = config.port, databaseUrl = config.databaseUrl, platform = process.platform): LocalLifecycle | undefined {
  const runId = environment.MITA_BACKEND_RUN_ID;
  if (!runId || !/^[a-f0-9]{32}$/.test(runId)) return undefined;
  const stopFile = join(fileURLToPath(new URL('../../.agents/runtime/backend-4000/', import.meta.url)), `${runId}.backend-stop`);
  return platform === 'win32' && port === 4000 &&
    databaseUrl === 'postgresql://mita_local@127.0.0.1:5433/postgres' &&
    environment.MITA_BACKEND_STOP_FILE === stopFile ? { runId, stopFile } : undefined;
}

export function isLocalBackendStopRequested(lifecycle: LocalLifecycle): boolean {
  try {
    return readFileSync(lifecycle.stopFile, 'ascii').trim() === lifecycle.runId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function buildServer(logger = false) {
  const localLifecycle = getLocalBackendLifecycle();
  const server = Fastify({ logger: logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'], serializers: { req: req => ({ method: req.method, url: req.url?.split('?')[0] }) } } : false, bodyLimit: 32768 });
  server.register(adminRoutes, { prefix: '/api/admin' });
  server.register(orderAlertRelayRoutes);
  server.register(amazonQuoteRoutes, { prefix: '/api/amazon' });

  server.get('/api/health', async () => {
    const result = await db.query('SELECT 1');
    return { ok: result.rowCount === 1, mode: 'local-simulation', database: 'postgresql',
      ...(localLifecycle ? { lifecycleRunId: localLifecycle.runId } : {}) };
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

  server.get('/api/catalog/asins', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await listPublicAsins();
    } catch {
      request.log.error({ code: 'public_asin_inventory_failed' }, 'Public ASIN inventory unavailable');
      return reply.code(503).send({ error: 'Public ASIN inventory unavailable' });
    }
  });

  server.get('/api/catalog/products/:asin', async (request, reply) => {
    const { asin } = request.params as { asin: string };
    const result = await getProductDetails(asin);
    if (!result) return reply.code(404).send({ error: 'Không tìm thấy sản phẩm' });
    return result;
  });

  server.post('/api/checkout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (config.publicReadOnly) return reply.code(404).send({ error: 'Chức năng tạo đơn đang tạm đóng.' });
    try {
      // An unguessable, unexpired Amazon quote was already issued under the
      // source lookup quota. Only an expired quote's automatic source refresh
      // spends another lookup slot; valid checkout and idempotent retries do not.
      return await createOrder(request.body, request.ip);
    } catch (error) {
      if (error instanceof QuoteError) {
        if (error.status === 429) reply.header('Retry-After', '60');
        return reply.code(error.status).send({ code: error.code,
          ...(error.details ? { details: error.details } : {}),
          ...(error.retryAfterAt ? { retryAfterAt: error.retryAfterAt } : {}) });
      }
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
  let stopEmailAlerts = async () => {};
  let lifecycleTimer: ReturnType<typeof setInterval> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    await stopEmailAlerts(); await server.close(); await db.end();
  })();
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await server.listen({ port: config.port, host: '127.0.0.1' });
  stopEmailAlerts = startEmailAlertScheduler();
  const localLifecycle = getLocalBackendLifecycle();
  if (localLifecycle) {
    const timer = setInterval(() => {
      try {
        if (isLocalBackendStopRequested(localLifecycle)) {
          clearInterval(timer);
          void shutdown().catch(() => { process.exitCode = 1; });
        }
      } catch (error) {
        clearInterval(timer);
        server.log.error('Local lifecycle stop file could not be read');
      }
    }, 200);
    lifecycleTimer = timer;
    timer.unref();
  }
}
