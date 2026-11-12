import { createHash, randomUUID } from 'node:crypto';
import { db } from './db/pool.js';
import { config } from './config.js';
import { getPricingPolicy } from './pricing.js';
import { QuoteError, uuid, type AmazonProductPreview } from './amazon-quote-source.js';

type Customer = { name: string; phone: string; email?: string; address: string };
type SavedRequest = { kind: 'purchase_request_preview'; preview: AmazonProductPreview; quantity: number };

// No quote means no committed merchandise price or delivery fee. This records
// a contact request, not a priced purchase or an authorization to charge money.
export async function createAmazonPurchaseRequest(value: unknown) {
  if (config.publicReadOnly) throw new QuoteError('checkout_disabled', 404);
  const body = value as { requestId?: unknown; checkoutKey?: unknown; customer?: Customer; confirmed?: unknown; quantity?: unknown } | null;
  if (!body || typeof body.requestId !== 'string' || !uuid.test(body.requestId) ||
      typeof body.checkoutKey !== 'string' || !uuid.test(body.checkoutKey) ||
      body.confirmed !== true ||
      (body.quantity !== undefined && (!Number.isInteger(body.quantity) ||
        Number(body.quantity) < 1 || Number(body.quantity) > 99))) throw new QuoteError('invalid_purchase_request', 400);
  const c = body.customer;
  if (!c || typeof c !== 'object' ||
      [c.name, c.phone, c.address].some(v => typeof v !== 'string' || !v.trim()) ||
      c.name.length > 200 || c.address.length > 2000 ||
      !/^\+?[0-9.()\s-]{8,20}$/.test(c.phone) ||
      (c.email !== undefined && c.email !== '' &&
        (typeof c.email !== 'string' || c.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)))) {
    throw new QuoteError('invalid_customer', 422);
  }
  const customer = { name: c.name.trim(), phone: c.phone.trim(),
    email: c.email?.trim() || null, address: c.address.trim() };
  const fingerprint = createHash('sha256').update(JSON.stringify({
    requestId: body.requestId, customer, quantity: body.quantity ?? null
  })).digest('hex');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT snapshot,order_id,expires_at>clock_timestamp() AS valid FROM amazon_quotes WHERE id=$1 FOR UPDATE',
      [body.requestId]);
    const row = found.rows[0] as { snapshot: SavedRequest; order_id: string | null; valid: boolean } | undefined;
    if (!row || row.snapshot?.kind !== 'purchase_request_preview') throw new QuoteError('request_not_found', 404);
    if (row.order_id) {
      const old = await client.query(
        'SELECT id FROM orders WHERE id=$1 AND checkout_key=$2 AND checkout_fingerprint=$3 AND status=$4',
        [row.order_id, body.checkoutKey, fingerprint, 'purchase_request']);
      if (!old.rowCount) throw new QuoteError('request_already_submitted', 409);
      await client.query('COMMIT');
      return { requestId: body.requestId, orderId: row.order_id, status: 'already_submitted',
        priceConfirmed: false, shippingConfirmed: false, payableNowVnd: 0 };
    }
    if (!row.valid) throw new QuoteError('request_expired', 409);
    const { preview, quantity: originalQuantity } = row.snapshot;
    const quantity = body.quantity === undefined ? originalQuantity : Number(body.quantity);
    if (!preview || !/^[A-Z0-9]{10}$/.test(preview.asin) ||
        preview.sourceUrl !== `https://www.amazon.co.jp/dp/${preview.asin}` ||
        !preview.title || preview.title.length > 1000 ||
        !Number.isSafeInteger(preview.priceJpy) || Number(preview.priceJpy) <= 0 ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 99 ||
        !Number.isFinite(Date.parse(preview.observedAt))) throw new QuoteError('invalid_purchase_request', 400);
    const policy = await getPricingPolicy(client);
    const orderId = randomUUID();
    await client.query(
      `INSERT INTO orders(id,customer_name,customer_phone,customer_email,customer_address,
         fx_jpy_to_vnd,service_fee_percent,merchandise_vnd,estimated_shipping_vnd,
         pricing_policy_version,status,payment_status,payment_method,checkout_key,checkout_fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,'purchase_request','unpaid','manual',$9,$10)`,
      [orderId, customer.name, customer.phone, customer.email, customer.address,
        policy.fxJpyToVnd, policy.serviceFeePercent, policy.version, body.checkoutKey, fingerprint]);
    // The observed Amazon amount is source evidence only. Unit price 0 is a
    // schema placeholder, NEVER a free item; the explicit status blocks payment.
    await client.query(
      `INSERT INTO order_items(order_id,asin,name,quantity,price_jpy,unit_price_vnd,observed_at,quote_snapshot)
       VALUES($1,$2,$3,$4,$5,0,$6,$7)`,
      [orderId, preview.asin, preview.title, quantity, preview.priceJpy,
        preview.observedAt, JSON.stringify({ kind: 'purchase_request', id: body.requestId,
          sourceUrl: preview.sourceUrl, observedPriceJpy: preview.priceJpy, observedAt: preview.observedAt,
          seller: null, variant: null, priceConfirmed: false, shippingConfirmed: false })]);
    await client.query('UPDATE amazon_quotes SET order_id=$1 WHERE id=$2 AND order_id IS NULL', [orderId, body.requestId]);
    await client.query(
      `INSERT INTO order_notification_outbox(order_id,event_type,recipient,channel)
       VALUES($1,'order_placed','owner','admin') ON CONFLICT DO NOTHING`, [orderId]);
    await client.query('COMMIT');
    return { requestId: body.requestId, orderId, status: 'purchase_request',
      priceConfirmed: false, shippingConfirmed: false, payableNowVnd: 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
