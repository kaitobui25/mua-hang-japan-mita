import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { readTranslationPolicy, updateTranslationPolicy } from '../src/translation/policy.js';
import { repairLegacyName, legacyNameManifest, type LegacyNameReview } from '../src/translation/legacy-repair.js';
import { saveNamesIfCurrent, nameHash } from '../src/translation/jobs.js';
import { translateNamesBatch, TranslationUnavailable } from '../src/translation/openrouter.js';

test('policy defaults OFF, requires owner, uses version CAS and audits atomically', async () => {
  const statements: string[] = [];
  let conflict = false;
  const connection = { query: async (sql: string) => {
    statements.push(sql);
    return { rows: sql.includes('RETURNING version') && !conflict ? [{ version: 2 }] : [] };
  } } as unknown as Pick<PoolClient, 'query'>;
  assert.deepEqual(await readTranslationPolicy(connection), { validateTranslationSemantics: false, version: 0 });
  const input = { actorId: 'owner-1', role: 'owner', expectedVersion: 1, validateTranslationSemantics: true };
  await assert.rejects(updateTranslationPolicy(connection, { ...input, role: 'staff' }), /owner_required/);
  assert.deepEqual(await updateTranslationPolicy(connection, input), { validateTranslationSemantics: true, version: 2 });
  assert.ok(statements.some(sql => sql.includes('INSERT INTO translation_policy_audit')));
  assert.equal(statements.at(-1), 'COMMIT');
  conflict = true;
  await assert.rejects(updateTranslationPolicy(connection, input), /settings_version_conflict/);
  assert.equal(statements.at(-1), 'ROLLBACK');
});

test('name persistence gates new warnings with ON and never updates an existing success', async () => {
  for (const enabled of [false, true]) for (const status of ['warning', 'success']) {
    let writes = 0;
    const source = { name: 'DHC 300mg', brand: 'DHC' };
    const connection = { query: async (sql: string) => {
      if (sql.includes('FROM translation_settings')) return { rows: [{ validate_translation_semantics: enabled, version: 1 }] };
      if (sql.includes('SELECT p.asin')) return { rows: [{ asin: 'B000000001', ...source,
        status, translated_name: 'old candidate', name_source: source }] };
      if (sql.includes('INSERT INTO product_translations')) writes++;
      return { rows: [] };
    } } as unknown as PoolClient;
    assert.equal(await saveNamesIfCurrent([{ asin: 'B000000001', hash: nameHash(source),
      name: ' DHC 400g ', issues: ['numbers_changed'] }], 'mock', connection), enabled || status === 'success' ? 0 : 1);
    assert.equal(writes, enabled || status === 'success' ? 0 : 1);
  }
});

test('six-ASIN repair previews, applies once, preserves candidates/issues/budgets and rejects stale review', async () => {
  assert.equal(Object.keys(legacyNameManifest).length, 6);
  for (const [asin, issue] of Object.entries(legacyNameManifest)) {
    let receipt = false, writes = 0, matches = true;
    const connection = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT asin FROM translation_name_repairs')) return { rows: receipt ? [{ asin }] : [] };
      if (sql.includes('FOR UPDATE')) return { rows: matches ? [{ asin }] : [] };
      if (sql.includes('UPDATE product_translations')) {
        writes++; assert.equal(params?.[1], issue ? 'warning' : 'pending');
        assert.equal(params?.[2], issue ? 3 : 2);
        assert.doesNotMatch(sql, /SET name=|name_issues=/);
      }
      if (sql.includes('INSERT INTO translation_name_repairs')) receipt = true;
      return { rows: [] };
    } } as unknown as Pick<PoolClient, 'query'>;
    const review: LegacyNameReview = { asin: asin as LegacyNameReview['asin'], source_hash: 'reviewed-hash',
      name: issue ? ' Candidate 400g ' : null, name_source: null, source: { name: 'Source 300mg', brand: null },
      name_issues: issue ? [issue] : [], name_attempts: 3, status: 'failed',
      ...(!issue ? { grantMissingRetry: true as const } : {}) };
    assert.equal(await repairLegacyName(connection, review), 'preview'); assert.equal(writes, 0);
    assert.equal(await repairLegacyName(connection, review, true), 'repaired');
    assert.equal(await repairLegacyName(connection, review, true), 'already_repaired'); assert.equal(writes, 1);
    receipt = false; matches = false;
    await assert.rejects(repairLegacyName(connection, review, true), /repair_precondition_changed/);
    if (!issue) await assert.rejects(repairLegacyName(connection, { ...review, grantMissingRetry: undefined }), /missing_retry_budget/);
  }
});

test('name transport blocks HTML and rejects the whole batch on wrong ASIN or malformed/truncated JSON', async () => {
  const products = [{ asin: 'B000000001', name: 'DHC 300mg', brand: 'DHC' }];
  for (const name of ['<b>text</b>', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)']) {
    const result = await translateNamesBatch(products, { apiKey: 'mock', fetcher: async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [{ asin: products[0].asin, name }] }) } }]
    }) });
    assert.equal(result.names.size, 0); assert.deepEqual(result.rejectedAsins, [products[0].asin]);
  }
  for (const [content, finish_reason] of [
    ['{"translations":[{"asin":"B000000002","name":"DHC 300mg"}]}', 'stop'],
    ['{"translations":', 'stop'], ['{"translations":[]}', 'length']
  ]) await assert.rejects(translateNamesBatch(products, { apiKey: 'mock', fetcher: async () => Response.json({
    choices: [{ finish_reason, message: { content } }]
  }) }), TranslationUnavailable);
});
