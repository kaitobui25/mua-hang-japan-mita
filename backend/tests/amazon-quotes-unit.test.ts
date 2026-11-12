import { ScraplingSession, QuoteTransportError } from '../src/ingestion/scrapling.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amazonAsin, parsePublicOffer, readPublicOffer, QuoteError, addDeliveryDays, type AmazonProductPreview } from '../src/amazon-quote-source.js';
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

function modernHtml() {
  return offerHtml('FREE delivery on orders over JPY 3,500')
    .replace('id="newAccordionRow"', 'id="newAccordionRow_0"')
    .replace('name="offeringID.1"', 'id="offerListingID"')
    .replace('id="mir-layout-DELIVERY_BLOCK-slot"', 'id="mir-layout-DELIVERY_BLOCK"');
}

// Representative rendered accordion: selected offer facts live in its form;
// an unselected subscription and a page-level price must never supply facts.
function modernVerifiedHtml() {
  return `<!doctype html><html><body>
    <input type="hidden" id="ASIN" value="${asin}">
    <h1><span id="productTitle">Fixture item 200g</span></h1>
    <div id="twister"><span class="selection">Blue 200g</span></div>
    <div id="corePriceDisplay_desktop_feature_div"><span class="a-offscreen">&#165;800</span></div>
    <div id="desktop_buybox">
      <div id="newAccordionRow_0" class="a-box a-accordion-active">
        <div class="a-accordion-row"><span>One-time purchase</span></div>
        <div class="a-accordion-inner"><form id="addToCart" method="post">
          <input type="hidden" id="offerListingID" name="offeringID.1" value="selected-offer-token">
          <div id="corePrice_feature_div"><span class="a-price priceToPay">
            <span class="a-offscreen">&#165;1,000</span><span aria-hidden="true">1,000</span>
          </span></div>
          <div id="merchant-info">Sold by <a id="sellerProfileTriggerId">Selected seller</a></div>
          <div id="availability"><span>Only 2 left in stock</span></div>
          <select name="quantity"><option value="1" selected>1</option><option value="2">2</option></select>
          <div id="mir-layout-DELIVERY_BLOCK-slot"><div id="mir-layout-DELIVERY_BLOCK">FREE Standard Delivery</div></div>
          <input type="submit" name="submit.add-to-cart" value="Add to Cart">
        </form></div>
      </div>
      <div id="subscribeAccordionRow" class="a-box">
        <input type="radio" name="purchaseOption" value="subscribe">
        <span>Subscribe &amp; Save</span><span class="priceToPay"><span class="a-offscreen">&#165;900</span></span>
        <input name="offeringID.1" value="subscription-offer"><span id="merchant-info">Other seller</span>
      </div>
    </div></body></html>`;
}

test('active modern one-time buybox verifies only its selected offer facts', () => {
  const html = modernVerifiedHtml();
  const offer = parsePublicOffer(html, asin, 1, now);
  assert.deepEqual(offer, { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    title: 'Fixture item 200g', variant: 'Blue 200g', seller: 'Selected seller', offerId: 'selected-offer-token',
    quantity: 1, priceJpy: 1000, imageUrl: null, purchaseType: 'one_time', shippingType: 'standard',
    freeJapanShipping: true, shippingEvidence: 'FREE Standard Delivery', amazonDelivery: null });
  const radio = html.replace('<span>One-time purchase</span>', '<input type="radio" name="purchaseOption" checked><span>One-time purchase</span>');
  assert.equal(parsePublicOffer(radio, asin, 1, now).offerId, 'selected-offer-token');
  assert.equal(parsePublicOffer(html.replace('name="offeringID.1" value="selected-offer-token"', 'value="selected-offer-token"'), asin, 1, now).offerId, 'selected-offer-token');
  assert.equal(parsePublicOffer(html.replace('</body>', '<input id="productTitle" value="tracking"></body>'), asin, 1, now).title, 'Fixture item 200g');
  assert.equal(parsePublicOffer(html.replace('value="1" selected', 'value="1"').replace('value="2"', 'value="2" selected'), asin, 2, now).quantity, 2);
});

