import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const source = readFileSync(new URL('./amazon-stars.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
} }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports);
const { AmazonStars } = module.exports;

test('shared card/detail stars render source-backed 4.2/76 without verbose metadata', () => {
  const html = renderToStaticMarkup(createElement(AmazonStars, { product: { amazon: {
    averageStars: 4.2, ratingsCount: 76, observedAt: '2026-10-28T00:00:00Z', stale: true,
  } } }));
  assert.match(html, /4\.2 trên 5 sao/);
  const width = Number(html.match(/width:([\d.]+)%/)[1]);
  assert.ok(Math.abs(width - 84) < 0.000001);
  assert.match(html, /76 lượt đánh giá/);
  assert.doesNotMatch(html, /Amazon ·|Dữ liệu cũ|Quan sát:/);
  for (const file of ['product-card.tsx', 'product-detail.tsx']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /<AmazonStars product=/);
  }
});

test('unknown or invalid ratings never produce invented stars', () => {
  for (const amazon of [null, { averageStars: NaN, ratingsCount: -1 }]) {
    assert.equal(renderToStaticMarkup(createElement(AmazonStars, { product: { amazon } })), '');
  }
});
