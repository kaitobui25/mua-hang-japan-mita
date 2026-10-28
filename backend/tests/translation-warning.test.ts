import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../src/db/pool.js';
import { assessTranslation, logTranslationEvent, warningLogPath, type TranslationWarningEvent } from '../src/translation/warnings.js';
import { validateAtomicTranslation, LocalTranslationError } from '../src/translation/local.js';
import { translatePendingNames, saveNamesIfCurrent, nameHash, saveTranslationIfCurrent, sourceHash, sourceText, markDetailTranslationFailed } from '../src/translation/jobs.js';
import { translatePendingDetails } from '../src/translation/detail-jobs.js';
import { applyTranslations } from '../src/translation/catalog.js';

after(async () => { if (!db.ending) await db.end(); });

test('shared contract retains usable semantic errors verbatim but blocks structural garbage', () => {
  for (const candidate of [' Wrong 400g ', '成分 300mg', 'Other AB-5678 300mg']) {
    const result = assessTranslation('成分 AB-1234 300mg', candidate, validateAtomicTranslation);
    assert.equal(result.text, candidate);
    assert.ok(result.issues.length);
  }
  for (const candidate of ['', null, '{"text":"candidate"}', '["candidate"]', '```text', '<think>reason</think>answer']) {
    assert.throws(() => assessTranslation('成分', candidate, validateAtomicTranslation), /invalid_output/);
  }
});