test('modern buybox rejects ambiguous selection, identity, seller, offer and price', () => {
  const html = modernVerifiedHtml();
  for (const [label, candidate] of [
    ['inactive', html.replace('a-box a-accordion-active', 'a-box')],
    ['subscription active', html.replace('id="subscribeAccordionRow" class="a-box"', 'id="subscribeAccordionRow" class="a-box a-accordion-active"')],
    ['subscription checked', html.replace('value="subscribe"', 'value="subscribe" checked')],
    ['one-time unchecked', html.replace('<span>One-time purchase</span>', '<input type="radio"><span>One-time purchase</span>')],
    ['one-time disabled', html.replace('<span>One-time purchase</span>', '<input type="radio" checked disabled><span>One-time purchase</span>')],
    ['two checked', html.replace('<span>One-time purchase</span>', '<input type="radio" checked><input type="radio" checked><span>One-time purchase</span>')],
    ['duplicate row', html.replace('id="addToCart"', 'id="newAccordionRow_0"')],
    ['legacy row conflict', html.replace('id="addToCart"', 'id="newAccordionRow"')],
    ['wrong ASIN', html.replace(`value="${asin}"`, 'value="B000000001"')],
    ['conflicting ASIN', html.replace('</body>', '<input id="ASIN" value="B000000001"></body>')],
    ['duplicate title', html.replace('</body>', '<span id="productTitle">Another title</span></body>')],
    ['missing title', html.replace('Fixture item 200g', '')],
    ['missing seller', html.replace('<div id="merchant-info">Sold by <a id="sellerProfileTriggerId">Selected seller</a></div>', '')],
    ['duplicate seller', html.replace('Selected seller</a>', 'Selected seller</a><a id="sellerProfileTriggerId">Another seller</a>')],
    ['missing offer', html.replace('<input type="hidden" id="offerListingID" name="offeringID.1" value="selected-offer-token">', '')],
    ['duplicate offer', html.replace('id="addToCart"', 'id="addToCart"><input name="offeringID.1" value="another-offer"')],
    ['missing price', html.replace('&#165;1,000', '')],
    ['alternate price', html.replace('&#165;1,000', '&#165;1,000 or &#165;900')],
    ['conflicting price', html.replace('</form>', '<span id="newBuyBoxPrice">&#165;900</span></form>')],
    ['subscription terms', html.replace('One-time purchase', 'Subscribe &amp; Save')],
    ['subscription without save', html.replace('One-time purchase', 'Subscribe monthly')],
    ['Japanese subscription', html.replace('One-time purchase', '\u5b9a\u671f\u304a\u30c8\u30af\u4fbf')],
    ['Prime membership', html.replace('One-time purchase', 'Prime members only')],
    ['Prime price', html.replace('One-time purchase', 'Prime exclusive')]
  ]) {
    assert.throws(() => parsePublicOffer(candidate, asin, 1, now),
      (e: unknown) => e instanceof QuoteError && e.code === 'offer_not_verified', label);
  }
});

