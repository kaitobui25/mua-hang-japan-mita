import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TRANSLATION_MODELS, TranslationUnavailable, translateProduct, translateNamesBatch, readFreeQuota, type ProductText } from '../src/translation/openrouter.js';

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
  assert.equal(output.model, FREE_TRANSLATION_MODELS[4]);
  assert.equal(output.text.name, translated.name);
  assert.deepEqual(seen, FREE_TRANSLATION_MODELS.filter(model => !model.startsWith('thinkingmachines/')));
});

test('rejects changed measurements and preserves original input', async () => {
  const mock = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...translated, name: 'SAVAS 1080g' }) } }] })) as typeof fetch;
  await assert.rejects(translateProduct(original, { apiKey: 'test-secret', fetcher: mock }), (error: unknown) =>
    error instanceof TranslationUnavailable && error.causes.length === 4);
  assert.equal(original.name, 'SAVAS ホエイプロテイン ココア味 980g');
});

test('rejects silent dosage unit changes even if all numbers stay unchanged', async () => {
  const source: ProductText = { ...original, name: 'SAVAS Vitamin 500mg', features: [], ingredients: [], usage: [], specs: {}, cautions: [] };
  const mock = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...source, name: 'SAVAS Vitamin 500g' }) } }] })) as typeof fetch;
  await assert.rejects(translateProduct(source, { apiKey: 'test-secret', fetcher: mock }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes.length === 4);
});

test('rejects altered product codes with the same digits', async () => {
  const source: ProductText = { ...original, name: 'SAVAS B09ABC123D 980g', features: [], ingredients: [], usage: [], specs: {}, cautions: [] };
  const mock = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...source, name: 'SAVAS X09ABC123D 980g' }) } }] })) as typeof fetch;
  await assert.rejects(translateProduct(source, { apiKey: 'test-secret', fetcher: mock }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes.length === 4);
});

test('missing key and unauthorized key stop without leaking credential', async () => {
  await assert.rejects(translateProduct(original, { apiKey: '' , fetcher: (async () => { throw Error('unexpected'); }) as typeof fetch }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'missing_api_key');
  const mock = (async () => new Response('invalid credential', { status: 401 })) as typeof fetch;
  await assert.rejects(translateProduct(original, { apiKey: 'test-secret', fetcher: mock }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'unauthorized_api_key' && !String(error).includes('test-secret'));
});

test('shared platform 429 stops immediately without burning another model quota', async () => {
  let calls = 0;
  const mock = (async () => { calls++; return new Response('{}', {
    status: 429, headers: { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0' }
  }); }) as typeof fetch;
  await assert.rejects(translateProduct(original, { apiKey: 'test-secret', fetcher: mock }),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'rate_limit_platform');
  assert.equal(calls, 1);
});

test('GET quota status avoids inference and fails closed on malformed data', async () => {
  const mock = (async (_url: unknown, init: RequestInit = {}) => {
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    return Response.json({ data: { free_model_daily_requests: { remaining: 10, limit: 50, used: 40 } } });
  }) as typeof fetch;
  assert.equal((await readFreeQuota('test-secret', mock)).remaining, 10);
  const invalid = (async () => Response.json({ data: {} })) as typeof fetch;
  await assert.rejects(readFreeQuota('test-secret', invalid),
    (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'quota_check_unavailable');
});

test('request budget gate aborts before calling a model', async () => {
  let requests = 0;
  const mock = (async () => { requests++; throw new Error('not expected'); }) as typeof fetch;
  await assert.rejects(translateProduct(original, {
    apiKey: 'test-secret', fetcher: mock,
    beforeRequest: async () => { throw new TranslationUnavailable(['free_quota_exhausted']); }
  }), (error: unknown) => error instanceof TranslationUnavailable && error.causes[0] === 'free_quota_exhausted');
  assert.equal(requests, 0);
});

test('batch suppresses a provider after its 429 instead of burning quota on every product', async () => {
  const blockedModels = new Set<string>();
  const seen: string[] = [];
  const mock = (async (_url: unknown, init: RequestInit = {}) => {
    const model: string = JSON.parse(String(init.body)).model;
    seen.push(model);
    if (model === FREE_TRANSLATION_MODELS[0]) return new Response('{}', { status: 429 });
    return Response.json({ choices: [{ message: { content: JSON.stringify(translated) } }] });
  }) as typeof fetch;
  await translateProduct(original, { apiKey: 'test-secret', fetcher: mock, unavailableModels: blockedModels });
  await translateProduct(original, { apiKey: 'test-secret', fetcher: mock, unavailableModels: blockedModels });
  assert.deepEqual(seen, [FREE_TRANSLATION_MODELS[0], FREE_TRANSLATION_MODELS[1], FREE_TRANSLATION_MODELS[1]]);
});

test('translate multiple Japanese product names in one free inference request preserving identity and units', async () => {
  const names = [{ asin: 'B000000001', name: 'SAVAS たんぱく質 500mg', brand: 'SAVAS' },
    { asin: 'B000000002', name: 'DHC ビタミン 60粒', brand: 'DHC' }];
  let calls = 0;
  const mock = (async (_url: unknown, init: RequestInit = {}) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, FREE_TRANSLATION_MODELS[0]);
    assert.match(body.messages[1].content, /B000000001/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: [
      { asin: 'B000000001', name: 'SAVAS protein 500mg' },
      { asin: 'B000000002', name: 'DHC vitamin 60 viên' }
    ] }) } }] });
  }) as typeof fetch;
  const result = await translateNamesBatch(names, { apiKey: 'test-secret', fetcher: mock });
  assert.equal(calls, 1);
  assert.equal(result.model, FREE_TRANSLATION_MODELS[0]);
  assert.equal(result.names.get('B000000002'), 'DHC vitamin 60 viên');
});

test('batch rejects re-ordered ASINs, altered units, or missing names without publishing', async () => {
  const names = [{ asin: 'B000000001', name: 'SAVAS 500mg', brand: 'SAVAS' }];
  for (const bad of [{ asin: 'B000000009', name: 'SAVAS 500mg' }, { asin: 'B000000001', name: 'SAVAS 500g' }]) {
    const mock = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ translations: [bad] }) } }] })) as typeof fetch;
    await assert.rejects(translateNamesBatch(names, { apiKey: 'test-secret', fetcher: mock }),
      (error: unknown) => error instanceof TranslationUnavailable);
  }
});
