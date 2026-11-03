import { load, type CheerioAPI } from 'cheerio';
import { config } from './config.js';
import { ScraplingSession, QuoteTransportError } from './ingestion/scrapling.js';
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
// Display only: never a quote, shipping promise or checkout capability.
export type AmazonProductPreview = {
  asin: string; sourceUrl: string; title: string; observedAt: string; priceJpy?: number;
};

function parseProductPreview($: CheerioAPI, asin: string, observedAt: Date): AmazonProductPreview | undefined {
  if (!/^[A-Z0-9]{10}$/.test(asin) || $('input[id="ASIN"]').length !== 1 ||
      $('[id="ASIN"]').length !== 1 || $('#ASIN').attr('value') !== asin || !Number.isFinite(observedAt.getTime())) return;
  const hidden = (element: ReturnType<CheerioAPI>) => element.add(element.parents()).toArray().some(el =>
    $(el).is('script, style, noscript, template, [hidden], [aria-hidden="true"], .aok-hidden, .a-hidden') ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test($(el).attr('style') ?? ''));
  const text = (element: ReturnType<CheerioAPI>) => {
    const copy = element.clone();
    copy.find('*').each((_, el) => { if (hidden($(el))) $(el).remove(); });
    return copy.text().replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const titleElement = $('[id="productTitle"]');
  if (titleElement.length !== 1 || hidden(titleElement)) return;
  const title = text(titleElement);
  if (!title || title.length > 1000) return;
  const preview: AmazonProductPreview = { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    title, observedAt: observedAt.toISOString() };
  const box = $('[id="desktop_buybox"]');
  const selected = box.find('input[type="radio"]:checked');
  // Modern accordion exposes its selected row with an active class rather than a radio.
  const active = box.find('[id^="newAccordionRow_"].a-accordion-active');
  const row = selected.length === 1 ? selected.closest('[id^="newAccordionRow_"]') :
    selected.length === 0 && active.length === 1 ? active : $();
  const selectedOffer = selected.length === 1
    ? !hidden(selected) && !selected.is('[disabled], [aria-disabled="true"]')
    : selected.length === 0 && active.length === 1;
  // No generic page price, hidden offer, subscription or alternate row fallback.
  if (box.length === 1 && selectedOffer && row.length === 1 &&
      row.parents('[id="desktop_buybox"]').length === 1 &&
      /^newAccordionRow_\d+$/.test(row.attr('id') ?? '') && !hidden(row) &&
      !/subscribe|定期|Prime exclusive|プライム会員限定/i.test(text(row))) {
    const prices = row.find('.priceToPay .a-offscreen, #corePrice_feature_div .a-offscreen')
      .filter((_, el) => !hidden($(el)));
    const values = prices.toArray().map(el => text($(el)));
    const price = values.length > 0 && new Set(values).size === 1 &&
      values[0].match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.00)?$/);
    const priceJpy = price ? Number(price[1].replaceAll(',', '')) : 0;
    if (Number.isSafeInteger(priceJpy) && priceJpy > 0 && priceJpy <= 100000000) preview.priceJpy = priceJpy;
  }
  return preview;
}
// Display-only source data. Permission is supplied by trusted backend code after
// source/rights review, never by a quote request or by the source HTML itself.
export type AmazonDisplay = {
  provenance: { asin: string; sourceUrl: string; observedAt: string; permissionReference: string };
  images?: string[]; brand?: string; description?: string; features?: string[];
  ingredients?: string; usage?: string; warnings?: string;
  specifications?: { name: string; value: string }[];
  rating?: number; reviewCount?: number;
  reviews?: { title?: string; body: string; rating?: number }[];
};
export type AmazonDisplayPermission = {
  reference: string;
  fields: readonly (keyof Omit<AmazonDisplay, 'provenance'>)[];
};
export type PublicOffer = {
  asin: string; sourceUrl: string; title: string; variant: string; seller: string; offerId: string;
  quantity: number; priceJpy: number; imageUrl: string | null;
  purchaseType: 'one_time'; shippingType: 'standard'; freeJapanShipping: true;
  shippingEvidence: string; amazonDelivery: DateRange | null;
  display?: AmazonDisplay;
};