test('modern buybox fails closed on hidden evidence, quantity, stock and shipping conditions', () => {
  const html = modernVerifiedHtml();
  for (const attribute of ['hidden', 'aria-hidden="true"', 'class="a-hidden"', 'style="display:none !important"', 'style="visibility:collapse"']) {
    for (const target of ['id="desktop_buybox"', 'id="productTitle"', 'id="sellerProfileTriggerId"', 'id="offerListingID"',
      'id="corePrice_feature_div"', 'id="availability"', 'name="quantity"', 'value="1" selected', 'id="mir-layout-DELIVERY_BLOCK-slot"']) {
      assert.throws(() => parsePublicOffer(html.replace(target, `${target} ${attribute}`), asin, 1, now), QuoteError, `${target}: ${attribute}`);
    }
  }
  assert.throws(() => parsePublicOffer(html.replace('id="newAccordionRow_0"', 'id="newAccordionRow_0" hidden'), asin, 1, now), QuoteError);
  assert.throws(() => parsePublicOffer(html.replace('id="newAccordionRow_0"', 'id="newAccordionRow_0" aria-disabled="true"'), asin, 1, now), QuoteError);
  for (const candidate of [
    html.replace('Only 2 left in stock', 'Out of stock. In stock soon'),
    html.replace('Only 2 left in stock', ''),
    html.replace('select name="quantity"', 'select name="quantity" disabled'),
    html.replace('value="1" selected', 'value="1" selected disabled'),
    html.replace('value="2"', 'value="2" selected'),
    html.replace('name="quantity"', 'name="other-quantity"'),
    html.replace('id="mir-layout-DELIVERY_BLOCK-slot"', 'id="other-delivery"'),
    html.replace('id="availability"', 'id="other-availability"')
  ]) assert.throws(() => parsePublicOffer(candidate, asin, 1, now), QuoteError);
  const two = html.replace('value="1" selected', 'value="1"').replace('value="2"', 'value="2" selected');
  assert.throws(() => parsePublicOffer(two.replace('Only 2 left', 'Only 1 left'), asin, 2, now), QuoteError);
  assert.throws(() => parsePublicOffer(html, asin, 2, now), QuoteError);
  for (const condition of ['Prime members only', 'on orders over JPY 3,500', 'on your first order',
    'with qualifying purchases', 'coupon required', 'Subscribe &amp; Save']) {
    for (const content of [`<span>${condition}</span><div>FREE Standard Delivery</div>`,
      `<div>FREE Standard Delivery</div><span>${condition}</span>`]) {
      assert.throws(() => parsePublicOffer(html.replace('<div id="mir-layout-DELIVERY_BLOCK">FREE Standard Delivery</div>', content), asin, 1, now), QuoteError, condition);
    }
  }
  for (const shipping of ['FREE Delivery', 'FREE Standard Delivery or paid expedited delivery', 'JPY 300 Standard Delivery', '']) {
    assert.throws(() => parsePublicOffer(html.replace('FREE Standard Delivery', shipping), asin, 1, now), QuoteError, shipping);
  }
});
function rejectedPreview(html: string): AmazonProductPreview | undefined {
  let error: unknown;
  try { parsePublicOffer(html, asin, 1, now); } catch (e) { error = e; }
  assert.ok(error instanceof QuoteError);
  assert.equal(error.code, 'offer_not_verified');
  assert.equal(error.status, 422);
  return (error.details as { preview: AmazonProductPreview } | undefined)?.preview;
}

test('modern source preview shows observed price, image and delivery while rejecting quote issuance', () => {
  const html = modernHtml().replace('Fixture item', 'Source &amp; model 200g <script>secret()</script><span hidden>Other variant</span>') +
    '<img id="landingImage" src="https://m.media-amazon.com/images/I/fixture.jpg">';
  const result = rejectedPreview(html)!;
  assert.equal(result.asin, asin);
  assert.equal(result.sourceUrl, `https://www.amazon.co.jp/dp/${asin}`);
  assert.equal(result.title, 'Source & model 200g');
  assert.equal(result.observedAt, now.toISOString());
  assert.equal(result.priceJpy, 1000);
  assert.deepEqual(result.observedDetails?.images, ['https://m.media-amazon.com/images/I/fixture.jpg']);
  assert.match(result.deliveryText ?? '', /FREE delivery/);
  assert.equal(result.freeDelivery, true);
  assert.equal(Object.hasOwn(result, 'freeJapanShipping'), false);
  // Even a legacy offer rejected only for conditional shipping remains rejected.
  assert.equal(rejectedPreview(offerHtml('FREE Standard Delivery on orders over JPY 3,500'))?.title, 'Fixture item');
});
test('modern main price is displayed regardless of selected checkout accordion', () => {
  const active = modernHtml()
    .replace('id="newAccordionRow_0"', 'id="newAccordionRow_0" class="a-accordion-active"')
    .replace('<input type="radio" checked>', '')
    .replace('class="priceToPay"', 'id="corePrice_feature_div"');
  assert.equal(rejectedPreview(active)?.priceJpy, 1000);
  assert.equal(rejectedPreview(active.replace('class="a-accordion-active"', 'class="a-accordion"'))?.priceJpy, 1000);
  assert.equal(rejectedPreview(active.replace('￥1,000', '￥1,000 or ￥900'))?.priceJpy, undefined);
  assert.equal(rejectedPreview(active.replace('</div><span id="availability">', '<div id="newAccordionRow_1" class="a-accordion-active">￥900</div></div><span id="availability">'))?.priceJpy, 1000);
});

