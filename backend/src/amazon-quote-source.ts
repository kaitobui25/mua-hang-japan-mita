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
  observedDetails?: Omit<AmazonDisplay, 'provenance'>;
  deliveryText?: string; freeDelivery?: true;
  /** Date Amazon publicly advertises, not a Mita delivery guarantee. */
  advertisedJapanDeliveryDate?: string;
  advertisedDeliveryConditional?: boolean;
  display?: AmazonDisplay;
};

/** Only an explicit calendar date in the first visible delivery option qualifies.
 * Never derive an ETA from `明日`, fastest delivery or an unknown condition. */
export function advertisedAmazonDelivery(text: string, observedAt: Date):
  { date: string; conditional: boolean } | null {
  if (!Number.isFinite(observedAt.getTime()) || !text || text.length > 400) return null;
  const first = text.split(/または|\bor\b|最も早い配送|fastest delivery/i)[0];
  const match = first.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (!match) return null;
  const japanToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(observedAt);
  const year = Number(match[1] ?? japanToday.slice(0, 4));
  const month = match[2].padStart(2, '0'), day = match[3].padStart(2, '0');
  let date = `${year}-${month}-${day}`;
  if (!match[1] && date < japanToday) date = `${year + 1}-${month}-${day}`;
  if (!calendarDate(date) || date < japanToday ||
    Date.parse(date) - Date.parse(japanToday) > 45 * 86400000) return null;
  return { date, conditional: /初回|初めて|Prime|プライム|条件|以上|対象|first.order|会員/i.test(first) };
}

// Amazon can render the same hidden product identity in more than one form.
// Identical duplicates are safe; a conflicting/non-input ASIN is not.
function verifiedAsinInputs($: CheerioAPI, asin: string): boolean {
  const identities = $('[id="ASIN"]');
  return identities.length >= 1 && identities.length <= 4 && identities.toArray().every(element =>
    $(element).is('input') && $(element).attr('value') === asin);
}

