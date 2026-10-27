import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TRANSLATION_MODELS, TranslationUnavailable, translateProduct, type ProductText } from '../src/translation/openrouter.js';

const original: ProductText = {
  name: 'SAVAS ホエイプロテイン ココア味 980g', brand: 'SAVAS', features: ['たんぱく質 20g'],
  ingredients: ['ココア 3g'], usage: ['1日 2回'], specs: { weight: '980g' }, cautions: ['12歳以下は使用しない']
};
const translated = {
  name: 'SAVAS Whey protein vị ca cao 980g', features: ['Protein 20g'], ingredients: ['Ca cao 3g'],
  usage: ['1 ngày 2 lần'], specs: { weight: '980g' }, cautions: ['Không dùng dưới 12 tuổi']
};

test('5 exact free models in owner order', () => {
  assert.deepEqual(FREE_TRANSLATION_MODELS, [
    'google/gemma-4-31b-it:free', 'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-26b-a4b-it:free', 'thinkingmachines/inkling-small:free',
    'nvidia/nemotron-3.5-lightning:free'
  ]);
});

test('falls back sequentially on 429, provider failure and invalid JSON', async () => {
  const seen: string[] = [];
  const mock = (async (_url: unknown, init: RequestInit = {}) => {
    const model = JSON.parse(String(init.body)).model;
    seen.push(model);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    if (seen.length === 1) return new Response('{}', { status: 429 });
    if (seen.length === 2) return new Response('{}', { status: 503 });
    if (seen.length === 3) return Response.json({ choices: [{ message: { content: '{broken' } }] });
    return Response.json({ choices: [{ message: { content: '```json\n' + JSON.stringify(translated) + '\n```' } }] });
  }) as typeof fetch;
  const output = await translateProduct(original, { apiKey: 'test-secret', fetcher: mock });
  assert.equal(output.model, FREE_TRANSLATION_MODELS[3]);
  assert.equal(output.text.name, translated.name);
  assert.deepEqual(seen, FREE_TRANSLATION_MODELS.slice(0, 4));
});

test('rejects changed measurements and preserves original input', async () => {
  const mock = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...translated, name: 'SAVAS 1080g' }) } }] })) as typeof fetch;
  await assert.rejects(translateProduct(original, { apiKey: 'test-secret', fetcher: mock }), (error: unknown) =>
    error instanceof TranslationUnavailable && error.causes.length === 5);
  assert.equal(original.name, 'SAVAS ホエイプロテイン ココア味 980g');
});

test('missing key and unauthorized key stop without leaking credential', async () => {
  await assert.rejects(translateProduct(original, { apiKey: '' , fetcher: (async () => { throw Error('unexpected'); }) as typeof fetch }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'missing_api_key');
  const mock = (async () => new Response('invalid credential', { status: 401 })) as typeof fetch;
  await assert.rejects(translateProduct(original, { apiKey: 'test-secret', fetcher: mock }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'unauthorized_api_key' && !String(error).includes('test-secret'));
});