test('same-ASIN Amazon form duplicates and scoped one-time total retain a preview', () => {
  const html = modernVerifiedHtml()
    .replace('class="a-price priceToPay"', 'class="a-price apex-pricetopay-value"')
    .replace('</form>', '<span class="apex-priceperunit-value"><span class="a-offscreen">&#165;500</span></span></form>')
    .replace('FREE Standard Delivery', 'FREE delivery on orders over JPY 3,500')
    .replace('</body>', `<input id="ASIN" value="${asin}"></body>`);
  const result = rejectedPreview(html);
  assert.equal(result?.asin, asin);
  assert.equal(result?.priceJpy, 1000, 'selected one-time total must not be replaced with per-unit price');
  assert.equal(rejectedPreview(html.replace(`value="${asin}"></body>`, 'value="B000000001"></body>')), undefined);
  assert.equal(rejectedPreview(html.replace('apex-pricetopay-value', 'apex-priceperunit-value'))?.priceJpy, undefined);
});

test('current Amazon one-time buybox quotes merchandise without inventing free domestic shipping', () => {
  const html = modernVerifiedHtml()
    .replace('<div id="merchant-info">Sold by <a id="sellerProfileTriggerId">Selected seller</a></div>',
      '<div id="merchantInfoFeature_feature_div">出荷元 / 販売元 <a>Amazon.co.jp</a> <a>Amazon.co.jp</a></div>')
    .replace('class="a-price priceToPay"', 'class="a-price apex-pricetopay-value"')
    .replace('</span></div>\n          <div id="merchantInfoFeature_feature_div">',
      '</span><span class="apex-priceperunit-value"><span class="a-offscreen">&#165;500</span></span></div>\n          <div id="merchantInfoFeature_feature_div">')
    .replace('<div id="mir-layout-DELIVERY_BLOCK-slot"><div id="mir-layout-DELIVERY_BLOCK">FREE Standard Delivery</div></div>',
      '<div id="mir-layout-DELIVERY_BLOCK">無料配送 11月14日</div><div id="mir-layout-DELIVERY_BLOCK">Prime 最も早い配送</div>')
    .replace('</body>', `<input id="ASIN" value="${asin}"><input id="productTitle" value="tracking"></body>`);
  const offer = parsePublicOffer(html, asin, 1, now);
  assert.equal(offer.priceJpy, 1000);
  assert.equal(offer.seller, 'Amazon.co.jp');
  assert.equal(offer.purchaseType, 'one_time');
  assert.equal(offer.shippingType, 'unverified');
  assert.equal(offer.freeJapanShipping, false);
  assert.equal(offer.amazonDelivery, null);
  assert.throws(() => parsePublicOffer(html.replace('<a>Amazon.co.jp</a> <a>Amazon.co.jp</a>',
    '<a>Amazon.co.jp</a> <a>Other seller</a>'), asin, 1, now), QuoteError);
  assert.throws(() => parsePublicOffer(html.replace('a-box a-accordion-active', 'a-box'), asin, 1, now), QuoteError);
  assert.throws(() => parsePublicOffer(html.replace('&#165;1,000', '&#165;900 Prime exclusive'), asin, 1, now), QuoteError);
});

test('realistic independent seller and Japanese limited stock require matching seller evidence', () => {
  const html = modernVerifiedHtml()
    .replace('<div id="merchant-info">Sold by <a id="sellerProfileTriggerId">Selected seller</a></div>',
      '<div id="merchantInfoFeature_feature_div">販売元 <a>Bodywing</a> <a>Bodywing</a></div><a id="sellerProfileTriggerId">Bodywing</a><a id="sellerProfileTriggerId">Bodywing</a>')
    .replace('class="a-price priceToPay"', 'class="a-price apex-pricetopay-value"')
    .replace('Only 2 left in stock', '残り4点 ご注文はお早めに')
    .replace('<div id="mir-layout-DELIVERY_BLOCK-slot"><div id="mir-layout-DELIVERY_BLOCK">FREE Standard Delivery</div></div>',
      '<div id="mir-layout-DELIVERY_BLOCK">無料配送 11月16日</div>');
  const quote = parsePublicOffer(html, asin, 1, now);
  assert.equal(quote.priceJpy, 1000);
  assert.equal(quote.seller, 'Bodywing');
  assert.equal(quote.freeJapanShipping, false);
  assert.throws(() => parsePublicOffer(html.replace('残り4点', '残り0点'), asin, 1, now), QuoteError);
  assert.throws(() => parsePublicOffer(html.replace('Bodywing</a><a id="sellerProfileTriggerId">Bodywing',
    'Other seller</a><a id="sellerProfileTriggerId">Bodywing'), asin, 1, now), QuoteError);
  assert.throws(() => parsePublicOffer(html.replace('<a>Bodywing</a> <a>Bodywing</a>',
    '<a>Bodywing</a> <a>Other seller</a>'), asin, 1, now), QuoteError);
});

