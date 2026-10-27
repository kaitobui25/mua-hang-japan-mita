// Runs only on the owner's Windows worker. Never deploy an API key to the web/API VPS.
export const FREE_TRANSLATION_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling-small:free',
  'nvidia/nemotron-3.5-lightning:free'
] as const;

export type ProductText = {
  name: string;
  brand?: string | null;
  features: string[];
  ingredients: string[];
  usage: string[];
  specs: Record<string, string>;
  cautions: string[];
};

export type TranslationResult = { text: ProductText; model: string };

const url = 'https://openrouter.ai/api/v1/chat/completions';
const maxInput = 10000;

type FreeQuota = { remaining: number; limit: number; used: number };

/** Read provider-account free quota without consuming an inference request. */
export async function readFreeQuota(apiKey = process.env.OPENROUTER_API_KEY, fetcher: typeof fetch = fetch): Promise<FreeQuota> {
  if (!apiKey) throw new TranslationUnavailable(['missing_api_key']);
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000)
    });
    if (response.status === 401) throw new TranslationUnavailable(['unauthorized_api_key']);
    if (!response.ok) throw new TranslationUnavailable(['quota_check_unavailable']);
    const payload = await response.json() as { data?: { free_model_daily_requests?: Partial<FreeQuota> } };
    const quota = payload.data?.free_model_daily_requests;
    if (!quota || !Number.isSafeInteger(quota.remaining) || !Number.isSafeInteger(quota.limit) || !Number.isSafeInteger(quota.used)) {
      throw new TranslationUnavailable(['quota_check_unavailable']);
    }
    return quota as FreeQuota;
  } catch (error) {
    if (error instanceof TranslationUnavailable) throw error;
    throw new TranslationUnavailable(['quota_check_unavailable']);
  }
}

function assertTranslation(source: ProductText, value: unknown): ProductText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_translation');
  const data = value as Record<string, unknown>;
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 600) throw new Error('invalid_name');
  const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map(n => n.replaceAll(',', '.')).sort();
  const measurements = (text: string) => {
    const normalized = text.normalize('NFKC').toLowerCase().replaceAll('μ', 'µ');
    // Reject changed dosage, weight, volume and other physical measurements.
    // NFKC accepts full-width Japanese units without allowing mg -> g.
    return [...normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*(mcg|µg|mg|kg|ml|mm|cm|kcal|kj|iu|g|l|m|%)(?!\p{L})/gu)]
      .map(match => `${match[1].replaceAll(',', '.')}:${match[2] === 'µg' ? 'mcg' : match[2]}`)
      .sort();
  };
  const productCodes = (text: string) => [...text.normalize('NFKC').matchAll(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]{4,}\b/gi)]
    .map(match => match[0].toUpperCase()).sort();
  const validateText = (original: string, translated: string) => {
    if (!translated.trim() || translated.length > 3000) throw new Error('invalid_text');
    if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(translated))) throw new Error('numbers_changed');
    if (JSON.stringify(measurements(original)) !== JSON.stringify(measurements(translated))) throw new Error('units_changed');
    if (JSON.stringify(productCodes(original)) !== JSON.stringify(productCodes(translated))) throw new Error('product_codes_changed');
  };
  validateText(source.name, data.name);
  if (source.brand && /[a-z]/i.test(source.brand) && !data.name.toLowerCase().includes(source.brand.toLowerCase()) && source.name.toLowerCase().includes(source.brand.toLowerCase())) {
    throw new Error('brand_changed');
  }
  const result: ProductText = { name: data.name.trim(), brand: source.brand ?? null, features: [], ingredients: [], usage: [], specs: {}, cautions: [] };
  for (const field of ['features', 'ingredients', 'usage', 'cautions'] as const) {
    if (!Array.isArray(data[field]) || data[field].length !== source[field].length) throw new Error('invalid_sections');
    result[field] = data[field].map((translated: unknown, i: number) => {
      if (typeof translated !== 'string') throw new Error('invalid_section');
      validateText(source[field][i], translated);
      return translated.trim();
    });
  }
  if (!data.specs || typeof data.specs !== 'object' || Array.isArray(data.specs)) throw new Error('invalid_specs');
  const specs = data.specs as Record<string, unknown>;
  if (JSON.stringify(Object.keys(specs).sort()) !== JSON.stringify(Object.keys(source.specs).sort())) throw new Error('invalid_spec_keys');
  for (const [key, original] of Object.entries(source.specs)) {
    if (typeof specs[key] !== 'string') throw new Error('invalid_spec');
    validateText(original, specs[key]);
    result.specs[key] = specs[key].trim();
  }
  return result;
}