function parseProductPreview($: CheerioAPI, asin: string, observedAt: Date, permission?: AmazonDisplayPermission): AmazonProductPreview | undefined {
  if (!/^[A-Z0-9]{10}$/.test(asin) || !verifiedAsinInputs($, asin) || !Number.isFinite(observedAt.getTime())) return;
  const hidden = (element: ReturnType<CheerioAPI>) => element.add(element.parents()).toArray().some(el =>
    $(el).is('script, style, noscript, template, [hidden], [aria-hidden="true"], .aok-hidden, .a-hidden') ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test($(el).attr('style') ?? ''));
  const text = (element: ReturnType<CheerioAPI>) => {
    const copy = element.clone();
    copy.find('*').each((_, el) => { if (hidden($(el))) $(el).remove(); });
    copy.find('br').replaceWith(' ');
    copy.find('p, div').prepend(' ').append(' ');
    return copy.text().replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  // Amazon can reuse this ID on a textless tracking input. Require exactly one
  // visible title with actual text, not exactly one DOM node carrying the ID.
  const titleElement = $('[id="productTitle"]').filter((_, el) =>
    !$(el).is('input, select, textarea') && !hidden($(el)) && !!$(el).text().trim());
  if (titleElement.length !== 1) return;
  const title = text(titleElement);
  if (!title || title.length > 1000) return;
  // Display evidence must belong to the requested product, not another ASIN in
  // a recommendation or a conflicting canonical page.
  const canonical = $('link[rel="canonical"]');
  if (canonical.length > 1) return;
  if (canonical.length === 1) {
    const href = canonical.attr('href');
    if (href) {
      try {
        const url = new URL(href);
        if (!['www.amazon.co.jp', 'amazon.co.jp'].includes(url.hostname) ||
            url.protocol !== 'https:' || !url.pathname.includes(`/dp/${asin}`)) return;
      } catch { return; }
    }
  }
  const preview: AmazonProductPreview = { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    title, observedAt: observedAt.toISOString() };
  const box = $('[id="desktop_buybox"]');
  // Only the primary product price. Never use list/strike prices, comparison
  // tables, sponsored products or another selected variant as a fallback.
  const currentPriceSelectors = [
    '#desktop_buybox #corePrice_feature_div .a-price .a-offscreen',
    '#desktop_buybox #corePrice_feature_div .a-offscreen',
    '#desktop_buybox #price_inside_buybox',
    '#desktop_buybox #newBuyBoxPrice',
    '#desktop_buybox .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePrice_feature_div .priceToPay .a-offscreen',
  ];
  const selectedOneTime = $('#desktop_buybox [id="newAccordionRow_0"].a-accordion-active');
  // Amazon can display a per-unit price beside the actual one-time total.
  // The explicit selected-row apex purchase amount takes precedence over
  // per-unit and subscription prices; never infer a price from the whole page.
  const apexPrices = selectedOneTime.length === 1
    ? selectedOneTime.find('.apex-pricetopay-value .a-offscreen')
      .filter((_, el) => !hidden($(el))).toArray().map(el => text($(el))).filter(Boolean)
    : [];
  const currentPrices = currentPriceSelectors.flatMap(selector => $(selector)
    .filter((_, el) => !hidden($(el))).toArray().map(el => text($(el))).filter(Boolean));
  const uniquePrices = [...new Set(apexPrices.length ? apexPrices : currentPrices)];
  const currentPrice = uniquePrices.length === 1 &&
    uniquePrices[0].match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.00)?$/);
  const observedAmount = currentPrice ? Number(currentPrice[1].replaceAll(',', '')) : 0;
  if (Number.isSafeInteger(observedAmount) && observedAmount > 0 && observedAmount <= 100000000) {
    preview.priceJpy = observedAmount;
  }
  // A source-page "free delivery" label is shown as observed. It is *not*
  // evidence of a standard, unconditional, checkout-eligible delivery offer.
  if (box.length === 1) {
    const blocks = box.find('[id="mir-layout-DELIVERY_BLOCK"]');
    const delivery = blocks.length === 1 ? blocks : box.find('[id="mir-layout-DELIVERY_BLOCK-slot"]');
    if (delivery.length === 1 && !hidden(delivery)) {
      const deliveryText = text(delivery).slice(0, 400);
      if (deliveryText) {
        preview.deliveryText = deliveryText;
        if (/無料配送|通常配送\s*無料|\bFREE\s+DELIVERY\b/i.test(deliveryText)) preview.freeDelivery = true;
        const advertised = advertisedAmazonDelivery(deliveryText, observedAt);
        if (advertised) {
          preview.advertisedJapanDeliveryDate = advertised.date;
          if (advertised.conditional) preview.advertisedDeliveryConditional = true;
        }
      }
    }
  }
  const observed = extractDisplayFields($, new Set<keyof Omit<AmazonDisplay, 'provenance'>>([
    'images', 'brand', 'description', 'features', 'ingredients', 'usage', 'warnings',
    'specifications', 'rating', 'reviewCount',
  ]));
  if (observed) preview.observedDetails = observed;
  const display = parsePublicDisplay($, asin, observedAt, permission);
  if (display) preview.display = display;
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
  purchaseType: 'one_time'; shippingType: 'standard' | 'unverified'; freeJapanShipping: boolean;
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
function extractDisplayFields($: CheerioAPI, allowed: ReadonlySet<keyof Omit<AmazonDisplay, 'provenance'>>): Omit<AmazonDisplay, 'provenance'> | undefined {
  const data: Omit<AmazonDisplay, 'provenance'> = {};
  const hidden = (element: ReturnType<CheerioAPI>) => element.add(element.parents()).toArray().some(el =>
    $(el).is('script, style, noscript, template, [hidden], [aria-hidden="true"], .aok-hidden, .a-hidden') ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test($(el).attr('style') ?? ''));
  const visible = (element: ReturnType<CheerioAPI>) => element.filter((_, el) => !hidden($(el)));
  // Extract text only; do not return HTML, executable content, hidden text or links.
  const text = (element: ReturnType<CheerioAPI>, max: number): string | undefined => {
    const copy = visible(element).clone();
    copy.find('*').each((_, el) => { if (hidden($(el))) $(el).remove(); });
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
      .map(el => displayImage($(el).attr('data-old-hires')) ?? displayImage($(el).attr('src')))
      .filter((v): v is string => !!v), 10);
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
  if (allowed.has('rating')) {
    const ratings = visible($('[id="acrPopover"]')).toArray()
      .map(el => sourceRating($(el).attr('title')?.trim() ?? '')).filter((value): value is number => value !== undefined);
    if (ratings.length && new Set(ratings).size === 1) data.rating = ratings[0];
  }
  if (allowed.has('reviewCount')) {
    const counts = visible($('[id="acrCustomerReviewText"]')).toArray().map(el =>
      text($(el), 100)?.match(/^\(?(\d{1,3}(?:,\d{3})*|\d+)\)?(?:個の評価|\s+(?:global\s+)?ratings?)?$/i))
      .filter((match): match is RegExpMatchArray => !!match).map(match => Number(match[1].replaceAll(',', '')));
    if (counts.length && new Set(counts).size === 1 && Number.isSafeInteger(counts[0]) &&
        counts[0] >= 0 && counts[0] <= 1000000000) data.reviewCount = counts[0];
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
  return data;
}
function parsePublicDisplay($: CheerioAPI, asin: string, observedAt: Date, permission?: AmazonDisplayPermission): AmazonDisplay | undefined {
  if (!permission || !permission.reference.trim() || permission.reference.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(permission.reference) || !Number.isFinite(observedAt.getTime())) return;
  const fields = extractDisplayFields($, new Set(permission.fields));
  if (!fields) return;
  return { provenance: { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    observedAt: observedAt.toISOString(), permissionReference: permission.reference }, ...fields };
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
  // Some Amazon pages render the selected one-time purchase directly inside
  // the add-to-cart form without either accordion. Never choose a generic
  // form when an accordion or subscription row also exists.
  const direct = !box.find('[id="newAccordionRow_0"], [id="newAccordionRow"], [id="subscribeAccordionRow"], .a-accordion-active').length
    ? box.find('form[id="addToCart"]') : box.find('never-match');
  const selectedDirect = direct.length === 1 && box.find('form[id="addToCart"]').length === 1 &&
    direct.find('input[name="submit.add-to-cart"]').length === 1 &&
    direct.find('input[id="offerListingID"]').length === 1 &&
    !direct.find('input[type="radio"]:checked').length;
  const oneTime = modern.length ? modern : selectedDirect ? direct : box.find('[id="newAccordionRow"]');
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
  const titleElements = $('[id="productTitle"]').filter((_, el) =>
    !$(el).is('input, select, textarea') && !hidden($(el)) && !!$(el).text().trim());
  const title = titleElements.length === 1 ? titleElements.text().trim() : '';
  const offerIds = offer.find(modern.length || selectedDirect ? 'input[name="offeringID.1"], input[id="offerListingID"]' : 'input[name="offeringID.1"]');
  const offerId = offerIds.attr('value');
  const sellers = offer.find('[id="sellerProfileTriggerId"]');
  const merchantFeature = offer.find('[id="merchantInfoFeature_feature_div"]');
  const merchantLinks = merchantFeature.find('a').map((_, el) => $(el).text().trim()).get();
  const merchantName = merchantLinks[0] ?? '';
  const merchantVerified = (modern.length === 1 || selectedDirect) && merchantFeature.length === 1 &&
    merchantName.length > 0 && merchantName.length <= 120 && merchantLinks.length >= 2 &&
    merchantLinks.every(name => name === merchantName) &&
    merchantFeature.text().replace(/\s+/g, ' ').includes(`販売元 ${merchantName}`) &&
    (sellers.length === 0 || sellers.toArray().every(element => $(element).text().trim() === merchantName));
  const sellerElement = sellers.length ? sellers : offer.find('[id="merchant-info"]');
  const sellerSource = merchantVerified ? merchantFeature : sellerElement;
  const seller = merchantVerified ? merchantName : sellerElement.text().trim();
  const apexPrice = modern.length === 1 || selectedDirect ? offer.find('.apex-pricetopay-value .a-offscreen') : offer.find('never-match');
  const priceElements = apexPrice.length === 1 ? apexPrice : offer.find('#price_inside_buybox, #newBuyBoxPrice, .priceToPay .a-offscreen' +
    (modern.length ? ', #corePrice_feature_div .a-offscreen' : ''));
  const priceText = priceElements.map((_, el) => $(el).text().trim()).get();
  const prices = [...new Set(priceText)];
  const price = prices.length === 1 && prices[0].match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.00)?$/);
  const priceJpy = price ? Number(price[1].replaceAll(',', '')) : 0;
  // Never suppress a contradictory *total* purchase price merely because
  // Amazon also renders an apex price. Per-unit prices use separate markup.
  const alternateTotals = apexPrice.length === 1 ? offer.find('#price_inside_buybox, #newBuyBoxPrice, .priceToPay .a-offscreen') : offer.find('never-match');
  const conflictingTotal = alternateTotals.toArray().some(element => $(element).text().trim() !== prices[0]);
  // Conditions may be siblings of the nested delivery block; retain the entire slot.
  const scope = modern.length || selectedDirect ? offer : box;
  const shippingSlot = scope.find('[id="mir-layout-DELIVERY_BLOCK-slot"]');
  const shipping = shippingSlot.length === 1 ? shippingSlot :
    (modern.length === 1 || selectedDirect) && merchantVerified && apexPrice.length === 1 && !shippingSlot.length
      ? scope.find('[id="mir-layout-DELIVERY_BLOCK"]').first() : shippingSlot;
  const shippingEvidence = shipping.text().replace(/\s+/g, ' ').trim();
  const hasShippingConditions = /Prime|プライム|以上|初回|初めて|条件|coupon|クーポン|over |first order|fastest|最短|eligible|qualifying|minimum|when|with |spend|会員|対象|購入|注文|お急ぎ|速達|定期|subscribe|同時|合計|合わせ|まとめ/i.test(shippingEvidence);
  const verifiedFreeShipping = unconditionalStandardFree.test(shippingEvidence) && !hasShippingConditions;
  // Some current one-time Amazon buyboxes show a sourced purchase amount and
  // explicit selected-row merchant, but no verifiable domestic delivery terms.
  // In this narrow case issue merchandise-only pricing: shipping is UNKNOWN,
  // never advertised as free, and must be confirmed separately before payment.
  const quoteWithoutShippingPromise = (selectedModern || selectedDirect) && merchantVerified && apexPrice.length === 1 &&
    !hidden(apexPrice) && shipping.length === 1 && Boolean(shippingEvidence);
  const availabilityElement = scope.find('[id="availability"]');
  const availability = availabilityElement.text().trim();
  const quantitySelect = scope.find('select[name="quantity"]');
  const fixedDirectQuantity = selectedDirect ? scope.find('input[name="items[0.base][quantity]"]') : scope.find('never-match');
  const directAddButton = selectedDirect ? scope.find('input[name="submit.add-to-cart"]') : scope.find('never-match');
  const options = quantitySelect.find('option');
  const selectedOption = options.filter('[selected]').length ? options.filter('[selected]').first() : options.first();
  const disabledQuantity = quantitySelect.is('[disabled], [aria-disabled="true"]') ||
    selectedOption.is('[disabled], [aria-disabled="true"]') || selectedOption.parents('fieldset[disabled], optgroup[disabled]').length > 0;
  const maxQuantity = Math.max(...options.filter((_, el) => !$(el).is('[disabled], [aria-disabled="true"]') &&
    !$(el).parents('optgroup[disabled]').length).map((_, el) => Number($(el).attr('value'))).get(), 0);
  const selectedQuantity = Number(selectedOption.attr('value'));
  const remainingStock = availability.match(/\bonly\s+(\d+)\s+left\b|残り\s*(\d+)\s*点/i);
  const soleRemainingUnit = modern.length === 1 && selectedModern && quantity === 1 &&
    quantitySelect.length === 0 && remainingStock !== null && Number(remainingStock[1] ?? remainingStock[2]) === 1 &&
    oneTime.find('input[name="submit.add-to-cart"]').length === 1 &&
    !hidden(oneTime.find('input[name="submit.add-to-cart"]')) &&
    !oneTime.find('input[name="submit.add-to-cart"]').is('[disabled], [aria-disabled="true"]') &&
    !oneTime.find('input[name="quantity"], input[name="items[0.base][quantity]"]').length;
  // A direct one-time form can submit a single fixed quantity using a hidden
  // input instead of a dropdown. It is proof only for that exact quantity;
  // conflicting or additional quantity controls must not be inferred away.
  const verifiedFixedDirectQuantity = selectedDirect && quantitySelect.length === 0 &&
    fixedDirectQuantity.length === 1 && fixedDirectQuantity.is('input[type="hidden"]') &&
    !fixedDirectQuantity.is('[disabled], [aria-disabled="true"]') &&
    fixedDirectQuantity.parents('fieldset[disabled]').length === 0 &&
    fixedDirectQuantity.attr('value') === String(quantity) &&
    scope.find('input[name="quantity"], select[name="items[0.base][quantity]"]').length === 0;
  const variant = $('#twister .selection').map((_, el) => $(el).text().trim()).get().filter(Boolean).join(' / ');
  if (box.length !== 1 || oneTime.length !== 1 || hiddenOneTime || selectedAsin !== asin || !title || title.length > 1000 || !offerId || offerId.length > 2048 || !seller || seller.length > 1000 || variant.length > 2000 || shippingEvidence.length > 4000 || conflictingTotal ||
      $('[id="desktop_buybox"]').length !== 1 || !verifiedAsinInputs($, asin) ||
      titleElements.length !== 1 ||
      offerIds.length !== 1 || sellerSource.length !== 1 ||
      (modern.length || selectedDirect ? !(selectedModern || selectedDirect) || hidden(oneTime) || oneTime.is('[disabled], [aria-disabled="true"]') ||
        [offerIds, sellerSource, priceElements, shipping, availabilityElement, quantitySelect, selectedOption].some(hidden) ||
        offerIds.is('[disabled], [aria-disabled="true"]') ||
        (!quoteWithoutShippingPromise && /subscribe|定期|Prime|プライム/i.test(offer.text())) ||
        shipping.length !== 1 || availabilityElement.length !== 1 || options.filter('[selected]').length > 1 ||
        oneTime.find('[id^="newAccordionRow_"], [id="subscribeAccordionRow"]').length > 0 :
        oneTime.find('input[type="radio"]:checked').length !== 1) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 99 ||
      !Number.isSafeInteger(priceJpy) || priceJpy <= 0 || priceJpy > 100000000 ||
      (selectedDirect && (directAddButton.length !== 1 || hidden(directAddButton) || directAddButton.is('[disabled], [aria-disabled="true"]') ||
        fixedDirectQuantity.length > 1 || (fixedDirectQuantity.length === 1 &&
          (!fixedDirectQuantity.is('input[type="hidden"]') || fixedDirectQuantity.attr('value') !== String(quantity))))) ||
      !/在庫あり|in stock|残り\s*\d+\s*点/i.test(availability) || /not\s+(?:currently\s+)?in\s+stock|out of stock|在庫なし/i.test(availability) ||
      !(soleRemainingUnit || verifiedFixedDirectQuantity || (quantitySelect.length === 1 && !disabledQuantity && quantity <= maxQuantity && selectedQuantity === quantity)) ||
      (remainingStock !== null && quantity > Number(remainingStock[1] ?? remainingStock[2])) ||
      ($('#twister').length > 0 && !variant) ||
      /subscribe\s*(?:&\s*save|monthly|weekly)|定期おトク便|Prime\s*(?:exclusive|members?\s+only)|プライム会員限定/i.test(`${offer.text()} ${directAddButton.attr('value') ?? ''}`) ||
      (!verifiedFreeShipping && !quoteWithoutShippingPromise)) {
    const preview = parseProductPreview($, asin, observedAt, displayPermission);
    throw new QuoteError('offer_not_verified', 422, preview ? { preview } : undefined);
  }
  // Explicit dates only; relative/ambiguous text remains unknown. Preserve ranges.
  const dates = [...shippingEvidence.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g)].map(m => {
    const year = m[1] ? Number(m[1]) : Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(observedAt));
    return `${year}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(observedAt);
  const ambiguousDate = /\d{1,2}日|明日|本日|tomorrow|today/i.test(shippingEvidence.replace(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g, ''));
  const amazonDelivery = verifiedFreeShipping && !ambiguousDate && dates.length > 0 && dates.length <= 2 && dates.every(d => calendarDate(d) && d >= today) && dates[0] <= dates[dates.length - 1]
    ? { start: dates[0], end: dates[dates.length - 1] } : null;
  const rawImage = $('#landingImage').attr('src');
  const imageUrl = rawImage && /^https:\/\/(?:[a-z0-9-]+\.)*media-amazon\.com\//.test(rawImage) ? rawImage : null;
  const display = parsePublicDisplay($, asin, observedAt, displayPermission);
  return { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`, title, variant: variant || title, seller, offerId,
    quantity, priceJpy, imageUrl, purchaseType: 'one_time', shippingType: verifiedFreeShipping ? 'standard' : 'unverified',
    freeJapanShipping: verifiedFreeShipping,
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
