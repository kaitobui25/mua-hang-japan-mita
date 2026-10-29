import { db } from '../db/pool.js';
import { FREE_TRANSLATION_MODELS, readFreeQuota } from './openrouter.js';
import { usableTranslation } from './warnings.js';
import type { PoolClient } from 'pg';

export type TitleInput = {
  asin: string; sourceName: string; translatedName: string; brand: string | null;
};
export type TitlePresentation = {
  shortName: string;
  /** Exact excerpts from the previously translated name, not new model claims. */
  omittedFacts: string[];
};
type TitleRow = TitleInput & { previousSource: string | null; previousTranslation: string | null };

/** Keep the complete previous Vietnamese and Amazon titles available for search. */
export function validateTitlePresentation(input: TitleInput, candidate: unknown): TitlePresentation {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid_title_json');
  const value = candidate as Record<string, unknown>;
  const shortName = usableTranslation(value.shortName, 120).trim();
  if (shortName.length < 8) throw new Error('title_too_short');
  if (!Array.isArray(value.omittedFacts) || value.omittedFacts.length > 12) throw new Error('invalid_omitted_facts');
  const facts = value.omittedFacts.map(fact => usableTranslation(fact, 500).trim());
  if (new Set(facts).size !== facts.length ||
      facts.some(fact => !input.translatedName.includes(fact))) throw new Error('unsourced_omitted_fact');
  // A concise title may delete or regroup source words, but cannot introduce
  // new health claims, ingredients, variants, or model names. Even with the
  // semantic warning toggle OFF, factual omission must stay lossless.
  const words = (text: string) => text.normalize('NFKC').toLocaleLowerCase('vi-VN')
    .match(/[\p{L}\p{N}]+(?:[.,\-][\p{L}\p{N}]+)*/gu) ?? [];
  const available = new Map<string, number>();
  for (const word of words(input.translatedName)) {
    available.set(word, (available.get(word) ?? 0) + 1);
  }
  for (const word of words(shortName)) {
    const count = available.get(word) ?? 0;
    if (count === 0) throw new Error('title_claim_not_in_source');
    available.set(word, count - 1);
  }
  if (input.brand && input.sourceName.toLowerCase().includes(input.brand.toLowerCase()) &&
      !shortName.toLowerCase().includes(input.brand.toLowerCase())) throw new Error('brand_missing');
  // A model cannot silently turn 900 g into 90 g, or omit model/pack identifiers.
  // Very number-heavy titles stay long if preserving all identifiers is impractical.
  const numbers = (text: string) => [...text.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)*/g)]
    .map(match => match[0].replaceAll(',', '.')).sort();
  const expected = numbers(input.translatedName);
  if (expected.length > 4 || JSON.stringify(expected) !== JSON.stringify(numbers(shortName))) {
    throw new Error('identity_numbers_changed');
  }
  return { shortName, omittedFacts: facts };
}

const prompt = `Create a concise natural Vietnamese product TITLE from a long, previously translated
Amazon title. Keep brand, product identity, variant, all quantities/pack sizes/model numbers,
and numerical facts exactly. Do not invent features, efficacy or medical claims. Omit only
secondary marketing phrases. Return ONLY JSON {"shortName":"...","omittedFacts":["..."]}.
Every omittedFacts item MUST be an exact substring of translatedName supplied below;
never paraphrase or fabricate the omittedFacts. Keep the shortName <=120 characters.
If shortening would lose identifying facts, return the original translatedName unchanged
with omittedFacts: [].`;

export async function proposeCompactTitle(input: TitleInput, options: {
  apiKey?: string; fetcher?: typeof fetch; beforeRequest?: () => Promise<void>;
} = {}): Promise<{ presentation: TitlePresentation; model: string }> {
  const key = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('missing_openrouter_key');
  const fetcher = options.fetcher ?? fetch;
  for (const model of FREE_TRANSLATION_MODELS) {
    if (model === 'thinkingmachines/inkling-small:free') continue;
    await options.beforeRequest?.();
    const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model, temperature: 0, reasoning: { enabled: false }, max_tokens: 600,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }]
      })
    });
    if ([401, 402, 429].includes(response.status)) throw new Error(`provider_unavailable_${response.status}`);
    if (!response.ok) continue;
    const payload = await response.json() as {
      choices?: { finish_reason?: string; message?: { content?: string } }[];
    };
    if (payload.choices?.[0]?.finish_reason !== 'stop') throw new Error('incomplete_compact_title');
    const text = payload.choices[0]?.message?.content;
    if (!text || text.length > 4000) throw new Error('invalid_compact_title');
    return { presentation: validateTitlePresentation(input, JSON.parse(text)), model };
  }
  throw new Error('compact_title_provider_unavailable');
}

