import { ScraplingSession, QuoteTransportError } from '../src/ingestion/scrapling.js';
import { config } from '../src/config.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amazonAsin, parsePublicOffer, readPublicOffer, QuoteError, type AmazonDisplayPermission, type AmazonProductPreview } from '../src/amazon-quote-source.js';
import { buildQuote } from '../src/amazon-quotes.js';

const asin = 'B08FTSH6KP';
const observedAt = new Date('2026-11-03T00:00:00Z');
const permission: AmazonDisplayPermission = {
  reference: 'synthetic-fixture-permission-only',
  fields: ['images', 'brand', 'description', 'features', 'ingredients', 'usage', 'warnings', 'specifications', 'rating', 'reviewCount', 'reviews']
};
function page(extra = '') {
  return `<input id="ASIN" value="${asin}"><span id="productTitle">Source item</span>
    <div id="twister"><span class="selection">Blue 200g</span></div>
    <div id="desktop_buybox"><div id="newAccordionRow"><input type="radio" checked>
      <input name="offeringID.1" value="fixture-offer"><span id="sellerProfileTriggerId">Source seller</span>
      <span id="price_inside_buybox">￥1,000</span></div><span id="availability">In stock</span>
      <select name="quantity"><option value="1" selected>1</option><option value="2">2</option></select>
      <div id="mir-layout-DELIVERY_BLOCK-slot">FREE Standard Delivery</div></div>${extra}`;
}
const metadata = `
  <img id="landingImage" src="https://m.media-amazon.com/images/I/main.jpg">
  <div id="altImages"><img src="https://m.media-amazon.com/images/I/main.jpg">
    <img src="https://m.media-amazon.com/images/I/second.jpg"></div>
  <div id="po-brand"><span class="po-break-word">ACME 型番 X-01</span></div>
  <div id="productDescription"><p>Source <b>description</b> &amp; units 200g.</p><script>secret()</script></div>
  <div id="feature-bullets"><ul><li><span class="a-list-item">Feature 200g</span></li></ul></div>
  <div id="important-information">
    <div class="content"><h4>原材料・成分</h4><p>Water 20ml</p></div>
    <div class="content"><h4>使用方法</h4><p>Use once</p></div>
    <div class="content"><h4>安全警告</h4><p>Source warning</p></div></div>
  <table id="productDetails_techSpec_section_1"><tr><th>Model</th><td>X-01 / 200g</td></tr></table>
  <span id="acrPopover" title="5つ星のうち4.3"></span><span id="acrCustomerReviewText">1,234個の評価</span>
  <div id="cm-cr-dp-review-list"><div data-hook="review"><span data-hook="review-title">Source title</span>
    <span data-hook="review-body">Source review</span><i data-hook="review-star-rating">5つ星のうち4.0</i></div></div>`;
const parse = (html = page(metadata), allow: AmazonDisplayPermission | undefined = permission) =>
  parsePublicOffer(html, asin, 1, observedAt, allow);

test('metadata requires explicit field permission and is absent for old/minimal pages', () => {
  assert.equal(parsePublicOffer(page(metadata), asin, 1, observedAt).display, undefined);
  assert.equal(parse(page()).display, undefined);
  assert.equal(parse(page(metadata), { reference: '', fields: permission.fields }).display, undefined);
  const display = parse(page(metadata), { reference: permission.reference, fields: ['brand'] }).display!;
  assert.equal(display.brand, 'ACME 型番 X-01');
  assert.equal(display.images, undefined);
  assert.equal(display.reviews, undefined);
});

test('selected page metadata preserves source values and records canonical provenance', () => {
  const display = parse().display!;
  assert.deepEqual(display.provenance, { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
    observedAt: observedAt.toISOString(), permissionReference: permission.reference });
  assert.deepEqual(display.images, ['https://m.media-amazon.com/images/I/main.jpg', 'https://m.media-amazon.com/images/I/second.jpg']);
  assert.equal(display.description, 'Source description & units 200g.');
  assert.deepEqual(display.features, ['Feature 200g']);
  assert.equal(display.ingredients, 'Water 20ml');
  assert.equal(display.usage, 'Use once');
  assert.equal(display.warnings, 'Source warning');
  assert.deepEqual(display.specifications, [{ name: 'Model', value: 'X-01 / 200g' }]);
  assert.equal(display.rating, 4.3);
  assert.equal(display.reviewCount, 1234);
  assert.deepEqual(display.reviews, [{ title: 'Source title', body: 'Source review', rating: 4 }]);
});

