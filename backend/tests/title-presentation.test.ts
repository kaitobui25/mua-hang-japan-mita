import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { applyTitlePresentations } from '../src/translation/title-presentation.js';

test('uses source-matched short titles and retains full translated text as extras', async () => {
  const products = [{ asin: 'B000000001', name: 'Full title' },
    { asin: 'B000000002', name: 'Untouched title' }];
  const connection = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /p.name=pt.source_name/);
    assert.match(sql, /t.name=pt.translated_name/);
    assert.deepEqual(values[0], ['B000000001', 'B000000002']);
    return { rows: [{ asin: 'B000000001', short_name: 'DHC 300mg 60 viên',
      omitted_facts: ['hàng nhập Nhật'], translated_name: 'DHC 300mg 60 viên hàng nhập Nhật' }] };
  } } as unknown as Pick<PoolClient, 'query'>;
  await applyTitlePresentations(products, connection);
  assert.equal(products[0].name, 'DHC 300mg 60 viên');
  assert.equal(products[1].name, 'Untouched title');
  assert.deepEqual((products[0] as { titleExtras?: string[] }).titleExtras,
    ['hàng nhập Nhật', 'DHC 300mg 60 viên hàng nhập Nhật']);
});
