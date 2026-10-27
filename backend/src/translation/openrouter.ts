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

function assertTranslation(source: ProductText, value: unknown): ProductText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_translation');
  const data = value as Record<string, unknown>;
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 600) throw new Error('invalid_name');
  const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map(n => n.replaceAll(',', '.')).sort();
  const validateText = (original: string, translated: string) => {
    if (!translated.trim() || translated.length > 3000) throw new Error('invalid_text');
    if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(translated))) throw new Error('numbers_changed');
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
  options: { apiKey?: string; fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<TranslationResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new TranslationUnavailable(['missing_api_key']);
  if (JSON.stringify(source).length > maxInput) throw new TranslationUnavailable(['source_too_large']);
  const fetcher = options.fetcher ?? fetch;
  const errors: string[] = [];
  for (const model of FREE_TRANSLATION_MODELS) {
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 45000),
        body: JSON.stringify({
          model,
          max_tokens: 3000,
          messages: [
            { role: 'system', content: 'Translate Amazon Japan product text to Vietnamese. Produce ONLY a JSON object with the SAME keys and array sizes as the user JSON. Preserve brand names, product codes, numbers, units and exact factual meaning. Prefer Vietnamese vocabulary; if unavailable use English, then Japanese. Never invent product claims, dosages, ingredients or warnings. Keep specs keys unchanged. Return only JSON.' },
            { role: 'user', content: JSON.stringify(source) }
          ]
        })
      });
      // Wrong shared credential cannot be repaired by selecting another model.
      if (response.status === 401) throw new TranslationUnavailable(['unauthorized_api_key']);
      if (!response.ok) {
        errors.push(`${model}:http_${response.status}`);
        continue;
      }
      const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] };
      const translated = assertTranslation(source, parseContent(payload.choices?.[0]?.message?.content));
      return { text: translated, model };
    } catch (error) {
      if (error instanceof TranslationUnavailable) throw error;
      // No response body or headers are logged: providers may echo sensitive input.
      errors.push(`${model}:${error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'invalid_or_unavailable'}`);
    }
  }
  throw new TranslationUnavailable(errors);
}