function directBuyboxHtml() {
  return `<input id="ASIN" value="${asin}"><h1><span id="productTitle">Formula 800g</span></h1>
    <div id="desktop_buybox"><form id="addToCart">
      <input id="offerListingID" name="offerListingID" value="exact-direct-offer">
      <div class="apex-pricetopay-value"><span class="a-offscreen">&#165;3,100</span></div>
      <div id="corePrice_feature_div"><span class="a-offscreen">&#165;3,100</span></div>
      <div id="merchantInfoFeature_feature_div">出荷元 / 販売元 <a>Amazon.co.jp</a> <a>Amazon.co.jp</a></div>
      <div id="availability">在庫あり。</div>
      <select name="quantity"><option value="1" selected>1</option><option value="2">2</option></select>
      <input type="hidden" name="items[0.base][quantity]" value="1">
      <div id="mir-layout-DELIVERY_BLOCK">無料配送 11月14日（初回注文特典）</div>
      <input type="submit" name="submit.add-to-cart" value="カートに入れる">
    </form></div>`;
}
test('direct one-time add-to-cart form binds price and quantity without promoting first-order shipping', () => {
  const html = directBuyboxHtml();
  const offer = parsePublicOffer(html, asin, 1, now);
  assert.equal(offer.priceJpy, 3100);
  assert.equal(offer.seller, 'Amazon.co.jp');
  assert.equal(offer.offerId, 'exact-direct-offer');
  assert.equal(offer.shippingType, 'unverified');
  assert.equal(offer.freeJapanShipping, false);
  assert.equal(offer.amazonDelivery, null);
  for (const [name, candidate] of [
    ['no add-to-cart', html.replace('name="submit.add-to-cart"', 'name="another-action"')],
    ['conflicting ASIN', html.replace(`value="${asin}"`, 'value="B000000001"')],
    ['wrong seller', html.replace('<a>Amazon.co.jp</a> <a>Amazon.co.jp</a>', '<a>Amazon.co.jp</a> <a>Other seller</a>')],
    ['wrong offer', html.replace('id="offerListingID"', 'id="another-offer"')],
    ['missing stock', html.replace('在庫あり。', '在庫なし')],
    ['missing quantity', html.replace('name="quantity"', 'name="another-quantity"').replace('name="items[0.base][quantity]"', 'name="another-fixed-quantity"')],
    ['conflicting fixed quantity', html.replace('name="items[0.base][quantity]" value="1"', 'name="items[0.base][quantity]" value="2"')],
    ['duplicate fixed quantity', html.replace('<input type="hidden" name="items[0.base][quantity]" value="1">', '<input type="hidden" name="items[0.base][quantity]" value="1"><input type="hidden" name="items[0.base][quantity]" value="1">')],
    ['different quantity', html.replace('value="1" selected', 'value="2" selected')],
    ['multiple forms', html.replace('</form></div>', '</form><form id="addToCart"></form></div>')],
    ['subscription accordion', html.replace('</form></div>', '</form><div id="subscribeAccordionRow">定期おトク便</div></div>')],
    ['active accordion', html.replace('<form id="addToCart">', '<div id="newAccordionRow_0" class="a-accordion-active"></div><form id="addToCart">')],
    ['hidden price', html.replace('class="apex-pricetopay-value"', 'class="apex-pricetopay-value" hidden')],
    ['hidden add-to-cart', html.replace('name="submit.add-to-cart"', 'name="submit.add-to-cart" hidden')],
    ['disabled add-to-cart', html.replace('name="submit.add-to-cart"', 'name="submit.add-to-cart" disabled')],
    ['conflicting total', html.replace('</form>', '<span id="newBuyBoxPrice">￥2,900</span></form>')],
    ['Prime-only offer', html.replace('Formula 800g', 'Formula 800g Prime members only').replace('value="カートに入れる"', 'value="Prime members only"')],
    ['subscription offer', html.replace('value="カートに入れる"', 'value="Subscribe monthly"')],
  ] as const) assert.throws(() => parsePublicOffer(candidate, asin, 1, now), QuoteError, name);
  assert.throws(() => parsePublicOffer(html, asin, 2, now), QuoteError);
});

