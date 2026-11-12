import type { AmazonProductPreview, AmazonDisplay } from './amazon-quote-source.js';
import { get as httpsGet } from 'node:https';

/** Public product text only. Never send names, addresses, orders or payment data. */
export type AmazonVietnameseText = {
  title?: string; brand?: string; description?: string; features?: string[];
  ingredients?: string; usage?: string; warnings?: string;
  specifications?: { name: string; value: string }[];
  reviews?: { title?: string; body: string; rating?: number }[];
};

const japanese = /[\u3040-\u30ff\u3400-\u9fff]/u;
const cache = new Map<string, string>();
const LIMIT = 26000;

async function googleJson(url: URL, signal: AbortSignal, injected?: typeof fetch): Promise<unknown | null> {
  if (injected) {
    const response = await injected(url, { method: 'GET', cache: 'no-store',
      redirect: 'error', headers: { Accept: 'application/json' }, signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
    const raw = await response.text();
    return raw.length <= 12000 ? JSON.parse(raw) : null;
  }
  // Native HTTPS HTTP/1 works with Google on this Windows server; Node's fetch
  // HTTP client receives 429 in this environment. Never follow redirects,
  // retry 429, or change IPs/proxies.
  return new Promise<unknown | null>(resolve => {
    let done = false;
    const finish = (value: unknown | null) => { if (!done) { done = true; resolve(value); } };
    const req = httpsGet(url, { signal, timeout: 4500,
      headers: { Accept: 'application/json' } }, res => {
      if (res.statusCode !== 200 || !String(res.headers['content-type'] ?? '').includes('application/json')) {
        res.resume(); finish(null); return;
      }
      const parts: Buffer[] = [];
      let bytes = 0;
      res.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > 12000) { res.destroy(); finish(null); return; }
        parts.push(part);
      });
      res.on('end', () => {
        try { finish(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
        catch { finish(null); }
      });
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

/** The publicly accessible Google Translate web endpoint is unofficial and
 * may cease working. Treat failures as missing translation, never invented text. */
export async function googleTranslateText(source: string,
  request?: typeof fetch, signal?: AbortSignal): Promise<string | null> {
  if (!japanese.test(source)) return source;
  if (!source || source.length > 1100 || /[\u0000-\u001f\u007f]/.test(source)) return null;
  const hit = cache.get(source);
  if (hit) return hit;
  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({ client: 'gtx', sl: 'ja', tl: 'vi', dt: 't', q: source }).toString();
    const parsed: unknown = await googleJson(url, signal ?? AbortSignal.timeout(4500), request);
    const segments = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : null;
    if (!segments || !segments.length || !segments.every((row: unknown) =>
      Array.isArray(row) && typeof row[0] === 'string')) return null;
    const result = segments.map((row: unknown) => (row as string[])[0]).join('').trim();
    if (!result || result.length > source.length * 5 + 100) return null;
    if (cache.size >= 400) cache.delete(cache.keys().next().value!);
    cache.set(source, result);
    return result;
  } catch { return null; }
}

/** Translate visible fields without changing the trusted original snapshot. */
export async function translateAmazonPreview(source: Pick<AmazonProductPreview, 'title' | 'observedDetails' | 'display'>):
  Promise<AmazonVietnameseText | undefined> {
  // Integration tests use synthetic source documents and must never contact Google.
  if (process.env.MITA_DISPOSABLE_TEST_DATABASE) return;
  const display: Omit<AmazonDisplay, 'provenance'> | undefined = source.display ?? source.observedDetails;
  const deadline = AbortSignal.timeout(7500);
  let budget = LIMIT;
  const items: { input: string; set: (text: string) => void }[] = [];
  const translated: AmazonVietnameseText = {};
  const queue = (input: string | undefined, assign: (text: string) => void) => {
    if (!input || !japanese.test(input) || budget <= 0) return;
    if (input.length > budget) return;
    budget -= input.length;
    items.push({ input, set: assign });
  };
  queue(source.title, text => { translated.title = text; });
  queue(display?.brand, text => { translated.brand = text; });
  queue(display?.description, text => { translated.description = text; });
  display?.features?.forEach((value, index) => queue(value, text => {
    (translated.features ??= [...display.features!])[index] = text;
  }));
  queue(display?.ingredients, text => { translated.ingredients = text; });
  queue(display?.usage, text => { translated.usage = text; });
  queue(display?.warnings, text => { translated.warnings = text; });
  display?.specifications?.forEach((value, index) => {
    queue(value.name, text => {
      (translated.specifications ??= display.specifications!.map(v => ({ ...v })))[index].name = text;
    });
    queue(value.value, text => {
      (translated.specifications ??= display.specifications!.map(v => ({ ...v })))[index].value = text;
    });
  });
  display?.reviews?.forEach((value, index) => {
    queue(value.title, text => {
      (translated.reviews ??= display.reviews!.map(v => ({ ...v })))[index].title = text;
    });
    queue(value.body, text => {
      (translated.reviews ??= display.reviews!.map(v => ({ ...v })))[index].body = text;
    });
  });
  // Strings are split at Unicode code-point boundaries; each request is
  // small enough for the free GET service. On partial failures keep original.
  let position = 0;
  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    while (position < items.length && !deadline.aborted) {
      const job = items[position++];
      const chars = Array.from(job.input);
      const parts: string[] = [];
      let ok = true;
      for (let offset = 0; offset < chars.length; offset += 450) {
        if (deadline.aborted) { ok = false; break; }
        const sourcePart = chars.slice(offset, offset + 450).join('');
        const vi = await googleTranslateText(sourcePart, undefined, deadline);
        if (!vi) { ok = false; break; }
        parts.push(vi);
      }
      if (ok && parts.length) job.set(parts.join(''));
    }
  });
  await Promise.all(workers);
  return Object.keys(translated).length ? translated : undefined;
}
