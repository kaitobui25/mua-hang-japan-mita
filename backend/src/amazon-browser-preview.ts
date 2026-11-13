import { createHash, randomUUID } from 'node:crypto';
import { db } from './db/pool.js';
import { getPricingPolicy, toVnd } from './pricing.js';
import { amazonAsin, QuoteError, type AmazonProductPreview } from './amazon-quote-source.js';
import { translateAmazonPreview } from './amazon-translate.js';

type Capture = { preview: AmazonProductPreview; quantity: number; translateToVietnamese: boolean };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function content(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return;
  return value.replace(/\s+/g, ' ').trim();
}

function amazonImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      /^(?:[a-z0-9-]+\.)*media-amazon\.com$/.test(url.hostname) && url.pathname.startsWith('/images/I/');
  } catch { return false; }
}

/** A browser capture is an UNTRUSTED customer's observation, never a verified Amazon offer. */
export function parseBrowserCapture(value: unknown, observedAt = new Date()): Capture {
  if (!object(value) || !object(value.page) ||
      !Number.isInteger(value.quantity ?? 1) || Number(value.quantity ?? 1) < 1 ||
      Number(value.quantity ?? 1) > 99 ||
      (value.translateToVietnamese !== undefined && typeof value.translateToVietnamese !== 'boolean')) {
    throw new QuoteError('invalid_browser_capture', 400);
  }
  const page = value.page;
  if (typeof page.url !== 'string' || page.url.length > 2048) throw new QuoteError('invalid_browser_capture', 400);
  let asin: string;
  try { asin = amazonAsin(page.url); }
  catch { throw new QuoteError('invalid_browser_capture', 400); }
  if (page.asin !== asin) throw new QuoteError('invalid_browser_capture', 400);
  const title = content(page.title, 1000);
  if (!title || !Number.isFinite(observedAt.getTime())) throw new QuoteError('invalid_browser_capture', 400);
  const preview: AmazonProductPreview = {
    asin, title, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    observedAt: observedAt.toISOString()
  };
  if (page.priceText !== undefined) {
    const price = content(page.priceText, 80);
    // Strict current-item yen amount only. A missing/ambiguous price is not inferred.
    const match = price?.match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.00)?$/);
    const amount = match ? Number(match[1].replaceAll(',', '')) : NaN;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) {
      throw new QuoteError('invalid_browser_capture', 400);
    }
    preview.priceJpy = amount;
  }
  const observed: NonNullable<AmazonProductPreview['observedDetails']> = {};
  const brand = content(page.brand, 500);
  if (page.brand !== undefined && !brand) throw new QuoteError('invalid_browser_capture', 400);
  if (brand) observed.brand = brand;
  if (page.seller !== undefined) {
    const seller = content(page.seller, 500);
    if (!seller) throw new QuoteError('invalid_browser_capture', 400);
    observed.specifications = [{ name: 'Người bán hiển thị (chưa xác minh)', value: seller }];
  }
  for (const [key, label, max] of [
    ['variantText', 'Phiên bản trên trang', 300],
    ['availabilityText', 'Tình trạng hàng trên trang (chưa xác minh)', 300]
  ] as const) {
    if (page[key] === undefined) continue;
    const text = content(page[key], max);
    if (!text) throw new QuoteError('invalid_browser_capture', 400);
    (observed.specifications ??= []).push({ name: label, value: text });
  }
  if (page.deliveryText !== undefined) {
    const delivery = content(page.deliveryText, 400);
    if (!delivery) throw new QuoteError('invalid_browser_capture', 400);
    preview.deliveryText = delivery;
  }
  if (page.images !== undefined) {
    if (!Array.isArray(page.images) || page.images.length > 10 ||
        page.images.some(item => !amazonImage(item))) throw new QuoteError('invalid_browser_capture', 400);
    observed.images = [...new Set(page.images)];
  }
  if (page.features !== undefined) {
    if (!Array.isArray(page.features) || page.features.length > 10) throw new QuoteError('invalid_browser_capture', 400);
    const features = page.features.map(item => content(item, 400));
    if (features.some(item => !item)) throw new QuoteError('invalid_browser_capture', 400);
    observed.features = features as string[];
  }
  if (Object.keys(observed).length) preview.observedDetails = observed;
  return { preview, quantity: Number(value.quantity ?? 1),
    translateToVietnamese: value.translateToVietnamese === true };
}

// Distinct from Amazon source quota/cooldown; this endpoint makes NO Amazon request.
export async function browserCaptureRateLimit(ip: string) {
  const buckets: readonly [string, number][] = [
    ['browser:' + createHash('sha256').update(ip).digest('hex'), 12],
    ['browser:global', 120]
  ];
  for (const [bucket, max] of buckets) {
    const result = await db.query(`INSERT INTO amazon_quote_rate_limits(bucket,window_start,attempts) VALUES($1,now(),1)
      ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN amazon_quote_rate_limits.window_start<now()-interval '1 minute' THEN 1 ELSE amazon_quote_rate_limits.attempts+1 END,
        window_start=CASE WHEN amazon_quote_rate_limits.window_start<now()-interval '1 minute' THEN now() ELSE amazon_quote_rate_limits.window_start END
      RETURNING attempts`, [bucket]);
    if (result.rows[0].attempts > max) throw new QuoteError('quote_rate_limited', 429);
  }
}

/** Return a temporary display & unpriced contact request; NEVER return an AmazonQuote or quoteId. */
export async function createAmazonBrowserPreview(value: unknown) {
  const { preview, quantity, translateToVietnamese } = parseBrowserCapture(value);
  const policy = await getPricingPolicy();
  const amount = preview.priceJpy === undefined ? undefined : toVnd(preview.priceJpy, policy);
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) {
    throw new QuoteError('invalid_browser_capture', 400);
  }
  // Even when no price is visible, the customer may request a manual quote.
  // No merchandise amount, payment or paid checkout is issued by this path.
  const requestId = randomUUID();
  const expiresAt = new Date(Date.parse(preview.observedAt) + 900000).toISOString();
  await db.query('INSERT INTO amazon_quotes(id,snapshot,observed_at,expires_at) VALUES($1,$2,$3,$4)',
    [requestId, JSON.stringify({ kind: 'browser_capture_preview', preview, quantity }),
      preview.observedAt, expiresAt]);
  // Translation sends selected text to a third-party provider. Never do so
  // unless the customer explicitly opted in on Mita after opening their capture.
  const translated = translateToVietnamese
    ? await translateAmazonPreview({ title: preview.title, observedDetails: preview.observedDetails })
    : undefined;
  return {
    source: 'user_browser' as const, priceConfirmed: false as const, checkoutAllowed: false as const,
    preview: { ...preview, captureSource: 'user_browser' as const,
      ...(amount !== undefined ? { estimatedPriceVnd: amount } : {}),
      ...(translated ? { translated } : {}) },
    requestId, expiresAt
  };
}