test('optional metadata cannot relax selected offer, quantity, shipping or CAPTCHA guards', () => {
  for (const html of [page(metadata).replace(asin, 'B000000001'), page(metadata).replace('FREE Standard Delivery', 'FREE delivery'),
    page(metadata).replace('Source seller', ''), page(metadata) + 'captcha']) {
    assert.throws(() => parse(html), QuoteError);
  }
  assert.throws(() => parsePublicOffer(page(metadata), asin, 2, observedAt, permission), QuoteError);
  const { display: _, ...enriched } = parse();
  assert.deepEqual(enriched, parsePublicOffer(page(metadata), asin, 1, observedAt));
});

test('metadata rejects unsafe URLs and ignores alternate variants and unrelated reviews', () => {
  const unsafe = ['http://m.media-amazon.com/a', 'https://media-amazon.com.evil.test/a',
    'https://user:pass@m.media-amazon.com/a', 'https://m.media-amazon.com:444/a', 'javascript:alert(1)', '//m.media-amazon.com/a'];
  const display = parse(page(`<div id="altImages">${unsafe.map(src => `<img src="${src}">`).join('')}
    <img src="https://m.media-amazon.com/images/I/ok.jpg"></div>
    <div id="twister-other"><img src="https://m.media-amazon.com/other.jpg"></div>
    <div data-hook="review"><span data-hook="review-body">Unrelated</span></div>`)).display!;
  assert.deepEqual(display.images, ['https://m.media-amazon.com/images/I/ok.jpg']);
  assert.equal(display.reviews, undefined);
});

test('malformed or oversized optional fields are omitted without invalidating an offer', () => {
  const display = parse(page(`<div id="productDescription">${'x'.repeat(12001)}</div>
    <span id="acrPopover" title="5つ星のうち6.0"></span><span id="acrCustomerReviewText">unknown 123</span>
    <div id="feature-bullets"><li><span class="a-list-item">OK<script>bad</script><style>bad</style>\u0000</span></li></div>
    <table id="productDetails_techSpec_section_1"><tr><th>Missing</th></tr></table>`)).display!;
  assert.equal(display.description, undefined);
  assert.equal(display.rating, undefined);
  assert.equal(display.reviewCount, undefined);
  assert.equal(display.specifications, undefined);
  assert.deepEqual(display.features, ['OK']);
});

test('gallery and text collections have bounded deduplicated sizes', () => {
  const display = parse(page(`<div id="altImages">${Array.from({ length: 50 }, (_, i) =>
    `<img src="https://m.media-amazon.com/images/I/${i}.jpg">`).join('')}</div>
    <div id="feature-bullets">${Array.from({ length: 50 }, (_, i) => `<li><span class="a-list-item">Feature ${i}</span></li>`).join('')}</div>
    <div id="cm-cr-dp-review-list">${Array.from({ length: 30 }, () =>
    '<div data-hook="review"><span data-hook="review-body">Same source review</span></div>').join('')}</div>`)).display!;
  assert.equal(display.images?.length, 10);
  assert.equal(display.features?.length, 20);
  assert.equal(display.reviews?.length, 1);
});

test('missing, hidden and unrelated metadata does not become fabricated content', () => {
  const offer = parse(page(`<div id="productDescription" hidden>Hidden</div>
    <div aria-hidden="true"><div id="po-brand"><span class="po-break-word">Hidden brand</span></div></div>
    <script type="application/ld+json">{"ratingValue":5,"description":"Alternate"}</script>
    <div id="recommendations"><span class="rating">5 out of 5 stars</span></div>`));
  assert.equal(offer.display, undefined);
  assert.equal(offer.imageUrl, null);
});

test('hidden images and aggregate ratings are omitted along with hidden text', () => {
  assert.equal(parse(page(`<img id="landingImage" hidden src="https://m.media-amazon.com/images/I/hidden.jpg">
    <div aria-hidden="true"><div id="altImages"><img src="https://m.media-amazon.com/images/I/alternate.jpg"></div>
      <span id="acrPopover" title="5つ星のうち5.0"></span></div>`)).display, undefined);
});

test('block and line breaks preserve separation of source units in text', () => {
  const display = parse(page(`<div id="productDescription"><p>Water 20ml</p><p>Salt 2g<br>Use once</p></div>
    <div id="important-information"><div class="content"><h4>Ingredients</h4><p>Water 20ml</p><p>Salt 2g</p></div></div>
    <div id="cm-cr-dp-review-list"><div data-hook="review"><span data-hook="review-body">First line<br>Second line</span></div></div>`)).display!;
  assert.equal(display.description, 'Water 20ml Salt 2g Use once');
  assert.equal(display.ingredients, 'Water 20ml Salt 2g');
  assert.deepEqual(display.reviews, [{ body: 'First line Second line' }]);
});

