import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { applyTranslations } from '../src/translation/catalog.js';
import { sourceHash, sourceText, nameHash } from '../src/translation/jobs.js';

const text = sourceText({
  name: 'SAVAS ホエイ 980g', brand: 'SAVAS', features: ['たんぱく質 20g'],
  ingredients: [], usage: [], specs: {}, cautions: []
});

test('only current translations replace in-memory display text; no source overwrite', async () => {
  const products = [{ asin: 'A000000001', name: text.name, brand: text.brand ?? null,
    detail: { ...text, variantAttributes: { Flavor: 'Chocolate' }, childAsins: [], sourceObservedAt: '2026-10-27T00:00:00Z', provenance: { sourceUrl: 'https://www.amazon.co.jp/dp/A000000001', adapter: 'http', sections: [] } } }];
  const output = { ...text, name: 'SAVAS đạm whey 980g', features: ['Protein 20g'] };
  const client = { query: async () => ({ rows: [{ asin: products[0].asin, name: output.name, detail: output, source_hash: sourceHash(text) }] }) } as unknown as Pick<PoolClient, 'query'>;
  await applyTranslations(products, client);
  assert.equal(products[0].name, output.name);
  assert.deepEqual(products[0].detail.features, output.features);
  assert.deepEqual(products[0].detail.variantAttributes, { Flavor: 'Chocolate' });
});

test('old translation is skipped after source title changes', async () => {
  const products = [{ asin: 'A000000001', name: 'SAVAS 500g', brand: 'SAVAS', detail: null }];
  const client = { query: async () => ({ rows: [{ asin: products[0].asin, name: 'Tên cũ', detail: text, source_hash: sourceHash(text) }] }) } as unknown as Pick<PoolClient, 'query'>;
  await applyTranslations(products, client);
  assert.equal(products[0].name, 'SAVAS 500g');
});

test('current Vietnamese title remains visible when Amazon changes only product specifications', async () => {
  const products = [{ asin: 'A000000001', name: 'DHC ビタミン 60粒', brand: 'DHC',
    detail: { features: ['特長 A'], ingredients: [], usage: [], specs: { origin: '日本' },
      cautions: [], variantAttributes: {}, childAsins: [], sourceObservedAt: '2026-10-27T00:00:00Z',
      provenance: { sourceUrl: 'https://www.amazon.co.jp/dp/A000000001', adapter: 'http-detail', sections: ['productDetails'] } } }];
  const client = { query: async () => ({ rows: [{ asin: products[0].asin,
    name: 'DHC vitamin 60 viên', detail: null, source_hash: nameHash(products[0]), name_only: true }] }) } as unknown as Pick<PoolClient, 'query'>;
  await applyTranslations(products, client);
  assert.equal(products[0].name, 'DHC vitamin 60 viên');
  assert.deepEqual(products[0].detail.features, ['特長 A'], 'untranslated source detail must remain original');
});
