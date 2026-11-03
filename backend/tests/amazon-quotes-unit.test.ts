import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amazonAsin, parsePublicOffer, QuoteError, addDeliveryDays } from '../src/amazon-quote-source.js';
import { buildQuote, validateQuoteCart } from '../src/amazon-quotes.js';

const asin = 'B08FTSH6KP';
const now = new Date('2026-11-03T00:00:00Z');
function offerHtml(shipping = '通常配送無料 2026年11月8日から2026年11月10日') {
  return `<input id="ASIN" value="${asin}"><span id="productTitle">Fixture item</span>
    <div id="twister"><span class="selection">Blue 200g</span></div>
    <div id="desktop_buybox"><div id="newAccordionRow"><input type="radio" checked>
      <input name="offeringID.1" value="offer-fixture"><span id="sellerProfileTriggerId">Fixture seller</span>
      <span class="priceToPay"><span class="a-offscreen">￥1,000</span></span>
      </div><span id="availability">在庫あり</span><select name="quantity"><option value="1" selected>1</option><option value="2">2</option></select>
      <div id="mir-layout-DELIVERY_BLOCK-slot">${shipping}</div></div>`;
}
test('Amazon inputs canonicalize exact HTTPS JP product URLs and ASINs', () => {
  for (const input of [asin.toLowerCase(), `https://www.amazon.co.jp/name/dp/${asin}?tag=ignored`, `https://amazon.co.jp/gp/product/${asin}`]) assert.equal(amazonAsin(input), asin);
  for (const input of ['hello', `http://amazon.co.jp/dp/${asin}`, `https://amazon.co.jp.evil.test/dp/${asin}`,
    `https://amazon.co.jp@evil.test/dp/${asin}`, `https://www.amazon.co.jp:444/dp/${asin}`, 'https://amzn.asia/x', `https://amazon.co.jp/dp/${asin}EXTRA`]) assert.throws(() => amazonAsin(input), QuoteError);
});
test('quote binds one-time price, seller, selected variant and exact quantity', () => {
  const offer = parsePublicOffer(offerHtml(), asin, 1, now);
  assert.equal(offer.priceJpy, 1000); assert.equal(offer.seller, 'Fixture seller'); assert.equal(offer.variant, 'Blue 200g');
  assert.deepEqual(offer.amazonDelivery, { start: '2026-11-08', end: '2026-11-10' });
  assert.throws(() => parsePublicOffer(offerHtml(), asin, 2, now), QuoteError);
  for (const html of [offerHtml().replace('value="B08FTSH6KP"', 'value="B000000001"'), offerHtml().replace('在庫あり', '在庫なし'),
    offerHtml().replace('￥1,000', '￥0'), offerHtml().replace('sellerProfileTriggerId', 'unknownSeller'),
    offerHtml().replace('offeringID.1', 'unknownOffer'), offerHtml().replace('Blue 200g', ''),
    offerHtml().replace('id="newAccordionRow"', 'id="different-buybox"'),
    offerHtml().replace('￥1,000', '￥1,000 Prime exclusive')]) assert.throws(() => parsePublicOffer(html, asin, 1, now), QuoteError);
});
test('paid, conditional, Prime and ambiguous shipping never qualify; CAPTCHA blocks', () => {
  for (const shipping of ['送料 ￥300', 'Prime 無料配送', '無料配送', '通常配送無料 ￥3500以上', '通常配送無料 3,500円以上',
    'FREE delivery on orders of ¥3,500 or more', 'FREE Standard Delivery on orders of ¥3,500 or more',
    'FREE delivery on your first order', 'FREE delivery for eligible orders', '通常配送無料 お急ぎ便', '', '無料配送 最短']) {
    assert.throws(() => parsePublicOffer(offerHtml(shipping), asin, 1, now), QuoteError);
  }
  assert.equal(parsePublicOffer(offerHtml('FREE Standard Delivery'), asin, 1, now).shippingType, 'standard');
  assert.throws(() => parsePublicOffer('captcha', asin, 1, now), (e: unknown) => e instanceof QuoteError && e.code === 'amazon_blocked');
});
test('missing or ambiguous ETA remains null and calendar-day ranges cross year boundaries', () => {
  const offer = parsePublicOffer(offerHtml('通常配送無料'), asin, 1, now);
  assert.equal(offer.amazonDelivery, null);
  assert.equal(parsePublicOffer(offerHtml('通常配送無料 2026年2月30日'), asin, 1, now).amazonDelivery, null);
  assert.equal(parsePublicOffer(offerHtml('通常配送無料 2026年11月8日～10日'), asin, 1, now).amazonDelivery, null);
  assert.equal(parsePublicOffer(offerHtml('通常配送無料 明日'), asin, 1, now).amazonDelivery, null);
  assert.deepEqual(addDeliveryDays({ start: '2026-12-28', end: '2026-12-31' }, 7), { start: '2027-01-04', end: '2027-01-07' });
  assert.equal(addDeliveryDays(null, 7), null);
  const quote = buildQuote(offer, { version: 1, fxJpyToVnd: 190, serviceFeePercent: 12, checkPriceExpiry: true, priceExpiryDays: 1 }, 7, now);
  assert.equal(quote.unitPriceVnd, 213000);
  assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.observedAt), 900000);
  assert.equal(quote.shippingEstimatedVnd, null); assert.equal(quote.vietnamDelivery, null);
  assert.equal(quote.deliveryDestinationVerified, false);
  assert.throws(() => validateQuoteCart([{ quoteId: quote.id, confirmed: false }]), QuoteError);
  assert.throws(() => validateQuoteCart([{ quoteId: quote.id, confirmed: true }, { quoteId: quote.id, confirmed: true }]), QuoteError);
});