test('direct one-time form with only a fixed hidden quantity can quote exactly that quantity', () => {
  const html = directBuyboxHtml().replace(/<select name="quantity">.*?<\/select>/, '');
  const offer = parsePublicOffer(html, asin, 1, now);
  assert.equal(offer.priceJpy, 3100);
  assert.equal(offer.quantity, 1);
  assert.throws(() => parsePublicOffer(html, asin, 2, now), QuoteError);
  for (const [label, candidate] of [
    ['missing fixed input', html.replace('name="items[0.base][quantity]"', 'name="other-quantity"')],
    ['wrong fixed value', html.replace('name="items[0.base][quantity]" value="1"', 'name="items[0.base][quantity]" value="2"')],
    ['non-hidden fixed input', html.replace('type="hidden" name="items[0.base][quantity]"', 'type="text" name="items[0.base][quantity]"')],
    ['disabled fixed input', html.replace('name="items[0.base][quantity]" value="1"', 'name="items[0.base][quantity]" value="1" disabled')],
    ['disabled fixed fieldset', html.replace('<input type="hidden" name="items[0.base][quantity]" value="1">', '<fieldset disabled><input type="hidden" name="items[0.base][quantity]" value="1"></fieldset>')],
    ['duplicate fixed input', html.replace('<input type="hidden" name="items[0.base][quantity]" value="1">', '<input type="hidden" name="items[0.base][quantity]" value="1"><input type="hidden" name="items[0.base][quantity]" value="1">')],
    ['competing quantity input', html.replace('</form>', '<input name="quantity" value="1"></form>')],
    ['competing quantity select', html.replace('</form>', '<select name="items[0.base][quantity]"><option value="1">1</option></select></form>')],
    ['missing stock', html.replace('在庫あり。', '在庫なし')],
    ['missing add-to-cart', html.replace('name="submit.add-to-cart"', 'name="something-else"')],
    ['disabled add-to-cart', html.replace('name="submit.add-to-cart"', 'name="submit.add-to-cart" disabled')],
  ] as const) assert.throws(() => parsePublicOffer(candidate, asin, 1, now), QuoteError, label);
});

test('backordered direct-form item keeps observed price as preview, not a verified in-stock offer', () => {
  const html = directBuyboxHtml().replace('在庫あり。', '通常1～2か月以内に発送します。');
  const preview = rejectedPreview(html);
  assert.equal(preview?.priceJpy, 3100);
  assert.throws(() => parsePublicOffer(html, asin, 1, now),
    (error: unknown) => error instanceof QuoteError && error.code === 'offer_not_verified');
});

test('selected one-time offer with explicitly one unit remaining can quote exactly one without quantity dropdown', () => {
  const html = modernVerifiedHtml().replace(/<select name="quantity">.*?<\/select>/, '')
    .replace('Only 2 left in stock', 'Only 1 left in stock');
  const quote = parsePublicOffer(html, asin, 1, now);
  assert.equal(quote.quantity, 1);
  assert.equal(quote.priceJpy, 1000);
  for (const [label, candidate] of [
    ['more units remaining', html.replace('Only 1 left in stock', 'Only 2 left in stock')],
    ['unknown remaining stock', html.replace('Only 1 left in stock', 'In stock')],
    ['no add-to-cart', html.replace('name="submit.add-to-cart"', 'name="other-action"')],
    ['disabled add-to-cart', html.replace('name="submit.add-to-cart"', 'name="submit.add-to-cart" disabled')],
    ['different ASIN', html.replace(`value="${asin}"`, 'value="B000000001"')],
    ['unselected one-time offer', html.replace('a-box a-accordion-active', 'a-box')],
    ['hidden stock', html.replace('id="availability"', 'id="availability" hidden')],
  ] as const) assert.throws(() => parsePublicOffer(candidate, asin, 1, now), QuoteError, label);
  assert.throws(() => parsePublicOffer(html, asin, 2, now), QuoteError);
});