/** Compare-and-swap against source AND accepted full Vietnamese name. */
export async function saveCompactTitle(input: TitleInput, title: TitlePresentation, model: string,
  client: Pick<PoolClient, 'query'> = db): Promise<boolean> {
  const verified = validateTitlePresentation(input, title);
  const saved = await client.query(`INSERT INTO product_title_presentations
      (asin,source_name,translated_name,short_name,omitted_facts,model,updated_at)
    SELECT p.asin,p.name,t.name,$4,$5::jsonb,$6,now()
    FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
    WHERE p.asin=$1 AND p.name=$2 AND t.name=$3 AND t.status IN ('success','warning')
    ON CONFLICT (asin) DO UPDATE SET
      source_name=EXCLUDED.source_name,translated_name=EXCLUDED.translated_name,
      short_name=EXCLUDED.short_name,omitted_facts=EXCLUDED.omitted_facts,
      model=EXCLUDED.model,updated_at=now()
    RETURNING asin`,
    [input.asin, input.sourceName, input.translatedName, verified.shortName, JSON.stringify(verified.omittedFacts), model]);
  return Boolean(saved.rowCount);
}

const productSpecificIssues = new Set([
  'invalid_title_json','title_too_short','invalid_omitted_facts',
  'unsourced_omitted_fact','brand_missing','identity_numbers_changed',
  'title_claim_not_in_source','invalid_output'
]);

export function isCompactTitleProductIssue(error: unknown): boolean {
  return error instanceof Error && productSpecificIssues.has(error.message);
}

async function recordCompactTitleIssue(input: TitleInput, issue: string, client: Pick<PoolClient, 'query'>) {
  await client.query(`INSERT INTO product_title_attempts
      (asin,source_name,translated_name,attempts,last_issue)
    SELECT p.asin,p.name,t.name,1,$4
    FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
    WHERE p.asin=$1 AND p.name=$2 AND t.name=$3
    ON CONFLICT(asin) DO UPDATE SET
      attempts=CASE WHEN product_title_attempts.source_name=EXCLUDED.source_name
        AND product_title_attempts.translated_name=EXCLUDED.translated_name
        THEN LEAST(3,product_title_attempts.attempts+1) ELSE 1 END,
      source_name=EXCLUDED.source_name,translated_name=EXCLUDED.translated_name,
      last_issue=EXCLUDED.last_issue,updated_at=now()`,
    [input.asin,input.sourceName,input.translatedName,issue]);
}

/** Small, quota-bound backfill; never rewrites existing successful translations. */
export async function compactPendingTitles(options: {
  connect?: () => Promise<PoolClient>; quota?: typeof readFreeQuota;
  translate?: typeof proposeCompactTitle; maxProducts?: number;
} = {}): Promise<{ saved: number; deferred: number }> {
  if (!process.env.OPENROUTER_API_KEY) return { saved: 0, deferred: 0 };
  const client = await (options.connect ?? (() => db.connect()))();
  let locked = false;
  try {
    locked = Boolean((await client.query('SELECT pg_try_advisory_lock(70400300) AS ok')).rows[0]?.ok);
    if (!locked) return { saved: 0, deferred: 0 };
    const quota = await (options.quota ?? readFreeQuota)();
    let remaining = Math.min(options.maxProducts ?? 20, Math.max(0, quota.remaining - 2));
    if (!remaining) return { saved: 0, deferred: 0 };
    const result = await client.query<TitleRow>(`SELECT p.asin,p.name AS "sourceName",
        p.brand,t.name AS "translatedName",pt.source_name AS "previousSource",
        pt.translated_name AS "previousTranslation"
      FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
      LEFT JOIN product_title_presentations pt ON pt.asin=p.asin
      LEFT JOIN product_title_attempts a ON a.asin=p.asin
      WHERE t.status IN ('success','warning') AND t.name IS NOT NULL
        AND (pt.asin IS NULL OR pt.source_name IS DISTINCT FROM p.name
          OR pt.translated_name IS DISTINCT FROM t.name)
        AND (a.asin IS NULL OR a.source_name IS DISTINCT FROM p.name
          OR a.translated_name IS DISTINCT FROM t.name OR a.attempts<3)
      ORDER BY p.asin LIMIT $1`, [remaining]);
    let saved = 0, deferred = 0;
    for (const row of result.rows) {
      try {
        const { presentation, model } = await (options.translate ?? proposeCompactTitle)(row, {
          beforeRequest: async () => {
            if (--remaining < 0) throw new Error('free_quota_exhausted');
          }
        });
        if (await saveCompactTitle(row, presentation, model, client)) saved++;
        else deferred++;
      } catch (error) {
        deferred++;
        if (isCompactTitleProductIssue(error)) {
          // Record an explicit per-source attempt and let later ASINs progress.
          await recordCompactTitleIssue(row, (error as Error).message, client);
          continue;
        }
        // Shared quota/provider failures are deferred, not incorrectly marked
        // as permanently bad source data.
        break;
      }
    }
    return { saved, deferred };
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(70400300)'); }
    finally { client.release(); }
  }
}
