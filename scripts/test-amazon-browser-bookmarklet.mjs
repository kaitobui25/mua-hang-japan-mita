import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/amazon-browser-capture.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const exports = {};
runInNewContext(output, { exports, require: () => ({
  amazonInputAsin(value) {
    if (typeof value !== 'string') return null;
    return value.match(/\/dp\/([A-Z0-9]{10})$/)?.[1] ?? null;
  }
}), URL, TextEncoder });

const { amazonCaptureBookmarklet, parseAmazonBrowserCapture } = exports;
const asin = 'B08FTSH6KP';
const canonical = `https://www.amazon.co.jp/dp/${asin}`;
const mita = 'https://mitajapanshop.duckdns.org/mua-ho-amazon';
const script = decodeURIComponent(amazonCaptureBookmarklet(mita).slice('javascript:'.length));

function productPage({ locationUrl = canonical, captcha = false, selected = asin, hidePrice = false } = {}) {
  let target = '';
  const alerts = [];
  const elements = {
    '#productTitle': [{ textContent: 'テスト商品', innerText: 'テスト商品' }],
    '#desktop_buybox #corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen, #desktop_buybox #price_inside_buybox': [
      { textContent: '￥3,580', innerText: '￥3,580' }
    ],
    '#bylineInfo': [{ textContent: 'ブランド', innerText: 'ブランド' }],
    '#sellerProfileTriggerId': [{ textContent: '販売元', innerText: '販売元' }],
    '#availability span, #availability': [{ textContent: '在庫あり', innerText: '在庫あり' }],
    '#mir-layout-DELIVERY_BLOCK-slot, #mir-layout-DELIVERY_BLOCK': [{ textContent: '通常配送', innerText: '通常配送' }],
    '#twister .selection, #variation_color_name .selection, #variation_size_name .selection': [{ textContent: '青', innerText: '青' }],
    '#feature-bullets li .a-list-item': [{ textContent: '特徴', innerText: '特徴' }]
  };
  const decorate = (value, selector) => ({
    ...value, matches: () => false,
    parentElement: hidePrice && selector.includes('.a-price') ? {
      matches: () => false, parentElement: null, hiddenPrice: true
    } : null
  });
  const document = {
    querySelectorAll(selector) { return (elements[selector] ?? []).map(value => decorate(value, selector)); },
    querySelector(selector) {
      if (selector.startsWith('#captchacharacters')) return captcha ? {} : null;
      if (selector === 'input#ASIN') return { value: selected };
      if (selector === '#landingImage, #imgBlkFront') return {
        src: 'https://m.media-amazon.com/images/I/synthetic.jpg', getAttribute: () => null
      };
      return null;
    }
  };
  const window = { open(value) { target = value; return { opener: null }; } };
  const context = { window, document, location: new URL(locationUrl), URL, TextEncoder,
    getComputedStyle: node => ({ display: node.hiddenPrice ? 'none' : 'block', visibility: 'visible' }),
    navigator: {}, alert: value => alerts.push(value), prompt: () => { throw Error('unexpected prompt'); },
    fetch: () => { throw Error('source fetch forbidden'); } };
  runInNewContext(script, context);
  return { target, alerts };
}

test('user-invoked Amazon bookmarklet opens Mita with selected product data only', () => {
  const result = productPage();
  assert.ok(result.target.startsWith(mita + '#browser_capture='));
  const json = decodeURIComponent(result.target.split('#browser_capture=')[1]);
  const projected = parseAmazonBrowserCapture(json, asin);
  assert.equal(projected.page.asin, asin);
  assert.equal(projected.page.priceText, '￥3,580');
  assert.equal(projected.page.variantText, '青');
  assert.equal(projected.page.availabilityText, '在庫あり');
  assert.equal(projected.page.deliveryText, '通常配送');
  assert.deepEqual(Array.from(projected.page.images), ['https://m.media-amazon.com/images/I/synthetic.jpg']);
  for (const sensitive of ['cookie', 'localStorage', 'Authorization', 'password', 'innerHTML']) {
    assert.equal(json.includes(sensitive), false);
  }
  assert.equal(result.alerts.length, 0);
});

test('bookmarklet does not copy prices hidden by ancestor CSS', () => {
  const result = productPage({ hidePrice: true });
  const json = decodeURIComponent(result.target.split('#browser_capture=')[1]);
  assert.equal(parseAmazonBrowserCapture(json, asin).page.priceText, undefined);
});

test('bookmarklet refuses challenge, foreign hostname and conflicting selected variant', () => {
  for (const options of [
    { captcha: true },
    { locationUrl: 'https://amazon.co.jp.evil.test/dp/' + asin },
    { selected: 'B000000001' }
  ]) {
    const result = productPage(options);
    assert.equal(result.target, '');
    assert.equal(result.alerts.length, 1);
  }
});
