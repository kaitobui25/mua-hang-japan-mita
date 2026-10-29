import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTitlePresentation, proposeCompactTitle, saveCompactTitle, isCompactTitleProductIssue, compactPendingTitles } from '../src/translation/compact-title.js';
import type { PoolClient } from 'pg';

const input = {
  asin: 'B000000001', sourceName: 'DHC 300mg 60 tablets Japanese item',
  translatedName: 'DHC 300mg 60 viên thực phẩm bổ sung nhập từ Nhật Bản', brand: 'DHC'
};

test('compact title retains brand and identifying numbers while omitted facts are sourced', () => {
  assert.deepEqual(validateTitlePresentation(input, {
    shortName: 'DHC 300mg 60 viên', omittedFacts: ['thực phẩm bổ sung nhập từ Nhật Bản']
  }), { shortName: 'DHC 300mg 60 viên', omittedFacts: ['thực phẩm bổ sung nhập từ Nhật Bản'] });
  for (const candidate of [
    { shortName: 'DHC 30mg 60 viên', omittedFacts: [] },
    { shortName: 'DHC 300mg 60 viên', omittedFacts: ['Công dụng chữa bệnh'] },
    { shortName: 'DHC 300mg 60 viên chữa bệnh', omittedFacts: [] },
    { shortName: '<script>alert(1)</script> DHC 300mg 60 viên', omittedFacts: [] },
    { shortName: 'Viên 300mg 60 viên', omittedFacts: [] }
  ]) assert.throws(() => validateTitlePresentation(input, candidate));
});

test('OpenRouter compact title accepts only structurally valid sourced JSON', async () => {
  const reply = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    shortName: 'DHC 300mg 60 viên', omittedFacts: ['thực phẩm bổ sung nhập từ Nhật Bản']
  }) } }] };
  const result = await proposeCompactTitle(input, { apiKey: 'fake', fetcher: async () => Response.json(reply) });
  assert.equal(result.presentation.shortName, 'DHC 300mg 60 viên');
  await assert.rejects(proposeCompactTitle(input, { apiKey: 'fake', fetcher: async () =>
    Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }));
});

test('CAS persists title and source snapshot without overwriting original translation', async () => {
  let sql = '', args: unknown[] = [];
  const client = { query: async (statement: string, values: unknown[]) => {
    sql = statement; args = values; return { rowCount: 1 };
  } } as unknown as Pick<PoolClient, 'query'>;
  assert.equal(await saveCompactTitle(input, {
    shortName: 'DHC 300mg 60 viên', omittedFacts: ['thực phẩm bổ sung nhập từ Nhật Bản']
  }, 'test-model', client), true);
  assert.match(sql, /p.name=\$2 AND t.name=\$3/);
  assert.doesNotMatch(sql, /UPDATE product_translations/);
  assert.equal(args[1], input.sourceName);
  assert.equal(args[2], input.translatedName);
});

test('invalid source-specific candidates are classified separately from provider outages', () => {
  assert.equal(isCompactTitleProductIssue(new Error('identity_numbers_changed')), true);
  assert.equal(isCompactTitleProductIssue(new Error('title_claim_not_in_source')), true);
  assert.equal(isCompactTitleProductIssue(new Error('provider_unavailable_429')), false);
});

test('one unshortenable ASIN records its failure and does not starve later titles', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-only-key';
  const statements: string[] = [];
  const candidates = [
    { ...input, asin: 'B000000001' },
    { ...input, asin: 'B000000002' }
  ];
  const connection = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
      if (sql.includes('LEFT JOIN product_title_attempts')) return { rows: candidates };
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined
  } as unknown as PoolClient;
  try {
    const result = await compactPendingTitles({
      connect: async () => connection,
      quota: async () => ({ remaining: 9, limit: 10, used: 1 }),
      maxProducts: 2,
      translate: async row => {
        if (row.asin === 'B000000001') throw new Error('identity_numbers_changed');
        return { presentation: {
          shortName: 'DHC 300mg 60 viên', omittedFacts: ['thực phẩm bổ sung nhập từ Nhật Bản']
        }, model: 'mock' };
      }
    });
    assert.deepEqual(result, { saved: 1, deferred: 1 });
    assert.ok(statements.some(sql => sql.includes('INSERT INTO product_title_attempts')));
    assert.ok(statements.some(sql => sql.includes('INSERT INTO product_title_presentations')));
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});