function parseContent(content: unknown) {
  if (typeof content !== 'string') throw new Error('empty_content');
  const value = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(value) as unknown;
}

export class TranslationUnavailable extends Error {
  constructor(public readonly causes: string[]) {
    super('OpenRouter free translation unavailable');
  }
}

export async function translateProduct(
  source: ProductText,
  options: { apiKey?: string; fetcher?: typeof fetch; timeoutMs?: number; beforeRequest?: (model: string) => Promise<void>;
    unavailableModels?: Set<string> } = {}
): Promise<TranslationResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new TranslationUnavailable(['missing_api_key']);
  if (JSON.stringify(source).length > maxInput) throw new TranslationUnavailable(['source_too_large']);
  const fetcher = options.fetcher ?? fetch;
  const errors: string[] = [];
  const sourceJson = JSON.stringify(source);
  // A short title does not need a 3,000-token generation budget; a smaller
  // bounded completion makes free inference faster without truncating detail jobs.
  const maxTokens = Math.min(3000, Math.max(500, Math.ceil(sourceJson.length * 1.25)));
  for (const model of FREE_TRANSLATION_MODELS) {
    // The free Inkling endpoint is licensed for agentic harness use only, not this background translator.
    if (model === 'thinkingmachines/inkling-small:free') continue;
    if (options.unavailableModels?.has(model)) continue;
    try {
      await options.beforeRequest?.(model);
      const response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 45000),
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [
            { role: 'system', content: 'Translate Amazon Japan product text to Vietnamese. Produce ONLY a JSON object with the SAME keys and array sizes as the user JSON. Preserve brand names, product codes, numbers, units and exact factual meaning. Prefer Vietnamese vocabulary; if unavailable use English, then Japanese. Never invent product claims, dosages, ingredients or warnings. Keep specs keys unchanged. Return only JSON.' },
            { role: 'user', content: sourceJson }
          ]
        })
      });
      // Wrong shared credential cannot be repaired by selecting another model.
      if (response.status === 401) throw new TranslationUnavailable(['unauthorized_api_key']);
      if (!response.ok) {
        // OpenRouter-origin 429 has platform rate-limit headers. A different model cannot
        // bypass an exhausted shared quota, so defer the rest of this translation batch.
        if (response.status === 429 && response.headers.has('x-ratelimit-limit')) {
          throw new TranslationUnavailable(['rate_limit_platform']);
        }
        if (response.status === 402) throw new TranslationUnavailable(['account_budget_exhausted']);
        if (response.status === 403) {
          // Budget guardrails are shared; model-specific permissions are not.
          const body = await response.json().catch(() => null) as { error?: { metadata?: { limit_source?: unknown } } } | null;
          if (typeof body?.error?.metadata?.limit_source === 'string') {
            throw new TranslationUnavailable(['account_budget_exhausted']);
          }
        }
        // Don't burn the shared daily quota by retrying a provider that already
        // denied this session. Try it again on the next scheduled batch.
        if ([403, 429, 500, 502, 503, 504].includes(response.status)) options.unavailableModels?.add(model);
        errors.push(`${model}:http_${response.status}`);
        continue;
      }
      const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] };
      const translated = assertTranslation(source, parseContent(payload.choices?.[0]?.message?.content));
      return { text: translated, model };
    } catch (error) {
      if (error instanceof TranslationUnavailable) throw error;
      // No response body or headers are logged: providers may echo sensitive input.
      const isTimeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      if (isTimeout) options.unavailableModels?.add(model);
      errors.push(`${model}:${isTimeout ? 'timeout' : 'invalid_or_unavailable'}`);
    }
  }
  if (options.unavailableModels && FREE_TRANSLATION_MODELS.filter(model => model !== 'thinkingmachines/inkling-small:free').every(model => options.unavailableModels!.has(model))) {
    errors.push('providers_temporarily_unavailable');
  }
  throw new TranslationUnavailable(errors);
}
