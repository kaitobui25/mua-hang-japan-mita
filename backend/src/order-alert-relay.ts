import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { acknowledgeLocalOrderNotification, eventId, listLocalOrderNotifications } from './admin/notifications.js';
import { AdminError } from './admin/data.js';

const relayUrl = 'https://mitajapanshop.duckdns.org/api/order-alert-relay';
const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const relayIdPattern = /^[1-9][0-9]{0,18}$/;
const maxId = BigInt('9223372036854775807');
let lastSafeFailureLog = 0;

function noteRelayFailure() {
  const now = Date.now();
  if (now - lastSafeFailureLog < 60_000) return;
  lastSafeFailureLog = now;
  // Never include URLs, auth headers, response bodies, customer fields or errors.
  console.warn('order_alert_relay_unavailable');
}

export type OrderNotice = {
  id: string;
  orderId: string;
  eventType: string;
  createdAt: Date | string;
  acknowledgedAt: Date | string | null;
  orderStatus: string;
  source: 'local' | 'vps';
};
type RelayStatus = 'disabled' | 'connected' | 'unavailable';
type RelayResult = { items: OrderNotice[]; unreadCount: number; status: RelayStatus };

function incomingToken() {
  const secret = process.env.MITA_ORDER_ALERT_RELAY_INBOUND_TOKEN;
  return secret && tokenPattern.test(secret) ? secret : null;
}

function outgoingSettings() {
  const url = process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_URL;
  const token = process.env.MITA_ORDER_ALERT_RELAY_OUTBOUND_TOKEN;
  if (!url && !token) return { status: 'disabled' as const };
  // Pin the public hostname and path: never fetch an arbitrary URL from an env typo.
  if (url !== relayUrl || !token || !tokenPattern.test(token)) return { status: 'unavailable' as const };
  return { status: 'connected' as const, token };
}

function authorized(value: unknown, secret: string) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ') || value.length > 256) return false;
  const provided = value.slice(7);
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** HTTPS route must be explicitly allowlisted in the Mita-only Caddy site. */
export async function orderAlertRelayRoutes(server: FastifyInstance) {
  server.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff');
    const secret = incomingToken();
    if (!secret) return reply.code(404).send({ error: 'Not found' });
    if (!authorized(request.headers.authorization, secret)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  });
  server.setErrorHandler((_error, _request, reply) =>
    reply.code(500).send({ error: 'Order alert relay unavailable' }));
  server.get('/api/order-alert-relay', async (request, reply) => {
    try {
      const result = await listLocalOrderNotifications(request.query as Record<string, string | undefined>);
      return { items: result.items, unreadCount: result.unreadCount };
    } catch (error) {
      if (error instanceof AdminError && error.status === 400) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      throw error;
    }
  });
  server.post('/api/order-alert-relay/:id/ack', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await acknowledgeLocalOrderNotification(eventId(id));
    } catch (error) {
      if (error instanceof AdminError && error.status === 404) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (error instanceof AdminError && error.status === 400) {
        return reply.code(400).send({ error: 'Invalid event ID' });
      }
      throw error;
    }
  });
}

function validRemoteNotice(value: unknown): value is Omit<OrderNotice, 'source'> {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && relayIdPattern.test(row.id) && BigInt(row.id) <= maxId &&
    typeof row.orderId === 'string' && uuidPattern.test(row.orderId) &&
    row.eventType === 'order_placed' &&
    typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) &&
    (row.acknowledgedAt === null || typeof row.acknowledgedAt === 'string' &&
      Number.isFinite(Date.parse(row.acknowledgedAt))) &&
    typeof row.orderStatus === 'string' &&
    ['pending_confirmation', 'confirmed', 'purchasing', 'purchased', 'shipping', 'completed', 'cancelled']
      .includes(row.orderStatus);
}

async function remoteRequest(path: string, method: 'GET' | 'POST') {
  const settings = outgoingSettings();
  if (settings.status !== 'connected') throw new Error('relay_not_configured');
  const response = await fetch(relayUrl + path, {
    method, headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/json' },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(3000)
  });
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error('relay_request_failed');
  }
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > 128 * 1024) throw new Error('relay_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('relay_response_empty');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 128 * 1024) {
      await reader.cancel();
      throw new Error('relay_response_too_large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function fetchVpsNotifications(query: { limit: number; unread: boolean; after?: string }): Promise<RelayResult> {
  const settings = outgoingSettings();
  if (settings.status !== 'connected') {
    return { status: settings.status, unreadCount: 0, items: [] };
  }
  try {
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.unread) params.set('unread', '1');
    if (query.after) params.set('after', eventId(query.after));
    const payload = await remoteRequest(`?${params.toString()}`, 'GET');
    if (!payload || typeof payload !== 'object') throw new Error('invalid_relay_payload');
    const result = payload as Record<string, unknown>;
    if (!Array.isArray(result.items) || result.items.length > query.limit ||
        !Number.isSafeInteger(result.unreadCount) || Number(result.unreadCount) < 0 ||
        !result.items.every(validRemoteNotice)) throw new Error('invalid_relay_payload');
    const ids = new Set<string>();
    const items: OrderNotice[] = result.items.map(row => {
      const source = row as OrderNotice;
      if (ids.has(source.id)) throw new Error('duplicate_relay_event');
      ids.add(source.id);
      return { id: `vps:${source.id}`, orderId: source.orderId, eventType: 'order_placed',
        createdAt: source.createdAt, acknowledgedAt: source.acknowledgedAt,
        orderStatus: source.orderStatus, source: 'vps' };
    });
    return { status: 'connected', unreadCount: result.unreadCount as number, items };
  } catch {
    noteRelayFailure();
    return { status: 'unavailable', unreadCount: 0, items: [] };
  }
}

export async function acknowledgeVpsNotification(id: string) {
  try {
    const payload = await remoteRequest(`/${id}/ack`, 'POST');
    if (!payload || typeof payload !== 'object') throw new Error('invalid_ack_payload');
    const result = payload as Record<string, unknown>;
    if (result.id !== id || typeof result.acknowledgedAt !== 'string' ||
        !Number.isFinite(Date.parse(result.acknowledgedAt))) throw new Error('invalid_ack_payload');
    return { id: `vps:${id}`, acknowledgedAt: result.acknowledgedAt };
  } catch {
    noteRelayFailure();
    // Do not mark locally acknowledged: VPS remains the source of truth.
    throw new AdminError(503, 'Không xác nhận được thông báo trên VPS. Vui lòng thử lại.');
  }
}
