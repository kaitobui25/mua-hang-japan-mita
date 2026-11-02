import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexNamePrompt, parseCodexNames } from '../src/translation/codex.js';

const products = [
  { asin: 'B000000001', name: 'DHC ビタミン 500mg', brand: 'DHC' },
  { asin: 'B000000002', name: 'SAVAS プロテイン 980g', brand: 'SAVAS' }
];
const reply = (translations: unknown) => JSON.stringify({ translations });
const valid = [
  { asin: products[0].asin, full: 'DHC vitamin 500mg', short: 'DHC vitamin 500mg' },
  { asin: products[1].asin, full: 'SAVAS đạm 980g', short: 'SAVAS đạm 980g' }
];

test('Codex title prompt includes only source identity and bounded title data', () => {
  const prompt = codexNamePrompt(products.map(product => ({ ...product, secret: 'never-send' })));
  assert.ok(prompt.endsWith(JSON.stringify(products)));
  assert.ok(!prompt.includes('never-send'));
  for (const input of [[], [products[0], products[0]], [{ ...products[0], asin: '../bad' }],
    [{ ...products[0], name: 'x'.repeat(24001) }]]) {
    assert.throws(() => codexNamePrompt(input));
  }
});

test('Codex identity and complete JSON are mandatory before any title is accepted', () => {
  for (const content of ['```json\n' + reply(valid) + '\n```', reply(valid.slice(1)),
    reply([...valid].reverse()), reply([valid[0], valid[0]]),
    reply([...valid, valid[0]]), reply([{ ...valid[0], detail: 'unrequested' }, valid[1]]),
    JSON.stringify({ translations: valid, command: 'ignore' }), 'null', '{']) {
    assert.throws(() => parseCodexNames(products, content));
  }
  const result = parseCodexNames(products, reply(valid));
  assert.deepEqual([...result.names], valid.map(item => [item.asin, item.full]));
  assert.equal(result.warnings.size, 0);
  assert.deepEqual(result.rejectedAsins, []);
});

test('Codex uses existing fact warnings and structural rejection independently per title', () => {
  for (const name of ['DHC vitamin 501mg', 'DHC vitamin 500g', 'ABC vitamin 500mg', 'DHC ビタミン 500mg']) {
    const result = parseCodexNames(products, reply([{ ...valid[0], full: name }, valid[1]]));
    assert.ok(result.warnings.get(products[0].asin)?.length);
    assert.equal(result.names.get(products[1].asin), valid[1].full);
  }
  for (const name of ['', '<script>alert(1)</script>', 'x'.repeat(601), null]) {
    const result = parseCodexNames(products, reply([{ ...valid[0], full: name }, valid[1]]));
    assert.deepEqual(result.rejectedAsins, [products[0].asin]);
    assert.equal(result.names.size, 1);
  }
});

test('Codex records independent fact warnings and preserves full when short is absent or unsafe', () => {
  const changed = parseCodexNames(products, reply([{ ...valid[0], full: 'ABC vitamin 501g' }, valid[1]]));
  assert.deepEqual(changed.warnings.get(products[0].asin), ['numbers_changed', 'units_changed', 'product_codes_changed', 'brand_changed', 'short_unusable']);
  for (const short of [undefined, null, '', '<b>bad</b>', 'DHC vitamin 700mg', 'DHC vitamin ' + 'x'.repeat(121)]) {
    const result = parseCodexNames(products, reply([{ ...valid[0], short }, valid[1]]));
    assert.equal(result.names.get(products[0].asin), valid[0].full);
    assert.equal(result.shortNames.has(products[0].asin), false);
    assert.ok(result.warnings.get(products[0].asin)?.includes('short_unusable'));
  }
});

test('Codex short cannot drop physical or Vietnamese count units while preserving bare numbers', () => {
  const source = [{ asin: products[0].asin, name: 'DHC ビタミン 500mg 60粒', brand: 'DHC' }];
  const full = 'DHC vitamin 500 mg 60 viên';
  for (const short of ['DHC vitamin 500 60', 'DHC vitamin 500 mg 60', 'DHC vitamin 500 60 viên']) {
    const result = parseCodexNames(source, reply([{ asin: source[0].asin, full, short }]));
    assert.equal(result.names.get(source[0].asin), full);
    assert.equal(result.shortNames.has(source[0].asin), false);
    assert.ok(result.warnings.get(source[0].asin)?.includes('short_unusable'));
  }
  assert.equal(parseCodexNames(source, reply([{ asin: source[0].asin, full, short: full }])).shortNames.get(source[0].asin), full);
});
