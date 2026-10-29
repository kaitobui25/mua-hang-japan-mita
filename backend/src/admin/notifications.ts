import { db } from '../db/pool.js';
import { AdminError } from './data.js';
import { acknowledgeVpsNotification, fetchVpsNotifications, type OrderNotice } from '../order-alert-relay.js';

const maxId = BigInt('9223372036854775807');

export function eventId(value: string) {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > maxId) {
    throw new AdminError(400, 'Mã thông báo không hợp lệ.');
  }
  return value;
}

/** Only the local outbox; the VPS relay calls this without recursive fetching. */
export async function listLocalOrderNotifications(query: Record<string, string | undefined>) {
  const limit = Number(query.limit ?? '30');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (query.unread !== undefined && query.unread !== '1')) {
    throw new AdminError(400, 'Bộ lọc thông báo không hợp lệ.');
  }
  const afterId = query.after === undefined ? null : eventId(query.after);
  const unread = query.unread === '1';
  const rows = await db.query<{
    id: string;
    order_id: string;
    event_type: string;
    created_at: Date;
    acknowledged_at: Date | null;
    order_status: string;
  }>(
    `SELECT e.id,e.order_id,e.event_type,e.created_at,e.acknowledged_at,
      o.status AS order_status
      FROM order_notification_outbox e JOIN orders o ON o.id=e.order_id
      WHERE e.recipient='owner' AND e.channel='admin'
        AND o.status<>'simulation_created'
        AND ($1::bigint IS NULL OR e.id>$1)
        AND (NOT $2::boolean OR e.acknowledged_at IS NULL)
      ORDER BY e.id DESC LIMIT $3`,
    [afterId, unread, limit]
  );
  const unreadCount = await unreadOrderNotificationCount();
  return {
    items: rows.rows.map(row => ({
      id: row.id, orderId: row.order_id, eventType: row.event_type,
      createdAt: row.created_at, acknowledgedAt: row.acknowledged_at,
      orderStatus: row.order_status, source: 'local' as const
    })),
    unreadCount
  };
}

/** Owner session stays local; only this server uses the VPS bearer token. */
export async function listOrderNotifications(query: Record<string, string | undefined>) {
  const after = query.after;
  const afterRemote = after?.startsWith('vps:');
  if (afterRemote) eventId(after!.slice(4));
  const local = await listLocalOrderNotifications(afterRemote ? { ...query, after: undefined } : query);
  const remote = await fetchVpsNotifications({
    limit: Number(query.limit ?? '30'),
    unread: query.unread === '1',
    after: afterRemote ? after!.slice(4) : undefined
  });
  const items: OrderNotice[] = [...local.items, ...remote.items];
  const seen = new Set<string>();
  const deduplicated = items.filter(item => {
    if (seen.has(item.source + ':' + item.id)) return false;
    seen.add(item.source + ':' + item.id);
    return true;
  });
  deduplicated.sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return {
    items: deduplicated.slice(0, Number(query.limit ?? '30')),
    unreadCount: local.unreadCount + remote.unreadCount,
    externalPush: 'not_configured' as const,
    relayStatus: remote.status
  };
}

export async function unreadOrderNotificationCount() {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM order_notification_outbox e
      JOIN orders o ON o.id=e.order_id
      WHERE e.recipient='owner' AND e.channel='admin'
        AND o.status<>'simulation_created' AND e.acknowledged_at IS NULL`
  );
  return result.rows[0].count;
}

export async function acknowledgeLocalOrderNotification(id: string) {
  const result = await db.query<{ id: string; acknowledged_at: Date }>(
    `UPDATE order_notification_outbox SET acknowledged_at=COALESCE(acknowledged_at,now())
      WHERE id=$1 AND recipient='owner' AND channel='admin'
      RETURNING id,acknowledged_at`, [eventId(id)]
  );
  if (!result.rows[0]) throw new AdminError(404, 'Không tìm thấy thông báo.');
  return { id: result.rows[0].id, acknowledgedAt: result.rows[0].acknowledged_at };
}

export async function acknowledgeOrderNotification(id: string) {
  if (id.startsWith('vps:')) return acknowledgeVpsNotification(eventId(id.slice(4)));
  return acknowledgeLocalOrderNotification(id);
}