test('append-only UTF-8 JSONL records only the explicit contract at repository runtime path', async () => {
  assert.equal(warningLogPath, resolve('..', '.agents/runtime/translation-warnings.jsonl'));
  const directory = await mkdtemp(join(tmpdir(), 'mita-warning-'));
  try {
    const path = join(directory, 'nested', 'warnings.jsonl');
    const event = { asin: 'B000000001', locale: 'vi' as const, field: 'features:0', engine: 'gguf', model: 'fixture',
      attempt: 2, original: '成分 300mg', candidate: 'Thành phần 400mg', issues: ['facts_changed'], result: 'warning' as const,
      Authorization: 'secret', responseBody: 'private' };
    await logTranslationEvent(event, path);
    const first = await readFile(path, 'utf8');
    await logTranslationEvent({ ...event, attempt: 3 }, path);
    const all = await readFile(path, 'utf8');
    assert.ok(all.startsWith(first));
    const rows = all.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].original, event.original);
    assert.equal(rows[1].attempt, 3);
    assert.ok(rows[0].timestamp);
    assert.doesNotMatch(all, /secret|private|Authorization|responseBody/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture() {
  const asin = `W${randomBytes(5).toString('hex').toUpperCase().slice(0,9)}`;
  const client = await db.connect();
  await client.query(`INSERT INTO products(asin,category_slug,name,brand,source_url,source_adapter)
    VALUES($1,'thuc-pham-bo-sung','DHC 成分 300mg','DHC',$2,'fixture')`, [asin, `https://www.amazon.co.jp/dp/${asin}`]);
  await client.query(`INSERT INTO product_details(asin,features,specs,source_observed_at,provenance)
    VALUES($1,'["成分 300mg"]',$2,now(),'{}')`, [asin, JSON.stringify({ '容量': ' ３０錠\r\n日本語 300mg ', Label: 'unchanged' })]);
  const events: TranslationWarningEvent[] = [];
  const query = client.query.bind(client);
  const connection = {
    query: async (sql: string, values?: unknown[]) => {
      // This suite tests translation semantics, not lock contention (covered elsewhere).
      // Avoid conflicting with other concurrently executed test files.
      if (sql.includes('pg_try_advisory_lock(70400300)')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock(70400300)')) return { rows: [{ pg_advisory_unlock: true }] };
      const result = await query(sql, values);
      // Restrict worker discovery to this fixture; every persistence query is real PostgreSQL.
      if (sql.includes('SELECT p.asin') && !sql.includes('ANY(')) result.rows = result.rows.filter(row => row.asin === asin);
      return result;
    }, release: () => {}
  } as unknown as PoolClient;
  return { asin, client, connect: async () => connection, log: async (event: TranslationWarningEvent) => { events.push(event); }, events,
    cleanup: async () => { await client.query('DELETE FROM products WHERE asin=$1', [asin]); client.release(); } };
}

test('name warning survives source change and failed retry, improves once, then becomes immutable', async t => {
  const f = await fixture();
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-only';
  let output = ' DHC thành phần 400g ', outage = false, calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/key')) return Response.json({ data: { free_model_daily_requests: { remaining: 50, limit: 50, used: 0 } } });
    calls++;
    if (outage) return new Response('', { status: 401 });
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.equal(input[0].name, 'DHC 成分 300mg', 'warned name uses the frozen source');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [{ asin: f.asin, name: output }] }) } }] });
  });
  try {
    await translatePendingNames(f);
    let row = (await f.client.query('SELECT * FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
    assert.equal(row.status, 'warning'); assert.equal(row.name, output); assert.equal(row.name_attempts, 1);
    await f.client.query("UPDATE products SET name='Changed source 900g' WHERE asin=$1", [f.asin]);
    outage = true;
    await translatePendingNames(f);
    row = (await f.client.query('SELECT * FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
    assert.equal(row.status, 'warning'); assert.equal(row.name, output); assert.equal(row.name_attempts, 2);
    outage = false; output = 'DHC thành phần 300mg';
    await translatePendingNames(f);
    row = (await f.client.query('SELECT * FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
    assert.equal(row.status, 'success'); assert.deepEqual(row.name_issues, []); assert.equal(row.name_attempts, 3);
    await translatePendingNames(f); assert.equal(calls, 3);
    assert.deepEqual(f.events.map(e => e.result), ['warning','failed','success']);
    assert.ok(f.events.every(e => e.model));
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; await f.cleanup(); }
});

test('warned detail retries at most three times, retains latest usable text and exact spec values', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const translate = async (source: string) => {
      calls++;
      if (source === '容量') return { text: 'Label', model: 'fixture' }; // collision must retain both values
      return { text: `Thành phần ${300 + calls}g`, model: 'fixture' };
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await translatePendingDetails({ ...f, translate });
      await f.client.query('UPDATE local_detail_translation_items SET retry_after=NULL WHERE asin=$1', [f.asin]);
    }
    assert.equal(calls, 4, 'one approved key plus three warned feature attempts');
    const row = (await f.client.query("SELECT * FROM local_detail_translation_items WHERE asin=$1 AND slot='features:0'", [f.asin])).rows[0];
    assert.equal(row.attempts, 3); assert.equal(row.warning, true); assert.equal(row.translated, 'Thành phần 304g');
    await f.client.query(`UPDATE product_details SET features='["Changed source"]',specs='{}' WHERE asin=$1`, [f.asin]);
    await translatePendingDetails({ ...f, translate }); assert.equal(calls, 4);
    const products = [{ asin: f.asin, name: 'Source', brand: null, detail: {
      features: [], ingredients: [], usage: [], cautions: [], specs: {}, variantAttributes: {}, childAsins: [],
      sourceObservedAt: '', provenance: { sourceUrl: '', adapter: 'fixture', sections: [] }
    } }];
    await applyTranslations(products, f.client);
    assert.equal(products[0].detail.features[0], row.translated);
    assert.equal(Object.keys(products[0].detail.specs).length, 2);
    assert.deepEqual(Object.values(products[0].detail.specs).sort(), [' ３０錠\r\n日本語 300mg ', 'unchanged'].sort());
  } finally { await f.cleanup(); }
});

test('no-output legacy detail respects existing cap, warned output survives outage, then approval freezes it', async () => {
  const f = await fixture();
  try {
    await translatePendingDetails({ ...f, translate: async source => ({ text: source === '容量' ? 'Dung lượng' : '400g', model: 'fixture' }) });
    await f.client.query("UPDATE local_detail_translation_items SET retry_after=NULL WHERE asin=$1", [f.asin]);
    await translatePendingDetails({ ...f, translate: async () => { throw new LocalTranslationError(true, 'local_endpoint_unavailable'); } });
    const warned = (await f.client.query("SELECT translated,warning,attempts FROM local_detail_translation_items WHERE asin=$1 AND slot='features:0'", [f.asin])).rows[0];
    assert.deepEqual(warned, { translated: '400g', warning: true, attempts: 2 });
    await f.client.query('UPDATE local_detail_translation_items SET retry_after=NULL WHERE asin=$1', [f.asin]);
    await translatePendingDetails({ ...f, translate: async () => ({ text: 'Thành phần 300mg', model: 'fixture' }) });
    await translatePendingDetails({ ...f, translate: async () => { assert.fail('approved output retried'); } });
    await f.client.query(`UPDATE local_detail_translation_items SET translated=NULL,warning=false,attempts=3 WHERE asin=$1`, [f.asin]);
    await translatePendingDetails({ ...f, translate: async () => { assert.fail('legacy exhausted failure retried'); } });
  } finally { await f.cleanup(); }
});

test('legacy full success cannot be replaced or revoked by later failures', async () => {
  const f = await fixture();
  try {
    const specs = (await f.client.query('SELECT specs FROM product_details WHERE asin=$1', [f.asin])).rows[0].specs;
    const source = sourceText({ name: 'DHC 成分 300mg', brand: 'DHC', features: ['成分 300mg'], ingredients: [], usage: [], cautions: [], specs });
    const output = { text: { ...source, name: 'DHC thành phần 300mg' }, model: 'fixture' };
    assert.equal(await saveTranslationIfCurrent(f.asin, sourceHash(source), output, f.client), true);
    assert.equal(await saveTranslationIfCurrent(f.asin, sourceHash(source), { ...output, text: { ...source, features: ['wrong'] } }, f.client), false);
    await markDetailTranslationFailed(f.asin, 'different-hash', f.client);
    const row = (await f.client.query('SELECT * FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
    assert.equal(row.status, 'success'); assert.deepEqual(row.detail, output.text);
    assert.equal(await saveNamesIfCurrent([{ asin: f.asin, hash: nameHash(source), name: 'wrong', issues: ['facts_changed'] }], 'fixture', f.client), 0);
  } finally { await f.cleanup(); }
});


test('legacy failed names get a clean counter, latest warning remains at cap, and model fallbacks count individually', async t => {
  for (const scenario of ['warning', 'outage'] as const) {
    await t.test(scenario, async t => {
      const f = await fixture();
      const previous = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'fixture-only';
      let calls = 0, now = 0;
      t.mock.method(Date, 'now', () => { now += 4000; return now; });
      t.mock.method(globalThis, 'fetch', async (url: unknown) => {
        if (String(url).endsWith('/key')) return Response.json({ data: { free_model_daily_requests: { remaining: 50, limit: 50, used: 0 } } });
        calls++;
        if (scenario === 'outage') return new Response('', { status: 503 });
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          translations: [{ asin: f.asin, name: `DHC ${calls}g` }]
        }) } }] });
      });
      try {
        await f.client.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name_only)
          VALUES($1,'vi','legacy','failed',true)`, [f.asin]);
        for (let run = 0; run < 4; run++) await translatePendingNames(f);
        assert.equal(calls, 3);
        const row = (await f.client.query('SELECT * FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
        assert.equal(row.name_attempts, 3);
        assert.equal(row.status, scenario === 'warning' ? 'warning' : 'failed');
        assert.equal(row.name, scenario === 'warning' ? 'DHC 3g' : null);
        assert.equal(f.events.length, 3);
        const products = [{ asin: f.asin, name: 'Original source', brand: null }];
        await applyTranslations(products, f.client);
        assert.equal(products[0].name, scenario === 'warning' ? 'DHC 3g' : 'Original source');
      } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; await f.cleanup(); }
    });
  }
});


test('additive schema replay preserves exhausted counters, warnings and legacy approvals', async () => {
  const f = await fixture();
  try {
    await f.client.query(`INSERT INTO product_translations(asin,locale,source_hash,status,name,name_only,name_attempts,name_issues)
      VALUES($1,'vi','frozen','warning','DHC 400g',true,3,'["units_changed"]')`, [f.asin]);
    await f.client.query(`INSERT INTO local_detail_translations(asin,snapshot) VALUES($1,'{}')`, [f.asin]);
    await f.client.query(`INSERT INTO local_detail_translation_items(asin,slot,source,attempts)
      VALUES($1,'features:0','original',3)`, [f.asin]);
    const schema = await readFile('src/db/schema.sql', 'utf8');
    await f.client.query(schema); await f.client.query(schema);
    const name = (await f.client.query('SELECT status,name,name_attempts,name_issues FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
    assert.deepEqual(name, { status: 'warning', name: 'DHC 400g', name_attempts: 3, name_issues: ['units_changed'] });
    const item = (await f.client.query('SELECT attempts FROM local_detail_translation_items WHERE asin=$1', [f.asin])).rows[0];
    assert.equal(item.attempts, 3);
    await f.client.query(`UPDATE product_translations SET status='success',name=NULL,name_only=false,detail='{"features":["Approved"]}' WHERE asin=$1`, [f.asin]);
    await f.client.query(schema);
    const legacy = (await f.client.query('SELECT detail_approved FROM product_translations WHERE asin=$1', [f.asin])).rows[0];
    assert.equal(legacy.detail_approved, true);
    await f.client.query(`UPDATE product_translations SET status='warning',name='Warned title' WHERE asin=$1`, [f.asin]);
    await translatePendingDetails({ ...f, translate: async () => { assert.fail('approved legacy detail retried for warned title'); } });
  } finally { await f.cleanup(); }
});