test('preview never invents price from invalid, hidden, conflicting or unrelated price elements', () => {
  const html = modernHtml();
  const extraPrice = '<span class="priceToPay"><span class="a-offscreen">￥900</span></span>';
  const withoutPrice = html.replace(/<span class="priceToPay">.*?<\/span><\/span>/, '');
  for (const candidate of [
    html.replace('￥1,000', '￥1,000 or ￥900'), html.replace('￥1,000', '￥0'),
    html.replace('</div><span id="availability">', `${extraPrice}</div><span id="availability">`),
    withoutPrice + extraPrice,
    withoutPrice + '<script>{"priceJpy":900,"asin":"B000000001"}</script>',
  ]) {
    const preview = rejectedPreview(candidate);
    assert.equal(preview?.title, 'Fixture item');
    assert.equal(Object.hasOwn(preview!, 'priceJpy'), false);
  }
  for (const candidate of [
    html.replace('type="radio" checked', 'type="radio"'),
    html.replace('type="radio" checked', 'type="radio" checked disabled'),
    html.replace('Fixture seller', 'Subscribe &amp; Save'),
    html.replace('Fixture seller', '定期おトク便'),
    html.replace('type="radio" checked', 'type="radio" checked><input type="radio" checked'),
    html.replace('id="newAccordionRow_0"', 'id="subscribeAccordionRow"')
  ]) assert.equal(rejectedPreview(candidate)?.priceJpy, 1000);
  for (const attribute of ['hidden', 'aria-hidden="true"', 'class="aok-hidden"', 'class="a-hidden"',
    'style="display:none !important"', 'style="visibility:collapse"']) {
    for (const target of ['id="newAccordionRow_0"', 'id="desktop_buybox"', 'class="priceToPay"']) {
      const replacement = target === 'class="priceToPay"' && attribute.startsWith('class=')
        ? `class="priceToPay ${attribute.slice(7, -1)}"` : `${target} ${attribute}`;
      assert.equal(rejectedPreview(html.replace(target, replacement))?.priceJpy, undefined, `${target}: ${attribute}`);
    }
  }
});

test('preview requires exact unique ASIN and visible valid title; CAPTCHA never carries preview', () => {
  const html = modernHtml();
  for (const candidate of [html.replace(asin, 'B000000001'), html.replace('id="ASIN"', 'id="otherASIN"'),
    html + '<input id="ASIN" value="B000000001">', html.replace('id="productTitle"', 'id="otherTitle"'),
    html + '<span id="productTitle">Duplicate</span>', html.replace('Fixture item', ''),
    html.replace('Fixture item', 'x'.repeat(1001)), html.replace('id="productTitle"', 'id="productTitle" hidden'),
    html.replace('Fixture item', '<span style="display:none">Hidden title</span>')]) {
    assert.equal(rejectedPreview(candidate), undefined);
  }
  assert.throws(() => parsePublicOffer(html + 'captcha', asin, 1, now),
    (e: unknown) => e instanceof QuoteError && e.code === 'amazon_blocked' && e.details === undefined);
});

