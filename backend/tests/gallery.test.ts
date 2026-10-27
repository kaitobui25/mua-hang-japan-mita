import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/pool.js';
import { parseDetail } from '../src/ingestion/detail.js';
import { uniqueImages } from '../src/ingestion/enrichment.js';
import { ingestObservations } from '../src/ingestion/store.js';

const asin = 'G000000003';
const url = (id: string, size = 'SL1500') => `https://m.media-amazon.com/images/I/${id}._${size}_.jpg`;
const page = (body: string) => `<input id="ASIN" value="${asin}"><span id="productTitle">Amazon gallery fixture</span>${body}`;
const parse = (body: string) => parseDetail(page(body), asin, 'thuc-pham-bo-sung');
const initial = (images: unknown[], currentAsin = asin) => `<script>${JSON.stringify({ currentAsin, colorImages: { initial: images, blue: [{ hiRes: url('other-color') }] } })}</script>`;
after(async () => { await db.end(); });

test('dynamic dictionary retains distinct gallery identities and highest observed resolution', () => {
  const images = { [url('front', 'SX300')]: [300, 300], [url('back')]: [1500, 1500], [url('front')]: [1500, 1500] };
  const item = parse(`<img id="landingImage" data-a-dynamic-image='${JSON.stringify(images)}'>`);
  assert.deepEqual(item.imageUrls, [url('front'), url('back')]);
  assert.ok(item.detail!.provenance.sections.includes('gallery:partial'));
  assert.equal(item.detail!.provenance.fieldObservedAt!.images, item.detail!.sourceObservedAt);
});

test('deduplication upgrades later resolutions before applying the five-image cap', () => {
  const low = ['front', 'back', 'side', 'label', 'top', 'sixth'].map(id => url(id, 'SX300'));
  assert.deepEqual(uniqueImages([...low, url('front'), url('back')]), [url('front'), url('back'), ...low.slice(2, 5)]);
});

test('dynamic dimensions choose the largest actual URL even without URL size modifiers', () => {
  const small = 'https://m.media-amazon.com/images/I/front.jpg?size=small';
  const large = 'https://m.media-amazon.com/images/I/front.jpg?size=large';
  const item = parse(`<img id="landingImage" data-a-dynamic-image='${JSON.stringify({ [small]: [100, 100], [large]: [1600, 1600] })}'>`);
  assert.deepEqual(item.imageUrls, [large]);
});

test('altImages src is read without collecting variation or recommendation images', () => {
  const item = parse(`<img id="landingImage" src="${url('front', 'SX300')}">
    <div id="altImages"><img src="${url('front')}"><img src="${url('back', 'SX38')}"><img src="https://evil.test/fake.jpg"></div>
    <div id="variation_color_name"><img src="${url('other-color')}"></div>
    <div id="recommendations"><img src="${url('recommended')}"></div>
    ${initial([{ hiRes: url('other-asin') }], 'G000000004')}`);
  assert.deepEqual(item.imageUrls, [url('front'), url('back', 'SX38')]);
  assert.ok(item.detail!.provenance.sections.includes('gallery:partial'));
});

test('complete selected initial gallery has provenance and excludes other color galleries', () => {
  const expected = ['front', 'back', 'side', 'label', 'top'].map(id => url(id));
  const item = parse(initial([...expected, url('sixth')].map(hiRes => ({ hiRes }))));
  assert.deepEqual(item.imageUrls, expected);
  assert.ok(item.detail!.provenance.sections.includes('gallery:complete'));
  assert.ok(item.detail!.provenance.sections.includes('colorImages.initial'));
  assert.equal(item.detail!.provenance.sourceUrl, `https://www.amazon.co.jp/dp/${asin}`);
});

test('single-quoted source keys remain supported and initial is bounded to colorImages', () => {
  const item = parse(`<script>var gallery = {'colorImages': {'initial': [{"hiRes":"${url('front')}"}]}};</script>`);
  assert.deepEqual(item.imageUrls, [url('front')]);
  assert.ok(item.detail!.provenance.sections.includes('gallery:complete'));
  const partial = parse(`<img id="landingImage" src="${url('front')}">
    <script>{"colorImages":{"blue":[]},"recommendations":{"initial":[{"hiRes":"${url('unrelated')}"}]}}</script>
    <div id="recommendations">${initial([{ hiRes: url('recommended') }])}</div>
    <div data-asin="G000000004">${initial([{ hiRes: url('other-owner') }])}</div>`);
  assert.deepEqual(partial.imageUrls, [url('front')]);
  assert.ok(partial.detail!.provenance.sections.includes('gallery:partial'));
});

test('store preserves real gallery and its timestamp on partial refresh, but replaces complete gallery', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const original = parse(initial(['front', 'back', 'side'].map(id => ({ hiRes: url(id) }))));
    original.detail!.sourceObservedAt = '2025-01-01T00:00:00.000Z';
    original.detail!.provenance.fieldObservedAt = { images: original.detail!.sourceObservedAt };
    await ingestObservations([original], undefined, client);
    const read = async () => (await client.query('SELECT source_url,source_observed_at FROM product_images WHERE asin=$1 ORDER BY position', [asin])).rows;
    const before = await read();
    for (const body of [
      `<img id="landingImage" src="${url('front', 'SX300')}">`,
      initial([{ hiRes: url('front') }, { hiRes: 'https://evil.test/invalid.jpg' }]),
      `<img id="landingImage" src="${url('front')}">${initial([{ hiRes: url('other-asin') }], 'G000000004')}`
    ]) {
      await ingestObservations([parse(body)], undefined, client);
      assert.deepEqual(await read(), before);
      assert.equal((await client.query('SELECT image_url FROM products WHERE asin=$1', [asin])).rows[0].image_url, original.imageUrls![0]);
      const provenance = (await client.query('SELECT provenance FROM product_details WHERE asin=$1', [asin])).rows[0].provenance;
      assert.equal(provenance.fieldObservedAt.images, original.detail!.sourceObservedAt);
    }
    const replacement = parse(initial([{ hiRes: url('new-single') }]));
    await ingestObservations([replacement], undefined, client);
    assert.deepEqual((await read()).map(row => row.source_url), replacement.imageUrls);
    assert.equal((await client.query('SELECT image_url FROM products WHERE asin=$1', [asin])).rows[0].image_url, url('new-single'));
  } finally { await client.query('ROLLBACK'); client.release(); }
});
