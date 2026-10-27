import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceHash, sourceText } from '../src/translation/jobs.js';

test('source content hash is stable for unchanged text and changes with Japanese source', () => {
  const row = {
    asin: 'A000000001', name: 'SAVAS 980g', brand: 'SAVAS',
    features: ['たんぱく質 20g'], ingredients: [], usage: [], specs: { weight: '980g' },
    cautions: [], source_hash: null, status: null
  };
  const text = sourceText(row);
  assert.equal(text.name, 'SAVAS 980g');
  assert.equal(sourceHash(text), sourceHash(sourceText({ ...row })));
  assert.notEqual(sourceHash(text), sourceHash(sourceText({ ...row, name: 'SAVAS 500g' })));
});

test('empty optional detail is normalized for translation', () => {
  const text = sourceText({
    name: '日本語の商品', brand: null,
    features: null, ingredients: null, usage: null, specs: null, cautions: null,
  });
  assert.deepEqual(text.features, []);
  assert.deepEqual(text.specs, {});
});
