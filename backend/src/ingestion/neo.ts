import { parseDetail, normalizeAmazonInput } from './detail.js';
import { config } from '../config.js';
import { parseJpy, SourceError, type Observation } from './source.js';

type RpcResult = { result?: { structuredContent?: { ok?: boolean; value?: unknown; logs?: string[] }; content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };

type NeoItem = { asin?: string; name?: string; imageUrl?: string; rawPrice?: string; parentAsin?: string; sourceProductId?: string };

export function parseNeoOutcome(value: unknown, categorySlug: string): Observation[] {
  if (!value || typeof value !== 'object') throw new SourceError('parse_error', 'BrowserOS Neo returned unexpected data', 'browseros-neo');
  const outcome = value as { blocked?: boolean; items?: unknown };
  if (outcome.blocked) throw new SourceError('blocked', 'Amazon browser CAPTCHA/sign-in requires human verification', 'browseros-neo');
  if (!Array.isArray(outcome.items)) throw new SourceError('parse_error', 'BrowserOS Neo returned no product list', 'browseros-neo');
  const unique = new Map<string, Observation>();
  const observedAt = new Date().toISOString();
  for (const item of outcome.items as NeoItem[]) {
    if (!item.asin || !/^[A-Z0-9]{10}$/.test(item.asin) || !item.name || unique.has(item.asin)) continue;
    unique.set(item.asin, {
      asin: item.asin, name: item.name.slice(0, 500), categorySlug, sourceAdapter: 'browseros-neo', observedAt,
      sourceUrl: `https://www.amazon.co.jp/dp/${item.asin}`,
      parentAsin: item.parentAsin && /^[A-Z0-9]{10}$/.test(item.parentAsin) ? item.parentAsin : null,
      sourceProductId: item.sourceProductId && /^[A-Za-z0-9_-]{3,64}$/.test(item.sourceProductId) ? item.sourceProductId : null,
      imageUrl: item.imageUrl?.startsWith('https://') ? item.imageUrl : null,
      priceJpy: parseJpy(item.rawPrice ?? '')
    });
  }
  if (!unique.size) throw new SourceError('parse_error', 'BrowserOS Neo extracted no valid products', 'browseros-neo');
  return [...unique.values()];
}

// BrowserOS Neo is a local-only fallback for JS markup changes. A challenge
// tab is ONLY for a person to verify; it never scrapes or solves CAPTCHA.
async function callNeoTool(name: string, args: Record<string, unknown>): Promise<RpcResult> {
  let session = '';
  let nextId = 0;
  async function rpc(method: string, params: Record<string, unknown>, notification = false): Promise<RpcResult> {
    const response = await fetch(config.neoUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++nextId } : {}), method, params })
    });
    session = response.headers.get('mcp-session-id') ?? session;
    if (!response.ok) throw new Error(`BrowserOS Neo MCP HTTP ${response.status}`);
    const text = await response.text();
    if (notification) return {};
    const messages = text.startsWith('data:') || text.includes('\ndata:')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as RpcResult)
      : [JSON.parse(text) as RpcResult];
    const message = messages.at(-1);
    if (!message || message.error) throw new Error(`BrowserOS Neo RPC error: ${message?.error?.message ?? 'empty response'}`);
    return message;
  }

  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mita-catalog', version: '0.1.0' } });
    await rpc('notifications/initialized', {}, true);
  } catch (error) {
    throw new SourceError('needs_human', `BrowserOS Neo is unavailable: ${String(error)}`, 'browseros-neo');
  }
  let response: RpcResult;
  try {
    response = await rpc('tools/call', { name, arguments: args });
  } catch (error) {
    throw new SourceError('needs_human', `BrowserOS Neo execution is unavailable: ${String(error)}`, 'browseros-neo');
  }
  if (response.result?.isError) throw new SourceError('needs_human', 'BrowserOS Neo tool could not open the manual verification page', 'browseros-neo');
  return response;
}

async function runNeo(script: string): Promise<unknown> {
  const response = await callNeoTool('run', { code: script, timeout: 30000 });
  const payload = response.result?.structuredContent;
  if (!payload?.ok) throw new SourceError('parse_error', 'BrowserOS Neo could not read rendered page', 'browseros-neo');
  const nested = payload.value as { value?: unknown } | unknown[] | undefined;
  const value = nested && !Array.isArray(nested) && typeof nested === 'object' && 'value' in nested ? nested.value : nested;
  return value;
}

