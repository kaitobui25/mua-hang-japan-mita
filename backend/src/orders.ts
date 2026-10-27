import { randomUUID } from 'node:crypto';
import { db } from './db/pool.js';
import { DbProduct, publicProduct, canCheckoutProduct } from './catalog.js';
import { getPricingPolicy, toVnd } from './pricing.js';

type CartLine = { asin: string; quantity: number };
type Customer = { name: string; phone: string; email?: string; address: string };

export class CheckoutError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function createSimulationOrder(body: unknown) {
  if (!body || typeof body !== 'object') throw new CheckoutError('invalid_payload', 'Thiếu dữ liệu đặt hàng');
  const request = body as { items?: CartLine[]; customer?: Customer };
  const c = request.customer;
  if (!c || [c.name, c.phone, c.address].some(v => typeof v !== 'string' || !v.trim()) ||
    c.name.length > 200 || c.address.length > 2000 ||
    !/^\+?[0-9.()\s-]{8,20}$/.test(c.phone) || (c.email !== undefined && c.email !== '' &&
      (typeof c.email !== 'string' || c.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)))) {
    throw new CheckoutError('invalid_customer', 'Vui lòng nhập tên, số điện thoại và địa chỉ hợp lệ');
  }
  const items = request.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50 || items.some(x => !x || typeof x.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(x.asin) || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 99)) {
    throw new CheckoutError('invalid_items', 'Giỏ hàng không hợp lệ');
  }
  const quantities = new Map<string, number>();
  for (const { asin, quantity } of items) quantities.set(asin, (quantities.get(asin) ?? 0) + quantity);
  if ([...quantities.values()].some(q => q > 99)) throw new CheckoutError('invalid_items', 'Số lượng vượt giới hạn');

  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    const policy = await getPricingPolicy(connection);
    const products = await connection.query<DbProduct & { shipping_estimate_vnd: number }>(
      `SELECT p.*, c.shipping_estimate_vnd FROM products p JOIN categories c ON c.slug = p.category_slug WHERE p.asin = ANY($1::text[]) FOR SHARE OF p`,
      [[...quantities.keys()]]
    );
    if (products.rows.length !== quantities.size) throw new CheckoutError('missing_item', 'Một hoặc nhiều sản phẩm không còn trong catalog');
    let subtotalVnd = 0;
    let shippingEstimatedVnd = 0;
    const lines = products.rows.map(p => {
      if (!canCheckoutProduct(p)) {
        throw new CheckoutError('price_stale', `Giá ${p.asin} chưa được xác minh trong 24 giờ; vui lòng cập nhật trước khi thanh toán`);
      }
      const quantity = quantities.get(p.asin)!;
      const unitPriceVnd = toVnd(p.price_jpy!, policy);
      subtotalVnd += unitPriceVnd * quantity;
      shippingEstimatedVnd += p.shipping_estimate_vnd * quantity;
      if (!Number.isSafeInteger(subtotalVnd) || !Number.isSafeInteger(shippingEstimatedVnd)) throw new CheckoutError('invalid_price', 'Giá trị đơn vượt giới hạn an toàn.');
      return { ...publicProduct(p, policy), quantity, unitPriceVnd, lineTotalVnd: unitPriceVnd * quantity, observedAt: p.price_observed_at! };
    });
    const orderId = randomUUID();
    await connection.query(
      `INSERT INTO orders(id,customer_name,customer_phone,customer_email,customer_address,fx_jpy_to_vnd,service_fee_percent,merchandise_vnd,estimated_shipping_vnd,pricing_policy_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [orderId, c.name.trim(), c.phone.trim(), c.email?.trim() || null, c.address.trim(), policy.fxJpyToVnd, policy.serviceFeePercent, subtotalVnd, shippingEstimatedVnd, policy.version]
    );
    for (const line of lines) {
      await connection.query('INSERT INTO order_items(order_id,asin,name,quantity,price_jpy,unit_price_vnd,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [orderId, line.asin, line.name, line.quantity, line.priceJpy, line.unitPriceVnd, line.observedAt]);
    }
    await connection.query('COMMIT');
    return { orderId, status: 'simulation_created', lines, subtotalVnd, payableNowVnd: subtotalVnd, shippingEstimatedVnd, currency: 'VND', paymentMode: 'simulation', shippingDueLater: true, ...policy };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
