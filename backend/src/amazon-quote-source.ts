import { load } from 'cheerio';
import { config } from './config.js';
import { normalizeAmazonInput } from './ingestion/detail.js';

export class QuoteError extends Error {
  constructor(public code: string, public status = 422, public details?: unknown, public retryAfterAt?: string) { super(code); }
}
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function amazonAsin(input: unknown): string {
  try { return normalizeAmazonInput(input); }
  catch { throw new QuoteError('invalid_amazon_input', 400); }
}
export function quoteQuantity(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 99) throw new QuoteError('invalid_quantity', 400);
  return Number(value);
}
export type DateRange = { start: string; end: string };
export type PublicOffer = {
  asin: string; sourceUrl: string; title: string; variant: string; seller: string; offerId: string;
  quantity: number; priceJpy: number; imageUrl: string | null;
  purchaseType: 'one_time'; shippingType: 'standard'; freeJapanShipping: true;
  shippingEvidence: string; amazonDelivery: DateRange | null;
};
// Only the selected offer's explicit *standard, unconditional and free* evidence qualifies.
// Do not infer free standard shipping from generic free-delivery marketing or thresholds.
// The remainder may contain only unambiguous date tokens/delimiters or known relative dates
// (relative dates still become unknown ETA). All other shipping prose fails closed.
const unconditionalStandardFree = /^(?:通常配送\s*無料|FREE\s+Standard\s+Delivery)(?:\s*(?:(?:(?:\d{4}年)?\d{1,2}月)?\d{1,2}日|から|まで|～|〜|[-–]|本日|明日|today|tomorrow))*$/i;
export function calendarDate(value: string): boolean {
  return /^\d{4}-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDeliveryDays(range: DateRange | null, days: number): DateRange | null {
  if (!range) return null;
  const add = (value: string) => new Date(Date.parse(value) + days * 86400000).toISOString().slice(0, 10);
  return { start: add(range.start), end: add(range.end) };
}

// Deliberately narrow: never use a generic page price, Prime block or alternate seller.
// Unknown markup is unavailable, not permission to guess an offer.
export function parsePublicOffer(html: string, asin: string, quantity: number, observedAt = new Date()): PublicOffer {
  if (/captcha|validateCaptcha|ロボットではない/i.test(html)) throw new QuoteError('amazon_blocked', 503);
  const $ = load(html);
  const box = $('#desktop_buybox');
  const oneTime = box.find('#newAccordionRow');
  const offer = oneTime.length === 1 ? oneTime : box;
  const selectedAsin = $('#ASIN').attr('value');
  const title = $('#productTitle').text().trim();
  const offerId = offer.find('input[name="offeringID.1"]').attr('value');
  const seller = offer.find('#sellerProfileTriggerId').text().trim() || offer.find('#merchant-info').text().trim();
  const priceText = offer.find('#price_inside_buybox, #newBuyBoxPrice, .priceToPay .a-offscreen').map((_, el) => $(el).text().trim()).get();
  const prices = [...new Set(priceText)];
  const price = prices.length === 1 && prices[0].match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.00)?$/);
  const priceJpy = price ? Number(price[1].replaceAll(',', '')) : 0;
  const shipping = box.find('#mir-layout-DELIVERY_BLOCK-slot #mir-layout-DELIVERY_BLOCK').length
    ? box.find('#mir-layout-DELIVERY_BLOCK-slot #mir-layout-DELIVERY_BLOCK') : box.find('#mir-layout-DELIVERY_BLOCK-slot');
  const shippingEvidence = shipping.text().replace(/\s+/g, ' ').trim();
  const availability = box.find('#availability').text().trim();
  const maxQuantity = Math.max(...box.find('select[name="quantity"] option').map((_, el) => Number($(el).attr('value'))).get(), 0);
  const selectedQuantity = Number(box.find('select[name="quantity"] option[selected]').first().attr('value') ?? box.find('select[name="quantity"] option').first().attr('value'));
  const variant = $('#twister .selection').map((_, el) => $(el).text().trim()).get().filter(Boolean).join(' / ');
  if (box.length !== 1 || oneTime.length !== 1 || selectedAsin !== asin || !title || title.length > 1000 || !offerId || offerId.length > 2048 || !seller || seller.length > 1000 || variant.length > 2000 || shippingEvidence.length > 4000 ||
      offer.find('input[name="offeringID.1"]').length !== 1 ||
      (oneTime.length > 0 && oneTime.find('input[type="radio"]:checked').length !== 1) ||
      !Number.isSafeInteger(priceJpy) || priceJpy <= 0 || priceJpy > 100000000 ||
      !/在庫あり|in stock/i.test(availability) || /not in stock|out of stock|在庫なし/i.test(availability) || quantity > maxQuantity || selectedQuantity !== quantity ||
      ($('#twister').length > 0 && !variant) ||
      /subscribe\s*&\s*save|定期おトク便|Prime exclusive|プライム会員限定/i.test(offer.text()) ||
      !unconditionalStandardFree.test(shippingEvidence) ||
      /Prime|プライム|以上|初回|初めて|条件|coupon|クーポン|over |first order|fastest|最短|eligible|qualifying|minimum|when|with |spend|会員|対象|購入|注文|お急ぎ|速達|定期|subscribe|同時|合計|合わせ|まとめ/i.test(shippingEvidence)) {
    throw new QuoteError('offer_not_verified');
  }
  // Explicit dates only; relative/ambiguous text remains unknown. Preserve ranges.
  const dates = [...shippingEvidence.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g)].map(m => {
    const year = m[1] ? Number(m[1]) : Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(observedAt));
    return `${year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(observedAt);
  const ambiguousDate = /\d{1,2}日|明日|本日|tomorrow|today/i.test(shippingEvidence.replace(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g, ''));
  const amazonDelivery = !ambiguousDate && dates.length > 0 && dates.length <= 2 && dates.every(d => calendarDate(d) && d >= today) && dates[0] <= dates[dates.length - 1]
    ? { start: dates[0], end: dates[dates.length - 1] } : null;
  const rawImage = $('#landingImage').attr('src');
  const imageUrl = rawImage && /^https:\/\/(?:[a-z0-9-]+\.)*media-amazon\.com\//.test(rawImage) ? rawImage : null;
  return { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, title, variant: variant || title, seller, offerId,
    quantity, priceJpy, imageUrl, purchaseType: 'one_time', shippingType: 'standard', freeJapanShipping: true,
    shippingEvidence, amazonDelivery };
}

export async function readPublicOffer(asin: string, quantity: number): Promise<PublicOffer> {
  const response = await fetch(`https://www.amazon.co.jp/dp/${asin}?quantity=${quantity}`, {
    redirect: 'error', signal: AbortSignal.timeout(config.amazonTimeoutMs),
    headers: { 'Accept-Language': 'ja-JP', Accept: 'text/html' }
  });
  if (response.status === 403 || response.status === 429) {
    const retry = response.headers.get('retry-after');
    const retryTime = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? '');
    const retryDate = new Date(retryTime);
    const retryAfterAt = Number.isFinite(retryDate.getTime()) ? retryDate.toISOString() : undefined;
    await response.body?.cancel();
    throw new QuoteError(response.status === 429 ? 'amazon_rate_limited' : 'amazon_blocked', 503, undefined, retryAfterAt);
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
    await response.body?.cancel(); throw new QuoteError('amazon_unavailable', 503);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new QuoteError('amazon_unavailable', 503);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 3000000) throw new QuoteError('amazon_response_too_large', 503);
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return parsePublicOffer(Buffer.concat(chunks).toString('utf8'), asin, quantity);
}