/** Leave a normal BrowserOS Neo tab open for the owner to solve Amazon CAPTCHA.
 * This is NOT a fallback for collecting blocked pages, and does not clear the DB gate.
 */
export function validateNeoVerificationUrl(url: string): string {
  const target = new URL(url);
  const searchParams = [...target.searchParams.keys()];
  const bestseller = target.pathname === '/gp/bestsellers/hpc/3457072051' &&
    searchParams.every(key => key === 'pg') &&
    (!target.searchParams.has('pg') || /^(?:[2-9]|[1-9]\d+)$/.test(target.searchParams.get('pg') ?? ''));
  const baby = target.pathname === '/s' &&
    target.searchParams.get('k') === 'ベビーフード' &&
    target.searchParams.get('i') === 'food-beverage' &&
    searchParams.every(key => ['k', 'i', 'page'].includes(key)) &&
    (!target.searchParams.has('page') || /^(?:[2-9]|[1-9]\d+)$/.test(target.searchParams.get('page') ?? ''));
  if (target.protocol !== 'https:' || target.hostname !== 'www.amazon.co.jp' ||
    target.port || target.username || target.password ||
    !((/^\/dp\/[A-Z0-9]{10}$/.test(target.pathname) && !target.search) ||
      bestseller || baby)) {
    throw Error('Manual verification is restricted to canonical Amazon Japan catalog URLs');
  }
  return target.href;
}

export async function openNeoManualVerification(url: string): Promise<void> {
  await callNeoTool('tabs', { action: 'new', url: validateNeoVerificationUrl(url) });
}

export async function discoverNeo(categorySlug: string, url: string): Promise<Observation[]> {
  const script = `
    const page = await browser.open(${JSON.stringify(url)});
    try {
      // A missing selector can be a CAPTCHA/login page. Inspect the rendered
      // document before deciding whether this is a parsing failure.
      try { await page.waitForSelector('div[data-asin]', {timeout:10000}); } catch {}
      return await page.evaluate(() => {
        const content = ((document.title || '') + ' ' + (document.body?.innerText || '').slice(0, 1200));
        const blocked = !!document.querySelector('form[action*="validateCaptcha"], #captchacharacters, input[name="email"][type="email"]')
          || /enter the characters you see below|ロボットではない|captcha|verify you are a human|sign in to continue/i.test(content);
        if (blocked) return { blocked: true, items: [] };
        const items = Array.from(document.querySelectorAll('div[data-asin]'))
          .filter(el => /^[A-Z0-9]{10}$/.test(el.getAttribute('data-asin') || ''))
          .map(el => ({
            asin: el.getAttribute('data-asin'),
            name: el.querySelector('h2')?.textContent?.trim() || el.querySelector('img[alt]')?.getAttribute('alt')?.trim() || '',
            imageUrl: el.querySelector('img[alt]')?.getAttribute('src') || '',
            rawPrice: el.querySelector('.p13n-sc-price, .a-price .a-offscreen')?.textContent?.trim() || '',
            parentAsin: el.getAttribute('data-parent-asin') || '',
            sourceProductId: el.getAttribute('data-product-family-id') || ''
          }));
        return { blocked: false, items };
      });
    } finally { await page.close(); }
  `;
  return parseNeoOutcome(await runNeo(script), categorySlug);
}

export async function collectDetailNeo(asin: string, categorySlug: string): Promise<Observation> {
  asin = normalizeAmazonInput(asin);
  const url = `https://www.amazon.co.jp/dp/${asin}`;
  const html = await runNeo(`
    const page = await browser.open(${JSON.stringify(url)});
    try {
      try { await page.waitForSelector('#productTitle', {timeout:10000}); } catch {}
      return await page.evaluate(() => document.documentElement.outerHTML);
    } finally { await page.close(); }
  `);
  if (typeof html !== 'string') throw new SourceError('parse_error', 'Neo returned no detail markup', 'browseros-neo');
  try {
    const observation = parseDetail(html, asin, categorySlug);
    observation.sourceAdapter = 'browseros-neo-detail';
    if (observation.detail) observation.detail.provenance.adapter = observation.sourceAdapter;
    return observation;
  } catch (error) {
    if (error instanceof SourceError) error.adapter = 'browseros-neo';
    throw error;
  }
}