test('display survives quote building without changing pricing, validity or shipping', () => {
  const offer = parse();
  const policy = { version: 1, fxJpyToVnd: 190, serviceFeePercent: 12, checkPriceExpiry: true, priceExpiryDays: 1 };
  const quote = buildQuote(offer, policy, 7, observedAt);
  assert.deepEqual(quote.display, offer.display);
  assert.equal(quote.unitPriceVnd, 213000);
  assert.equal(quote.lineTotalVnd, 213000);
  assert.equal(quote.expiresAt, '2026-11-03T00:15:00.000Z');
  assert.equal(quote.shippingEstimatedVnd, null);
  assert.equal(quote.shippingDueLater, true);
});

test('reader enriches only the single bridge response and retains source guards', async t => {
  const transport = t.mock.method(ScraplingSession.prototype, 'quote', async () => ({ html: page(metadata), observedAt }));
  const close = t.mock.method(ScraplingSession.prototype, 'close', () => {});
  const offer = await readPublicOffer(asin, 1, permission);
  assert.equal(transport.mock.callCount(), 1);
  assert.deepEqual(transport.mock.calls[0].arguments, [asin, 1, config.amazonTimeoutMs]);
  assert.equal(offer.display?.brand, 'ACME \u578b\u756a X-01');
  assert.equal(offer.display?.provenance.observedAt, observedAt.toISOString());
  assert.equal((await readPublicOffer(asin, 1)).display, undefined);
  for (const code of ['amazon_blocked', 'amazon_rate_limited', 'amazon_response_too_large', 'amazon_unavailable'] as const) {
    transport.mock.mockImplementation(async () => { throw new QuoteTransportError(code, '2026-11-05T00:00:00.000Z'); });
    await assert.rejects(readPublicOffer(asin, 1, permission), (error: unknown) =>
      error instanceof QuoteError && error.code === code && error.retryAfterAt === '2026-11-05T00:00:00.000Z' && error.details === undefined);
  }
  assert.equal(close.mock.callCount(), transport.mock.callCount());
});

test('invalid quote inputs fail before opening transport', async t => {
  const transport = t.mock.method(ScraplingSession.prototype, 'quote', async () => { throw Error('must not run'); });
  for (const input of ['', asin.toLowerCase(), asin + 'X', `https://www.amazon.co.jp/dp/${asin}`, asin + '\n']) {
    await assert.rejects(readPublicOffer(input, 1), (e: unknown) => e instanceof QuoteError && e.code === 'invalid_amazon_input');
  }
  for (const quantity of [0, 100, 1.5, NaN, '1', true]) {
    await assert.rejects(readPublicOffer(asin, quantity as number), (e: unknown) => e instanceof QuoteError && e.code === 'invalid_quantity');
  }
  assert.equal(transport.mock.callCount(), 0);
});

function preview(html: string, allow?: AmazonDisplayPermission, inputAsin = asin): AmazonProductPreview | undefined {
  let error: unknown;
  try { parsePublicOffer(html, inputAsin, 1, observedAt, allow); } catch (e) { error = e; }
  assert.ok(error instanceof QuoteError);
  assert.equal(error.code, 'offer_not_verified');
  assert.equal(error.status, 422);
  return (error.details as { preview?: AmazonProductPreview } | undefined)?.preview;
}

test('product metadata survives missing offer facts only with explicit field permission', () => {
  // Synthetic page for the pasted identity; no assertion about the live product.
  const inputAsin = amazonAsin('https://www.amazon.co.jp/Double-Sided-Generator-Phosphate-Disaster-Prevention/dp/B0FR4GT3R7?ref=tracking');
  const html = `<input id="ASIN" value="${inputAsin}"><span id="productTitle">Synthetic source item</span>${metadata}`;
  const result = preview(html, permission, inputAsin)!;
  assert.deepEqual(result, { asin: inputAsin, sourceUrl: `https://www.amazon.co.jp/dp/${inputAsin}`,
    title: 'Synthetic source item', observedAt: observedAt.toISOString(),
    display: { ...parse().display!, provenance: { asin: inputAsin, sourceUrl: `https://www.amazon.co.jp/dp/${inputAsin}`,
      observedAt: observedAt.toISOString(), permissionReference: permission.reference } } });
  assert.equal(preview(html, undefined, inputAsin)?.display, undefined);
  assert.equal(preview(html, { reference: '', fields: permission.fields }, inputAsin)?.display, undefined);
  assert.deepEqual(Object.keys(preview(html, { reference: permission.reference, fields: ['brand'] }, inputAsin)!.display!).sort(),
    ['brand', 'provenance']);
  assert.equal(preview(html.replace(inputAsin, 'B000000001'), permission, inputAsin), undefined);
});

