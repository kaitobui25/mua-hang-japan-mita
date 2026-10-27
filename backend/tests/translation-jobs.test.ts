import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceHash, sourceText, translationFailureStopsBatch, prioritizeDetailCandidates } from '../src/translation/jobs.js';
import { TranslationUnavailable } from '../src/translation/openrouter.js';
import { nextTranslationDelayMs, TRANSLATION_ACTIVE_DELAY_MS, TRANSLATION_IDLE_DELAY_MS } from '../src/translation/schedule.js';

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

test('one bad product does not stop the batch; exhausted shared quota does', () => {
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['source_too_large'])), false);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['model-a:invalid_or_unavailable'])), false);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['model-a:http_429', 'model-b:timeout'])), false);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['providers_temporarily_unavailable'])), true);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['unauthorized_api_key'])), true);
  assert.equal(translationFailureStopsBatch(new TranslationUnavailable(['free_quota_exhausted'])), true);
});

test('detail translation always tries never-attempted products before repeated failing products', () => {
  const rows = [
    { asin: 'A000000001', detail_attempted_at: new Date('2026-10-27T10:00:00Z') },
    { asin: 'A000000002', detail_attempted_at: null },
    { asin: 'A000000003', detail_attempted_at: new Date('2026-10-27T09:00:00Z') }
  ];
  assert.deepEqual(prioritizeDetailCandidates(rows).map(row => row.asin),
    ['A000000002', 'A000000003', 'A000000001']);
});

test('unattended worker continues productive translation after 30s, respects quota failures', () => {
  assert.equal(TRANSLATION_ACTIVE_DELAY_MS, 30_000);
  assert.equal(nextTranslationDelayMs({ translated: 12 }), 30_000);
  assert.equal(nextTranslationDelayMs({ translated: 1 }), 30_000);
  assert.equal(nextTranslationDelayMs({ translated: 0 }), TRANSLATION_IDLE_DELAY_MS);
  assert.equal(nextTranslationDelayMs({ translated: 12, paused: true }), TRANSLATION_IDLE_DELAY_MS,
    'partial progress followed by exhausted quota must back off');
});
