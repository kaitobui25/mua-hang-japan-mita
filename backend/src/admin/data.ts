import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import { getPricingPolicy, toVnd, validatePolicy, type PricingPolicy } from '../pricing.js';
import { publicVisibilitySql, publicProduct, type DbProduct } from '../catalog.js';
import { expectedSyncAt } from '../ingestion/schedule.js';

export class AdminError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function audit(client: PoolClient, actor: number, action: string, object: string, before: unknown, after: unknown) {
  await client.query('INSERT INTO admin_audit_events(actor_id,action,object_id,before_value,after_value) VALUES($1,$2,$3,$4,$5)', [actor, action, object, JSON.stringify(before), JSON.stringify(after)]);
}
export function pagination(query: Record<string, string | undefined>) {
  if (Object.values(query).some(value => value !== undefined && typeof value !== 'string')) throw new AdminError(400, 'Bộ lọc không hợp lệ.');
  const page = Number(query.page ?? 1), limit = Number(query.limit ?? 20);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (query.q?.length ?? 0) > 200) throw new AdminError(400, 'Bộ lọc hoặc phân trang không hợp lệ.');
  return { page, limit, offset: (page - 1) * limit };
}
export async function listProducts(q: Record<string, string | undefined>) {
  const { page, limit, offset } = pagination(q);
  if (q.visibility && !['visible', 'hidden'].includes(q.visibility)) throw new AdminError(400, 'Trạng thái không hợp lệ.');
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (q.q) { params.push(`%${q.q}%`); clauses.push(`(name ILIKE $${params.length} OR asin ILIKE $${params.length})`); }
  if (q.category) { params.push(q.category); clauses.push(`category_slug=$${params.length}`); }
  if (q.visibility) clauses.push(`admin_hidden_at IS ${q.visibility === 'visible' ? '' : 'NOT '}NULL`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const count = await db.query(`SELECT count(*)::int AS total FROM products ${where}`, params);
  const rows = await db.query<DbProduct>(`SELECT *, (SELECT NOT hide_local_test_only FROM catalog_settings WHERE id=1) AS owner_all_products_enabled FROM products ${where} ORDER BY last_seen_at DESC,asin LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
  const policy = await getPricingPolicy();
  return { items: rows.rows.map(p => ({ ...publicProduct(p, policy), hiddenAt: p.admin_hidden_at })), total: count.rows[0].total, page, limit };
}
export async function setVisibility(asin: string, hidden: boolean, actor: number) {
  return transaction(async client => {
    const old = await client.query('SELECT admin_hidden_at FROM products WHERE asin=$1 FOR UPDATE', [asin]);
    if (!old.rows[0]) throw new AdminError(404, 'Không tìm thấy ASIN.');
    const updated = await client.query('UPDATE products SET admin_hidden_at=CASE WHEN $2 THEN COALESCE(admin_hidden_at,now()) ELSE NULL END,updated_at=now() WHERE asin=$1 RETURNING admin_hidden_at', [asin, hidden]);
    await audit(client, actor, 'product.visibility', asin, old.rows[0], updated.rows[0]);
    return { asin, hiddenAt: updated.rows[0].admin_hidden_at };
  });
}
export async function savePolicy(policy: PricingPolicy, actor: number) {
  try { validatePolicy(policy); } catch (error) { throw new AdminError(400, (error as Error).message); }
  if (!Number.isInteger(policy.version) || policy.version < 1) throw new AdminError(400, 'Version không hợp lệ.');
  return transaction(async client => {
    await client.query('SELECT id FROM pricing_policy WHERE id=1 FOR UPDATE');
    const old = await getPricingPolicy(client);
    if (old.version !== policy.version) throw new AdminError(409, 'Cấu hình đã thay đổi. Tải lại trước khi lưu.');
    await client.query('UPDATE pricing_policy SET version=version+1,fx_jpy_to_vnd=$1,service_fee_percent=$2,updated_at=now() WHERE id=1', [policy.fxJpyToVnd, policy.serviceFeePercent]);
    const next = await getPricingPolicy(client);
    await audit(client, actor, 'pricing.changed', String(next.version), old, next);
    return { ...next, exampleVnd: toVnd(1000, next) };
  });
}
export async function getCatalogSettings(client: Pick<PoolClient, 'query'> = db) {
  const result = await client.query<{ version: number; hide_local_test_only: boolean }>('SELECT version,hide_local_test_only FROM catalog_settings WHERE id=1');
  if (!result.rows[0]) throw new Error('Run database migration before serving catalog settings');
  return { version: result.rows[0].version, hideLocalTestOnly: result.rows[0].hide_local_test_only };
}
export async function getTranslationSettings(client: Pick<PoolClient, 'query'> = db) {
  const result = await client.query<{ version: number; validate_translation_semantics: boolean }>(
    'SELECT version,validate_translation_semantics FROM translation_settings WHERE id=1');
  if (!result.rows[0]) throw new Error('Run database migration before serving translation settings');
  return {
    version: result.rows[0].version,
    validateTranslationSemantics: result.rows[0].validate_translation_semantics
  };
}

export async function saveTranslationSettings(
  value: { version: number; validateTranslationSemantics: boolean }, actor: number
) {
  if (!value || !Number.isSafeInteger(value.version) || value.version < 1 ||
      typeof value.validateTranslationSemantics !== 'boolean') {
    throw new AdminError(400, 'Cấu hình kiểm tra bản dịch không hợp lệ.');
  }
  return transaction(async client => {
    await client.query('SELECT id FROM translation_settings WHERE id=1 FOR UPDATE');
    const before = await getTranslationSettings(client);
    if (before.version !== value.version) throw new AdminError(409, 'Cấu hình đã thay đổi. Tải lại trước khi lưu.');
    await client.query('UPDATE translation_settings SET version=version+1, validate_translation_semantics=$1, updated_at=now() WHERE id=1',
      [value.validateTranslationSemantics]);
    const after = await getTranslationSettings(client);
    await audit(client, actor, 'translation.semantic_policy', String(after.version), before, after);
    return after;
  });
}
export async function saveCatalogSettings(value: { version: number; hideLocalTestOnly: boolean }, actor: number) {
  if (!value || !Number.isInteger(value.version) || value.version < 1 || typeof value.hideLocalTestOnly !== 'boolean') {
    throw new AdminError(400, 'Cấu hình hiển thị không hợp lệ.');
  }
  return transaction(async client => {
    await client.query('SELECT id FROM catalog_settings WHERE id=1 FOR UPDATE');
    const before = await getCatalogSettings(client);
    if (before.version !== value.version) throw new AdminError(409, 'Cấu hình đã thay đổi. Tải lại trước khi lưu.');
    await client.query('UPDATE catalog_settings SET version=version+1,hide_local_test_only=$1,updated_at=now() WHERE id=1', [value.hideLocalTestOnly]);
    const after = await getCatalogSettings(client);
    await audit(client, actor, 'catalog.visibility_policy', String(after.version), before, after);
    return after;
  });
}
export async function listOrders(q: Record<string, string | undefined>) {
  const { page, limit, offset } = pagination(q);
  const term = `%${q.q ?? ''}%`;
  const count = await db.query('SELECT count(*)::int AS total FROM orders WHERE id::text ILIKE $1 OR customer_phone ILIKE $1', [term]);
  const rows = await db.query(`SELECT o.id,o.created_at,o.customer_name,o.status,o.payment_status,o.merchandise_vnd,
    (SELECT count(*)::int FROM order_items i WHERE i.order_id=o.id) AS item_count
    FROM orders o WHERE o.id::text ILIKE $1 OR o.customer_phone ILIKE $1 ORDER BY o.created_at DESC,o.id LIMIT $2 OFFSET $3`, [term, limit, offset]);
  return { items: rows.rows, total: count.rows[0].total, page, limit };
}
export async function orderDetail(id: string) {
  const order = await db.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (!order.rows[0]) throw new AdminError(404, 'Không tìm thấy đơn mô phỏng.');
  const items = await db.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY asin', [id]);
  return { ...order.rows[0], items: items.rows };
}

/** Real order workflow; simulation records are immutable historical data. */
const orderNext: Record<string, string[]> = {
  pending_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['purchasing', 'cancelled'],
  purchasing: ['purchased', 'cancelled'],
  purchased: ['shipping'],
  shipping: ['completed'],
};

export async function updateOrder(id: string, change: { status?: string; paymentStatus?: string; shippingFinalVnd?: number }, actor: number) {
  if (!change || [change.status, change.paymentStatus, change.shippingFinalVnd].filter(x => x !== undefined).length !== 1) {
    throw new AdminError(400, 'Chọn một thay đổi trạng thái cho mỗi lần cập nhật.');
  }
  return transaction(async client => {
    const current = await client.query<{ status: string; payment_status: string; shipping_final_vnd: string | null; paid_at: Date | null }>(
      'SELECT status,payment_status,shipping_final_vnd,paid_at FROM orders WHERE id=$1 FOR UPDATE', [id]);
    const old = current.rows[0];
    if (!old) throw new AdminError(404, 'Không tìm thấy đơn hàng.');
    if (old.status === 'simulation_created') {
      throw new AdminError(409, 'Đơn mô phỏng lịch sử không được phép chỉnh sửa.');
    }
    if (change.status && !orderNext[old.status]?.includes(change.status)) {
      throw new AdminError(409, 'Không thể chuyển trạng thái đơn hàng theo thứ tự này.');
    }
    if (change.status === 'completed' && old.payment_status !== 'paid') {
      throw new AdminError(409, 'Cần ghi nhận thanh toán trước khi hoàn tất đơn.');
    }
    if (change.shippingFinalVnd !== undefined && (!Number.isSafeInteger(change.shippingFinalVnd) || change.shippingFinalVnd < 0 || change.shippingFinalVnd > 1000000000 || old.status === 'cancelled')) {
      throw new AdminError(400, 'Phí vận chuyển không hợp lệ hoặc đơn đã hủy.');
    }
    if (change.paymentStatus) {
      if (change.paymentStatus === 'paid' && (old.payment_status !== 'unpaid' || old.status === 'pending_confirmation' || old.status === 'cancelled')) {
        throw new AdminError(409, 'Chỉ ghi nhận thanh toán sau khi xác nhận đơn.');
      }
      if (change.paymentStatus === 'refunded' && old.payment_status !== 'paid') {
        throw new AdminError(409, 'Chỉ đánh dấu hoàn tiền sau khi đã ghi nhận thanh toán.');
      }
      if (!['paid', 'refunded'].includes(change.paymentStatus)) throw new AdminError(400, 'Trạng thái thanh toán không hợp lệ.');
    }
    const updated = await client.query<{ status: string; payment_status: string; shipping_final_vnd: string | null; paid_at: Date | null }>(
      `UPDATE orders SET status=COALESCE($2,status), payment_status=COALESCE($3,payment_status),
       shipping_final_vnd=COALESCE($4,shipping_final_vnd),
       paid_at=CASE WHEN $3='paid' THEN now() ELSE paid_at END
       WHERE id=$1 RETURNING status,payment_status,shipping_final_vnd,paid_at`, [id, change.status ?? null, change.paymentStatus ?? null, change.shippingFinalVnd ?? null]);
    await audit(client, actor, 'order.status', id, old, updated.rows[0]);
    return { id, ...updated.rows[0] };
  });
}
export async function overview() {
  const counts = await db.query(`SELECT
    (SELECT count(*)::int FROM orders WHERE status<>'simulation_created' AND created_at>=now()-interval '7 days') AS orders_7_days,
    (SELECT count(*)::int FROM products WHERE ${publicVisibilitySql}) AS visible_products`);
  const latest = await db.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
  const run = latest.rows[0] ?? null;
  const errors = run ? await db.query('SELECT id,category_slug,asin,adapter,state,message,created_at FROM sync_errors WHERE sync_run_id=$1 ORDER BY id DESC LIMIT 50', [run.id]) : { rows: [] };
  const expected = expectedSyncAt();
  const confirmed = await db.query('SELECT id FROM sync_runs WHERE started_at>=$1 AND finished_at IS NOT NULL LIMIT 1', [expected]);
  const cooldown = await db.query("SELECT reason,blocked_at,retry_after_at FROM source_access_blocks WHERE source='amazon.co.jp'");
  const unread = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM order_notification_outbox e
      JOIN orders o ON o.id=e.order_id
      WHERE e.recipient='owner' AND e.channel='admin'
        AND o.status<>'simulation_created' AND e.acknowledged_at IS NULL`);
  return { ...counts.rows[0], newOrderAlertCount: unread.rows[0].count,
    amazonCooldown: cooldown.rows[0] ?? null, latestSync: run, syncErrors: errors.rows,
    expectedSyncAt: expected, missingScheduledRun: !confirmed.rowCount,
    recentOrders: (await listOrders({ limit: '5' })).items };
}