function displayImage(value: string | undefined): string | undefined {
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        /^(?:[a-z0-9-]+\.)*media-amazon\.com$/.test(url.hostname) && url.pathname.startsWith('/images/I/')) return value;
  } catch { /* Optional malformed URLs are omitted. */ }
}
function sourceRating(value: string): number | undefined {
  const match = value.match(/^(?:5つ星のうち([0-5](?:\.\d{1,2})?)|([0-5](?:\.\d{1,2})?) out of 5 stars)$/i);
  const rating = match ? Number(match[1] ?? match[2]) : NaN;
  return rating > 0 && rating <= 5 ? rating : undefined;
}
function parsePublicDisplay($: CheerioAPI, asin: string, observedAt: Date, permission?: AmazonDisplayPermission): AmazonDisplay | undefined {
  if (!permission || !permission.reference.trim() || permission.reference.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(permission.reference) || !Number.isFinite(observedAt.getTime())) return;
  const allowed = new Set(permission.fields);
  const data: Omit<AmazonDisplay, 'provenance'> = {};
  const visible = (element: ReturnType<CheerioAPI>) => element.filter((_, el) =>
    !$(el).is('[hidden], [aria-hidden="true"]') && !$(el).parents('[hidden], [aria-hidden="true"]').length);
  // Extract text only; do not return HTML, executable content, hidden text or links.
  const text = (element: ReturnType<CheerioAPI>, max: number): string | undefined => {
    const copy = visible(element).clone();
    copy.find('script, style, noscript, template, [hidden], [aria-hidden="true"]').remove();
    copy.find('br').replaceWith(' ');
    copy.find('p, div, li, ul, ol, table, tr, th, td, h1, h2, h3, h4, h5, h6').prepend(' ').append(' ');
    const value = copy.text().replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, ' ').replace(/\s+/g, ' ').trim();
    return value && value.length <= max ? value : undefined;
  };
  const unique = <T>(values: T[], limit: number): T[] =>
    [...new Map(values.map(value => [JSON.stringify(value), value])).values()].slice(0, limit);
  if (allowed.has('images')) {
    // Only rendered selected-product images; never parse alternate ASIN script
    // payloads, recommendations or derive catalog/image URLs from an ASIN.
    const images = unique(visible($('#landingImage, #altImages img')).slice(0, 80).toArray()
      .map(el => displayImage($(el).attr('src'))).filter((v): v is string => !!v), 10);
    if (images.length) data.images = images;
  }
  if (allowed.has('brand')) data.brand = text($('#po-brand .po-break-word').first(), 500);
  if (allowed.has('description')) data.description = text($('#productDescription').first(), 12000);
  if (allowed.has('features')) {
    const features = unique($('#feature-bullets li .a-list-item').slice(0, 80).toArray()
      .map(el => text($(el), 2000)).filter((v): v is string => !!v), 20);
    if (features.length) data.features = features;
  }
  for (const [field, heading] of [
    ['ingredients', /^(?:原材料・成分|Ingredients)$/i],
    ['usage', /^(?:使用方法|Directions)$/i],
    ['warnings', /^(?:安全警告|Safety Information)$/i]
  ] as const) {
    if (!allowed.has(field)) continue;
    const sections = $('#important-information .content').slice(0, 40).toArray().filter(el =>
      heading.test(text($(el).find('h4').first(), 100) ?? ''));
    if (sections.length === 1) {
      const content = $(sections[0]).clone();
      content.find('h4').remove();
      data[field] = text(content, 4000);
    }
  }
  if (allowed.has('specifications')) {
    const specifications: NonNullable<AmazonDisplay['specifications']> = [];
    $('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr').slice(0, 80).each((_, el) => {
      const name = text($(el).children('th'), 500), value = text($(el).children('td'), 2000);
      if (name && value) specifications.push({ name, value });
    });
    if (specifications.length) data.specifications = unique(specifications, 40);
  }
  if (allowed.has('rating') && $('#acrPopover').length === 1) {
    data.rating = sourceRating(visible($('#acrPopover')).attr('title')?.trim() ?? '');
  }
  if (allowed.has('reviewCount') && $('#acrCustomerReviewText').length === 1) {
    const count = text($('#acrCustomerReviewText'), 100)?.match(/^(\d{1,3}(?:,\d{3})*|\d+)(?:個の評価|\s+(?:global\s+)?ratings?)$/i);
    const value = count ? Number(count[1].replaceAll(',', '')) : NaN;
    if (Number.isSafeInteger(value) && value >= 0 && value <= 1000000000) data.reviewCount = value;
  }
  if (allowed.has('reviews')) {
    const reviews: NonNullable<AmazonDisplay['reviews']> = [];
    $('#cm-cr-dp-review-list [data-hook="review"]').slice(0, 40).each((_, el) => {
      const review = $(el), body = text(review.find('[data-hook="review-body"]'), 4000);
      if (!body) return;
      const title = text(review.find('[data-hook="review-title"]'), 500);
      const rating = sourceRating(text(review.find('[data-hook="review-star-rating"]'), 100) ?? '');
      reviews.push({ ...(title ? { title } : {}), body, ...(rating !== undefined ? { rating } : {}) });
    });
    if (reviews.length) data.reviews = unique(reviews, 10);
  }
  // Omit absent keys even before JSON serialization and avoid empty UI cards.
  for (const key of Object.keys(data) as (keyof typeof data)[]) if (data[key] === undefined) delete data[key];
  if (!Object.keys(data).length) return;
  return { provenance: { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    observedAt: observedAt.toISOString(), permissionReference: permission.reference }, ...data };
}
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
export function parsePublicOffer(html: string, asin: string, quantity: number, observedAt = new Date(), displayPermission?: AmazonDisplayPermission): PublicOffer {
  if (/captcha|validateCaptcha|ロボットではない/i.test(html)) throw new QuoteError('amazon_blocked', 503);
  const $ = load(html);
  const box = $('#desktop_buybox');
  const modern = box.find('[id="newAccordionRow_0"]');
  const oneTime = modern.length ? modern : box.find('[id="newAccordionRow"]');
  const offer = oneTime;
  const hidden = (element: ReturnType<CheerioAPI>) => element.add(element.parents()).toArray().some(el =>
    $(el).is('script, style, noscript, template, [hidden], [aria-hidden="true"], .aok-hidden, .a-hidden') ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test($(el).attr('style') ?? ''));
  const radios = box.find('input[type="radio"]:checked');
  const rowRadios = oneTime.find('input[type="radio"]');
  const activeRows = box.find('.a-accordion-active');
  // Only the known one-time row may be active. A checked radio, when present,
  // must agree; never fall back to another row or to buybox-wide offer facts.
  const selectedModern = modern.length === 1 && box.find('[id="newAccordionRow"]').length === 0 &&
    activeRows.length === 1 && activeRows.is(oneTime) &&
    (rowRadios.length === 0 ? radios.length === 0 : rowRadios.length === 1 && radios.length === 1 &&
      rowRadios.is(radios) && !hidden(radios) && !radios.is('[disabled], [aria-disabled="true"]'));
  const hiddenOneTime = oneTime.add(oneTime.parents()).toArray().some(el =>
    $(el).is('[hidden], [aria-hidden="true"], .aok-hidden') ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test($(el).attr('style') ?? ''));
  const selectedAsin = $('#ASIN').attr('value');
  const title = $('#productTitle').text().trim();
  const offerIds = offer.find(modern.length ? 'input[name="offeringID.1"], input[id="offerListingID"]' : 'input[name="offeringID.1"]');
  const offerId = offerIds.attr('value');
  const sellers = offer.find('[id="sellerProfileTriggerId"]');
  const sellerElement = sellers.length ? sellers : offer.find('[id="merchant-info"]');
  const seller = sellerElement.text().trim();
  const priceElements = offer.find('#price_inside_buybox, #newBuyBoxPrice, .priceToPay .a-offscreen' +
    (modern.length ? ', #corePrice_feature_div .a-offscreen' : ''));
  const priceText = priceElements.map((_, el) => $(el).text().trim()).get();
  const prices = [...new Set(priceText)];
  const price = prices.length === 1 && prices[0].match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.00)?$/);
  const priceJpy = price ? Number(price[1].replaceAll(',', '')) : 0;
  // Conditions may be siblings of the nested delivery block; retain the entire slot.
  const scope = modern.length ? offer : box;
  const shipping = scope.find('[id="mir-layout-DELIVERY_BLOCK-slot"]');
  const shippingEvidence = shipping.text().replace(/\s+/g, ' ').trim();
  const availabilityElement = scope.find('[id="availability"]');
  const availability = availabilityElement.text().trim();
  const quantitySelect = scope.find('select[name="quantity"]');
  const options = quantitySelect.find('option');
  const selectedOption = options.filter('[selected]').length ? options.filter('[selected]').first() : options.first();
  const disabledQuantity = quantitySelect.is('[disabled], [aria-disabled="true"]') ||
    selectedOption.is('[disabled], [aria-disabled="true"]') || selectedOption.parents('fieldset[disabled], optgroup[disabled]').length > 0;
  const maxQuantity = Math.max(...options.filter((_, el) => !$(el).is('[disabled], [aria-disabled="true"]') &&
    !$(el).parents('optgroup[disabled]').length).map((_, el) => Number($(el).attr('value'))).get(), 0);
  const selectedQuantity = Number(selectedOption.attr('value'));
  const remainingStock = availability.match(/\bonly\s+(\d+)\s+left\b/i);
  const variant = $('#twister .selection').map((_, el) => $(el).text().trim()).get().filter(Boolean).join(' / ');
  if (box.length !== 1 || oneTime.length !== 1 || hiddenOneTime || selectedAsin !== asin || !title || title.length > 1000 || !offerId || offerId.length > 2048 || !seller || seller.length > 1000 || variant.length > 2000 || shippingEvidence.length > 4000 ||
      $('[id="desktop_buybox"]').length !== 1 || $('[id="ASIN"]').length !== 1 || !$('#ASIN').is('input') ||
      $('[id="productTitle"]').length !== 1 || hidden($('#productTitle')) ||
      offerIds.length !== 1 || sellerElement.length !== 1 ||
      (modern.length ? !selectedModern || hidden(oneTime) || oneTime.is('[disabled], [aria-disabled="true"]') ||
        [offerIds, sellerElement, priceElements, shipping, availabilityElement, quantitySelect, selectedOption].some(hidden) ||
        offerIds.is('[disabled], [aria-disabled="true"]') ||
        /subscribe|定期|Prime|プライム/i.test(offer.text()) ||
        shipping.length !== 1 || availabilityElement.length !== 1 || options.filter('[selected]').length > 1 ||
        oneTime.find('[id^="newAccordionRow_"], [id="subscribeAccordionRow"]').length > 0 :
        oneTime.find('input[type="radio"]:checked').length !== 1) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 99 ||
      !Number.isSafeInteger(priceJpy) || priceJpy <= 0 || priceJpy > 100000000 ||
      !/在庫あり|in stock/i.test(availability) || /not\s+(?:currently\s+)?in\s+stock|out of stock|在庫なし/i.test(availability) || quantitySelect.length !== 1 || disabledQuantity || quantity > maxQuantity || selectedQuantity !== quantity ||
      (remainingStock !== null && quantity > Number(remainingStock[1])) ||
      ($('#twister').length > 0 && !variant) ||
      /subscribe\s*&\s*save|定期おトク便|Prime exclusive|プライム会員限定/i.test(offer.text()) ||
      !unconditionalStandardFree.test(shippingEvidence) ||
      /Prime|プライム|以上|初回|初めて|条件|coupon|クーポン|over |first order|fastest|最短|eligible|qualifying|minimum|when|with |spend|会員|対象|購入|注文|お急ぎ|速達|定期|subscribe|同時|合計|合わせ|まとめ/i.test(shippingEvidence)) {
    const preview = parseProductPreview($, asin, observedAt);
    throw new QuoteError('offer_not_verified', 422, preview ? { preview } : undefined);
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
  const display = parsePublicDisplay($, asin, observedAt, displayPermission);
  return { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, title, variant: variant || title, seller, offerId,
    quantity, priceJpy, imageUrl, purchaseType: 'one_time', shippingType: 'standard', freeJapanShipping: true,
    shippingEvidence, amazonDelivery, ...(display ? { display } : {}) };
}

export async function readPublicOffer(asin: string, quantity: number, displayPermission?: AmazonDisplayPermission): Promise<PublicOffer> {
  if (typeof asin !== 'string' || asin.length !== 10 || !/^[A-Z0-9]{10}$/.test(asin)) throw new QuoteError('invalid_amazon_input', 400);
  quoteQuantity(quantity);
  const session = new ScraplingSession();
  try {
    const { html, observedAt } = await session.quote(asin, quantity, config.amazonTimeoutMs);
    return parsePublicOffer(html, asin, quantity, observedAt, displayPermission);
  } catch (error) {
    if (error instanceof QuoteError) throw error;
    if (error instanceof QuoteTransportError) throw new QuoteError(error.code, 503, undefined, error.retryAfterAt);
    throw new QuoteError('amazon_unavailable', 503);
  } finally { session.close(); }
}