test('reader previews only the same bridge HTML with no extra source request', async t => {
  const transport = t.mock.method(ScraplingSession.prototype, 'quote', async () => ({ html: modernHtml(), observedAt: now }));
  for (const code of ['offer_not_verified', 'amazon_unavailable', 'amazon_blocked', 'amazon_rate_limited', 'amazon_response_too_large'] as const) {
    transport.mock.mockImplementation(async () => {
      if (code !== 'offer_not_verified') throw new QuoteTransportError(code);
      return { html: modernHtml(), observedAt: now };
    });
    const before = transport.mock.callCount();
    await assert.rejects(readPublicOffer(asin, 1), (e: unknown) => {
      assert.ok(e instanceof QuoteError);
      assert.equal(e.code, code);
      const preview = (e.details as { preview: AmazonProductPreview } | undefined)?.preview;
      if (code === 'offer_not_verified') {
        assert.equal(preview?.title, 'Fixture item');
        assert.equal(preview?.priceJpy, 1000);
        assert.equal(preview?.observedAt, now.toISOString());
      } else assert.equal(preview, undefined);
      return true;
    });
    assert.equal(transport.mock.callCount() - before, 1);
  }
  transport.mock.mockImplementation(async () => ({ html: modernHtml() + 'captcha', observedAt: now }));
  await assert.rejects(readPublicOffer(asin, 1), (e: unknown) => e instanceof QuoteError && e.code === 'amazon_blocked' && e.details === undefined);
});
test('Amazon inputs canonicalize exact HTTPS JP product URLs and ASINs', () => {
  for (const input of [asin.toLowerCase(), `https://www.amazon.co.jp/name/dp/${asin}?tag=ignored`, `https://amazon.co.jp/gp/product/${asin}`,
    `https://www.amazon.co.jp/gp/aw/d/${asin}?ref_=mobile`,
    `https://amazon.co.jp/gp/aw/d/${asin}/ref=mobile`]) assert.equal(amazonAsin(input), asin);
  for (const input of ['hello', `http://amazon.co.jp/dp/${asin}`, `http://www.amazon.co.jp/gp/aw/d/${asin}`,
    `https://amazon.co.jp.evil.test/gp/aw/d/${asin}`, `https://www.amazon.co.jp/gp/aw/d/${asin}EXTRA`,
    `https://amazon.co.jp.evil.test/dp/${asin}`,
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
test('negative stock wording and explicit remaining stock override in-stock text', () => {
  const html = offerHtml('FREE Standard Delivery').replace(/(<span id="availability">).*?(<\/span>)/, '$1In stock$2');
  assert.equal(parsePublicOffer(html, asin, 1, now).quantity, 1);
  for (const availability of ['Not currently in stock', 'Not in stock', 'Out of stock. In stock soon']) {
    assert.throws(() => parsePublicOffer(html.replace('>In stock<', `>${availability}<`), asin, 1, now),
      (e: unknown) => e instanceof QuoteError && e.code === 'offer_not_verified', availability);
  }
  const limited = html.replace('>In stock<', '>Only 1 left in stock<');
  assert.equal(parsePublicOffer(limited, asin, 1, now).quantity, 1);
  assert.throws(() => parsePublicOffer(limited.replace('value="1" selected', 'value="1"').replace('value="2"', 'value="2" selected'), asin, 2, now), QuoteError);
});
test('nested delivery blocks retain sibling Prime and threshold conditions', () => {
  const nested = '<div id="mir-layout-DELIVERY_BLOCK">FREE Standard Delivery</div>';
  assert.equal(parsePublicOffer(offerHtml(nested), asin, 1, now).shippingEvidence, 'FREE Standard Delivery');
  for (const condition of ['Prime members only', 'on orders over JPY 3,500', 'with qualifying purchases']) {
    for (const shipping of [`<span>${condition}</span>${nested}`, `${nested}<span>${condition}</span>`]) {
      assert.throws(() => parsePublicOffer(offerHtml(shipping), asin, 1, now),
        (e: unknown) => e instanceof QuoteError && e.code === 'offer_not_verified', shipping);
    }
  }
});
test('hidden one-time rows and ancestors cannot verify an offer', () => {
  for (const attribute of ['hidden', 'aria-hidden="true"', 'style="display: none !important"',
    'style="visibility: hidden"', 'class="aok-hidden"']) {
    for (const id of ['newAccordionRow', 'desktop_buybox']) {
      const html = offerHtml('FREE Standard Delivery').replace(`id="${id}"`, `id="${id}" ${attribute}`);
      assert.throws(() => parsePublicOffer(html, asin, 1, now),
        (e: unknown) => e instanceof QuoteError && e.code === 'offer_not_verified', `${id}: ${attribute}`);
    }
  }
});
test('disabled quantity controls and selected options cannot verify quantity', () => {
  const html = offerHtml('FREE Standard Delivery');
  for (const disabled of [html.replace('select name="quantity"', 'select name="quantity" disabled'),
    html.replace('select name="quantity"', 'select name="quantity" aria-disabled="true"'),
    html.replace('value="1" selected', 'value="1" selected disabled'),
    html.replace('<select', '<fieldset disabled><select').replace('</select>', '</select></fieldset>'),
    html.replace('<option value="1"', '<optgroup disabled><option value="1"').replace('</select>', '</optgroup></select>')]) {
    assert.throws(() => parsePublicOffer(disabled, asin, 1, now),
      (e: unknown) => e instanceof QuoteError && e.code === 'offer_not_verified');
  }
  assert.equal(parsePublicOffer(html.replace('value="2"', 'disabled value="2"'), asin, 1, now).quantity, 1);
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
