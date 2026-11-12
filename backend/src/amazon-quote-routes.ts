import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db } from './db/pool.js';
import { amazonQuotesEnabled, config } from './config.js';
import { createAmazonQuote, refreshAmazonQuote, quoteRateLimit } from './amazon-quotes.js';
import { QuoteError, uuid, amazonAsin, quoteQuantity } from './amazon-quote-source.js';
import { createAmazonPurchaseRequest } from './amazon-purchase-requests.js';

export async function amazonQuoteRoutes(server: FastifyInstance) {
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (config.publicReadOnly) return reply.code(404).send({ code: 'checkout_disabled' });
  });
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof QuoteError) {
      if (error.status === 429) reply.header('Retry-After', '60');
      return reply.code(error.status).send({ code: error.code,
        ...(error.details ? { details: error.details } : {}),
        ...(error.retryAfterAt ? { retryAfterAt: error.retryAfterAt } : {}) });
    }
    const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 503;
    if (status >= 400 && status < 500) return reply.code(status).send({ code: 'invalid_quote_request' });
    request.log.error({ code: 'quote_operation_failed' }, 'Quote operation failed');
    return reply.code(503).send({ code: 'quote_unavailable' });
  });
  server.post('/quotes', { bodyLimit: 4096 }, async request => {
    const body = request.body as { input?: unknown; quantity?: unknown } | null;
    amazonAsin(body?.input); quoteQuantity(body?.quantity ?? 1);
    if (!amazonQuotesEnabled()) throw new QuoteError('amazon_quotes_disabled', 503);
    await quoteRateLimit(request.ip);
    return { quote: await createAmazonQuote(body?.input, body?.quantity ?? 1) };
  });
  server.post('/quotes/:id/refresh', { bodyLimit: 1024 }, async request => {
    const { id } = request.params as { id: string };
    if (!uuid.test(id)) throw new QuoteError('invalid_quote_id', 400);
    if (!amazonQuotesEnabled()) throw new QuoteError('amazon_quotes_disabled', 503);
    await quoteRateLimit(request.ip);
    return refreshAmazonQuote(id);
  });
  // A request to contact Mita, not a priced checkout. A source-backed,
  // unexpired preview ID is mandatory; posted product/price fields are ignored.
  server.post('/purchase-requests', { bodyLimit: 4096 }, async request => {
    if (!amazonQuotesEnabled()) throw new QuoteError('amazon_quotes_disabled', 503);
    // The source lookup already used the bounded Amazon quote quota. Spending
    // another slot here would strand the last eligible preview at the limit.
    // The 15-minute, unguessable, once-only server ID bounds request creation.
    return createAmazonPurchaseRequest(request.body);
  });
  // The opaque token is returned only at checkout; this endpoint exposes no customer data.
  server.post('/orders/:id/shipping', { bodyLimit: 1024 }, async request => {
    const { id } = request.params as { id: string };
    const body = request.body as { token?: unknown } | null;
    if (!uuid.test(id) || typeof body?.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new QuoteError('invalid_shipping_confirmation', 400);
    const result = await db.query(`SELECT shipping_proposed_vnd,shipping_final_vnd,shipping_confirmed_at FROM orders
      WHERE id=$1 AND shipping_confirmation_hash=$2 AND status<>'cancelled'`, [id, createHash('sha256').update(body.token).digest('hex')]);
    if (!result.rowCount) throw new QuoteError('shipping_confirmation_conflict', 409);
    const row = result.rows[0];
    return { orderId: id, shippingProposedVnd: row.shipping_proposed_vnd === null ? null : Number(row.shipping_proposed_vnd),
      shippingFinalVnd: row.shipping_final_vnd === null ? null : Number(row.shipping_final_vnd), confirmedAt: row.shipping_confirmed_at };
  });
  server.post('/orders/:id/shipping/confirm', { bodyLimit: 1024 }, async request => {
    const { id } = request.params as { id: string };
    const body = request.body as { token?: unknown; shippingVnd?: unknown } | null;
    if (!uuid.test(id) || typeof body?.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token) ||
        !Number.isSafeInteger(body.shippingVnd) || Number(body.shippingVnd) < 0 || Number(body.shippingVnd) > 1000000000) throw new QuoteError('invalid_shipping_confirmation', 400);
    const result = await db.query(`UPDATE orders SET shipping_final_vnd=shipping_proposed_vnd,shipping_confirmed_at=COALESCE(shipping_confirmed_at,clock_timestamp())
      WHERE id=$1 AND shipping_confirmation_hash=$2 AND shipping_proposed_vnd=$3 AND status<>'cancelled'
      RETURNING id,shipping_final_vnd`, [id, createHash('sha256').update(body.token).digest('hex'), body.shippingVnd]);
    if (!result.rowCount) throw new QuoteError('shipping_confirmation_conflict', 409);
    return { orderId: id, shippingFinalVnd: Number(result.rows[0].shipping_final_vnd), confirmed: true };
  });
}
