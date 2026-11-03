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
function rejectedPreview(html: string): AmazonProductPreview | undefined {
  let error: unknown;
  try { parsePublicOffer(html, asin, 1, now); } catch (e) { error = e; }
  assert.ok(error instanceof QuoteError);
  assert.equal(error.code, 'offer_not_verified');
  assert.equal(error.status, 422);
  return (error.details as { preview: AmazonProductPreview } | undefined)?.preview;
}

test('modern public product preview survives strict quote rejection without shipping or image claims', () => {
  const html = modernHtml().replace('Fixture item', 'Source &amp; model 200g <script>secret()</script><span hidden>Other variant</span>') +
    '<img id="landingImage" src="https://m.media-amazon.com/images/I/fixture.jpg">';
  assert.deepEqual(rejectedPreview(html), { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    title: 'Source & model 200g', observedAt: now.toISOString(), priceJpy: 1000 });
  // Even a legacy offer rejected only for conditional shipping remains rejected.
  assert.equal(rejectedPreview(offerHtml('FREE Standard Delivery on orders over JPY 3,500'))?.title, 'Fixture item');
});
test('active modern one-time accordion without radio exposes only its own displayed JPY price', () => {
  const active = modernHtml()
    .replace('id="newAccordionRow_0"', 'id="newAccordionRow_0" class="a-accordion-active"')
    .replace('<input type="radio" checked>', '')
    .replace('class="priceToPay"', 'id="corePrice_feature_div"');
  assert.equal(rejectedPreview(active)?.priceJpy, 1000);
  assert.equal(rejectedPreview(active.replace('class="a-accordion-active"', 'class="a-accordion"'))?.priceJpy, undefined);
  assert.equal(rejectedPreview(active.replace('￥1,000', '￥1,000 or ￥900'))?.priceJpy, undefined);
  assert.equal(rejectedPreview(active.replace('</div><span id="availability">', '<div id="newAccordionRow_1" class="a-accordion-active">￥900</div></div><span id="availability">'))?.priceJpy, undefined);
});

test('preview never invents a price from ambiguous, hidden, subscription or unselected offers', () => {
  const html = modernHtml();
  const extraPrice = '<span class="priceToPay"><span class="a-offscreen">￥900</span></span>';
  const withoutPrice = html.replace(/<span class="priceToPay">.*?<\/span><\/span>/, '');
  for (const candidate of [
    html.replace('￥1,000', '￥1,000 or ￥900'), html.replace('￥1,000', '￥0'),
    html.replace('</div><span id="availability">', `${extraPrice}</div><span id="availability">`),
    html.replace('type="radio" checked', 'type="radio"'),
    html.replace('type="radio" checked', 'type="radio" checked disabled'),
    html.replace('Fixture seller', 'Subscribe &amp; Save'), html.replace('Fixture seller', '定期おトク便'),
    html.replace('type="radio" checked', 'type="radio" checked><input type="radio" checked'),
    withoutPrice + extraPrice,
    withoutPrice + '<script>{"priceJpy":900,"asin":"B000000001"}</script>',
    html.replace('id="newAccordionRow_0"', 'id="subscribeAccordionRow"')
  ]) {
    const preview = rejectedPreview(candidate);
    assert.equal(preview?.title, 'Fixture item');
    assert.equal(Object.hasOwn(preview!, 'priceJpy'), false);
  }
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
    html + `<input id="ASIN" value="${asin}">`, html.replace('id="productTitle"', 'id="otherTitle"'),
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