test('source title preview ignores a duplicate empty productTitle input, but not a second visible title', () => {
  const html = `<input id="ASIN" value="${asin}"><span id="productTitle">Verified source title</span>
    <input id="productTitle" type="text" value="tracking">`;
  assert.equal(preview(html)?.title, 'Verified source title');
  assert.equal(preview(html + '<span id="productTitle">Another visible title</span>'), undefined);
});

test('missing seller, stock or eligible shipping retains metadata without producing a quote', () => {
  for (const html of [page(metadata).replace('Source seller', ''), page(metadata).replace('In stock', 'Out of stock'),
    page(metadata).replace('FREE Standard Delivery', 'FREE delivery on orders over JPY 3,500')]) {
    const result = preview(html, permission)!;
    assert.equal(result.display?.description, 'Source description & units 200g.');
    assert.equal(result.priceJpy, 1000);
    for (const key of ['offerId', 'seller', 'quantity', 'freeJapanShipping', 'amazonDelivery', 'expiresAt', 'unitPriceVnd']) {
      assert.equal(Object.hasOwn(result, key), false, key);
    }
  }
});

test('legacy preview price remains confined to an unambiguous selected one-time row', () => {
  const html = page().replace('FREE Standard Delivery', 'FREE delivery');
  assert.equal(preview(html)?.priceJpy, 1000);
  assert.equal(preview(html.replace('price_inside_buybox', 'newBuyBoxPrice'))?.priceJpy, 1000);
  for (const candidate of [
    html.replace('checked', ''), html.replace('checked', 'checked disabled'),
    html.replace('id="newAccordionRow"', 'id="newAccordionRow" aria-disabled="true"'),
    html.replace('Source seller', 'Subscribe &amp; Save'),
    html.replace('Source seller', 'Prime exclusive'),
    html.replace('id="price_inside_buybox"', 'id="price_inside_buybox" hidden'),
    html.replace('</div><span id="availability">', '<span id="newBuyBoxPrice">&#165;900</span></div><span id="availability">'),
    html.replace('</div><span id="availability">', '<div id="newAccordionRow_1" class="a-accordion-active"></div></div><span id="availability">'),
    html.replace('id="price_inside_buybox"', 'id="unrelated-price"') + '<span id="price_inside_buybox">&#165;900</span>'
  ]) {
    assert.equal(preview(candidate)?.title, 'Source item');
    assert.equal(preview(candidate)?.priceJpy, undefined);
  }
});

test('preview omits hidden permissioned content and preserves visible text boundaries', () => {
  for (const attribute of ['hidden', 'aria-hidden="true"', 'class="a-hidden"', 'class="aok-hidden"',
    'style="display:none !important"', 'style="visibility:collapse"']) {
    const html = page(`<div ${attribute}>${metadata}</div>`).replace('Source seller', '');
    assert.equal(preview(html, permission)?.display, undefined, attribute);
  }
  const html = page(`<div id="productDescription">Water 20ml<span style="display:none">Other variant</span><br>Salt 2g</div>`)
    .replace('Source seller', '').replace('Source item', '<div>Source</div><div>item</div>');
  assert.equal(preview(html, permission)?.title, 'Source item');
  assert.equal(preview(html, permission)?.display?.description, 'Water 20ml Salt 2g');
});

test('reader preserves permissioned preview from one response and never previews transport failures', async t => {
  const html = page(metadata).replace('Source seller', '');
  const transport = t.mock.method(ScraplingSession.prototype, 'quote', async () => ({ html, observedAt }));
  const close = t.mock.method(ScraplingSession.prototype, 'close', () => {});
  await assert.rejects(readPublicOffer(asin, 1, permission), (error: unknown) => {
    assert.ok(error instanceof QuoteError);
    assert.deepEqual(error.details, { preview: preview(html, permission) });
    return true;
  });
  assert.equal(transport.mock.callCount(), 1);
  transport.mock.mockImplementation(async () => ({ html: html + 'captcha', observedAt }));
  await assert.rejects(readPublicOffer(asin, 1, permission), (error: unknown) =>
    error instanceof QuoteError && error.code === 'amazon_blocked' && error.details === undefined);
  for (const code of ['amazon_blocked', 'amazon_rate_limited', 'amazon_response_too_large', 'amazon_unavailable'] as const) {
    transport.mock.mockImplementation(async () => { throw new QuoteTransportError(code); });
    await assert.rejects(readPublicOffer(asin, 1, permission), (error: unknown) =>
      error instanceof QuoteError && error.code === code && error.details === undefined);
  }
  assert.equal(transport.mock.callCount(), 6);
  assert.equal(close.mock.callCount(), 6);
});
