import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from './db/pool.js';
import { getPricingPolicy, toVnd, type PricingPolicy } from './pricing.js';
import { amazonQuotesEnabled } from './config.js';
import { AMAZON_QUOTE_ACCESS_LOCK, amazonQuoteGate, amazonQuotePauseStatus,
  recordAmazonQuotePause, completeAmazonQuoteReentry } from './ingestion/source-access.js';
import { amazonAsin, quoteQuantity, readPublicOffer, addDeliveryDays, QuoteError, uuid, type PublicOffer } from './amazon-quote-source.js';
import { translateAmazonPreview, type AmazonVietnameseText } from './amazon-translate.js';

export type AmazonQuote = PublicOffer & {
  id: string; observedAt: string; expiresAt: string; unitPriceVnd: number; lineTotalVnd: number;
  pricingPolicy: PricingPolicy; deliveryDays: number; vietnamDelivery: ReturnType<typeof addDeliveryDays>;
  shippingEstimatedVnd: null; shippingDueLater: true; deliveryDestinationVerified: false;
  translated?: AmazonVietnameseText;
};
export async function getQuoteSettings(client: Pick<PoolClient, 'query'> = db) {
  const result = await client.query('SELECT version,delivery_days AS "deliveryDays" FROM amazon_quote_settings WHERE id=1');
  if (!result.rows[0]) throw new QuoteError('quote_schema_unavailable', 503);
  return result.rows[0] as { version: number; deliveryDays: number };
}
export function buildQuote(offer: PublicOffer, policy: PricingPolicy, deliveryDays: number, now = new Date()): AmazonQuote {
  const unitPriceVnd = toVnd(offer.priceJpy, policy);
  if (!Number.isSafeInteger(unitPriceVnd) || unitPriceVnd <= 0 || !Number.isSafeInteger(unitPriceVnd * offer.quantity)) throw new QuoteError('invalid_quote_price');
  return { ...offer, id: randomUUID(), observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString(),
    pricingPolicy: policy, unitPriceVnd, lineTotalVnd: unitPriceVnd * offer.quantity, deliveryDays,
    vietnamDelivery: addDeliveryDays(offer.amazonDelivery, deliveryDays), shippingEstimatedVnd: null,
    shippingDueLater: true, deliveryDestinationVerified: false };
}
export async function quoteRateLimit(ip: string) {
  const bucket = createHash('sha256').update(ip).digest('hex');
  // Cross-process limit; request.ip is the socket peer (Fastify trustProxy stays off).
  for (const [key, max] of [[bucket, 6], ['global', 30]] as const) {
    const result = await db.query(`INSERT INTO amazon_quote_rate_limits(bucket,window_start,attempts) VALUES($1,now(),1)
      ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN amazon_quote_rate_limits.window_start < now()-interval '1 minute' THEN 1 ELSE amazon_quote_rate_limits.attempts+1 END,
        window_start=CASE WHEN amazon_quote_rate_limits.window_start < now()-interval '1 minute' THEN now() ELSE amazon_quote_rate_limits.window_start END
      RETURNING attempts`, [key]);
    if (result.rows[0].attempts > max) throw new QuoteError('quote_rate_limited', 429);
  }
  await db.query("DELETE FROM amazon_quote_rate_limits WHERE window_start < now()-interval '1 day'");
}
export async function createAmazonQuote(input: unknown, quantity: unknown = 1): Promise<AmazonQuote> {
  const asin = amazonAsin(input), count = quoteQuantity(quantity);
  if (!amazonQuotesEnabled()) throw new QuoteError('amazon_quotes_disabled', 503);
  const client = await db.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked', [AMAZON_QUOTE_ACCESS_LOCK])).rows[0].locked;
    if (!locked) throw new QuoteError('amazon_busy', 503);
    if (!await amazonQuoteGate(client)) {
      const pause = await amazonQuotePauseStatus(client);
      throw new QuoteError('amazon_cooldown', 503, undefined, pause?.retryAfterAt ?? undefined);
    }
    const policy = await getPricingPolicy(client), settings = await getQuoteSettings(client);
    let offer: PublicOffer;
    // Start validity before I/O; network latency must never extend an observation.
    const observedAt = new Date();
    try { offer = await readPublicOffer(asin, count); }
    catch (error) {
      if (error instanceof QuoteError && ['amazon_blocked', 'amazon_rate_limited'].includes(error.code)) {
        await recordAmazonQuotePause(client, error.code, error.retryAfterAt);
        const pause = await amazonQuotePauseStatus(client);
        throw new QuoteError(error.code, error.status, error.details, pause?.retryAfterAt ?? undefined);
      }
      // Verified source HTML without a purchasable offer is not an access denial.
      if (error instanceof QuoteError && error.code === 'offer_not_verified' &&
          error.details && typeof error.details === 'object' && 'preview' in error.details) {
        await completeAmazonQuoteReentry(client);
        const preview = (error.details as { preview?: unknown }).preview;
        // A verified product identity can support a request for a human quote,
        // but never a locked-price purchase quote. Store server-side evidence
        // so a client cannot invent product facts at checkout.
        if (preview && typeof preview === 'object') {
          const fact = preview as { asin?: unknown; title?: unknown; sourceUrl?: unknown; observedAt?: unknown; priceJpy?: unknown };
          const time = typeof fact.observedAt === 'string' ? Date.parse(fact.observedAt) : NaN;
          if (fact.asin === asin && fact.sourceUrl === `https://www.amazon.co.jp/dp/${asin}` &&
              typeof fact.title === 'string' && fact.title.trim().length > 0 && fact.title.length <= 1000 &&
              Number.isSafeInteger(fact.priceJpy) && Number(fact.priceJpy) > 0 &&
              Number.isFinite(time) && Math.abs(Date.now() - time) < 60000) {
            const requestId = randomUUID();
            const expiresAt = new Date(time + 900000).toISOString();
            await client.query('INSERT INTO amazon_quotes(id,snapshot,observed_at,expires_at) VALUES($1,$2,$3,$4)',
              [requestId, JSON.stringify({ kind: 'purchase_request_preview', preview, quantity: count }), fact.observedAt, expiresAt]);
            const estimatedPriceVnd = toVnd(Number(fact.priceJpy), policy);
            const translated = await translateAmazonPreview(preview as Parameters<typeof translateAmazonPreview>[0]);
            throw new QuoteError('offer_not_verified', 422, {
              preview: { ...preview, ...(Number.isSafeInteger(estimatedPriceVnd) && estimatedPriceVnd > 0
                ? { estimatedPriceVnd } : {}), ...(translated ? { translated } : {}) },
              requestId, expiresAt,
            });
          }
        }
      }
      if (error instanceof QuoteError) throw error;
      throw new QuoteError('amazon_unavailable', 503);
    }
    await completeAmazonQuoteReentry(client);
    const quote = buildQuote(offer, policy, settings.deliveryDays, observedAt);
    await client.query('INSERT INTO amazon_quotes(id,snapshot,observed_at,expires_at) VALUES($1,$2,$3,$4)',
      [quote.id, JSON.stringify(quote), quote.observedAt, quote.expiresAt]);
    return { ...quote, translated: await translateAmazonPreview({
      title: quote.title, display: quote.display,
    }) };
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock($1)', [AMAZON_QUOTE_ACCESS_LOCK]); }
    finally { client.release(); }
  }
}
export type QuoteCartLine = { quoteId: string; confirmed: true; acknowledgeMissingEta?: true };
export function validateQuoteCart(value: unknown): QuoteCartLine[] {
  if (!Array.isArray(value) || value.length > 50 || value.some(v => !v || typeof v.quoteId !== 'string' || !uuid.test(v.quoteId) || v.confirmed !== true)) throw new QuoteError('invalid_quote_items', 400);
  if (new Set(value.map(v => v.quoteId)).size !== value.length) throw new QuoteError('duplicate_quote', 400);
  return value;
}
export async function refreshAmazonQuote(id: string) {
  if (!uuid.test(id)) throw new QuoteError('invalid_quote_id', 400);
  const found = (await db.query('SELECT snapshot,order_id FROM amazon_quotes WHERE id=$1', [id])).rows[0];
  if (!found) throw new QuoteError('quote_not_found', 404);
  if (found.snapshot?.kind === 'purchase_request_preview') throw new QuoteError('quote_not_found', 404);
  if (found.order_id) throw new QuoteError('quote_already_ordered', 409);
  const old = found.snapshot as AmazonQuote;
  const quote = await createAmazonQuote(old.asin, old.quantity);
  // A concurrent successful checkout must not turn its consumed quote into a new offer.
  const stillAvailable = await db.query('SELECT 1 FROM amazon_quotes WHERE id=$1 AND order_id IS NULL', [id]);
  if (!stillAvailable.rowCount) throw new QuoteError('quote_already_ordered', 409);
  return { quote, changed: quoteTerms(old) !== quoteTerms(quote), requiresConfirmation: true };
}
// Fixed field order: PostgreSQL jsonb does not preserve object key order.
function quoteTerms(q: AmazonQuote) {
  return JSON.stringify([q.asin, q.sourceUrl, q.title, q.variant, q.seller, q.offerId, q.quantity, q.priceJpy,
    q.unitPriceVnd, q.lineTotalVnd, q.imageUrl, q.purchaseType, q.shippingType, q.freeJapanShipping, q.shippingEvidence,
    q.amazonDelivery?.start, q.amazonDelivery?.end, q.deliveryDays, q.vietnamDelivery?.start, q.vietnamDelivery?.end,
    q.pricingPolicy.fxJpyToVnd, q.pricingPolicy.serviceFeePercent]);
}
export async function loadCheckoutQuotes(client: PoolClient, items: QuoteCartLine[]): Promise<AmazonQuote[]> {
  if (!items.length) return [];
  const result = await client.query(`SELECT id,snapshot,order_id,expires_at>clock_timestamp() AS valid
    FROM amazon_quotes WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [items.map(x => x.quoteId)]);
  if (result.rows.length !== items.length) throw new QuoteError('quote_not_found', 404);
  return result.rows.map(row => {
    // This table also holds contact-only Amazon previews. Their IDs can never
    // be used as confirmed merchandise quotes, even when still unexpired.
    if (row.snapshot?.kind === 'purchase_request_preview') throw new QuoteError('quote_not_found', 404);
    if (row.order_id) throw new QuoteError('quote_already_ordered', 409);
    if (!row.valid) throw new QuoteError('quote_expired', 409, { quoteId: row.id });
    const quote = row.snapshot as AmazonQuote;
    if (!quote.amazonDelivery && items.find(x => x.quoteId === row.id)?.acknowledgeMissingEta !== true) throw new QuoteError('missing_eta_acknowledgement');
    return quote;
  });
}
