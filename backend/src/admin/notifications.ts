import { db } from '../db/pool.js';
import { AdminError } from './data.js';

const maxId = BigInt('9223372036854775807');

function eventId(value: string) {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > maxId) {
    throw new AdminError(400, 'Mã thông báo không hợp lệ.');
  }
  return value;
}

/** Pollable owner-only Admin fallback; no external message is dispatched. */
export async function listOrderNotifications(query: Record<string, string | undefined>) {
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
      orderStatus: row.order_status
    })),
    unreadCount,
    externalPush: 'not_configured' as const
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

export async function acknowledgeOrderNotification(id: string) {
  const result = await db.query<{ id: string; acknowledged_at: Date }>(
    `UPDATE order_notification_outbox SET acknowledged_at=COALESCE(acknowledged_at,now())
      WHERE id=$1 AND recipient='owner' AND channel='admin'
      RETURNING id,acknowledged_at`, [eventId(id)]
  );
  if (!result.rows[0]) throw new AdminError(404, 'Không tìm thấy thông báo.');
  return { id: result.rows[0].id, acknowledgedAt: result.rows[0].acknowledged_at };
}
