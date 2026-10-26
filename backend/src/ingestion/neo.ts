import { config } from '../config.js';
import { parseJpy, SourceError, type Observation } from './source.js';

type RpcResult = { result?: { structuredContent?: { ok?: boolean; value?: unknown; logs?: string[] }; content?: { text?: string }[] }; error?: { message?: string } };

// BrowserOS Neo is a local-only fallback for JS markup changes. Never use it
// to get around Amazon 403 / 429 / CAPTCHA or human verification.
export async function discoverNeo(categorySlug: string, url: string): Promise<Observation[]> {
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

  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mita-catalog', version: '0.1.0' } });
  await rpc('notifications/initialized', {}, true);
  const script = `
    const page = await browser.open(${JSON.stringify(url)});
    try {
      const waited = await page.waitForSelector('div[data-asin]', {timeout:10000});
      if (!waited?.matched) return [];
      return await page.evaluate(() => Array.from(document.querySelectorAll('div[data-asin]'))
        .filter(el => /^[A-Z0-9]{10}$/.test(el.getAttribute('data-asin') || ''))
        .slice(0, 8)
        .map(el => ({
          asin: el.getAttribute('data-asin'),
          name: el.querySelector('h2')?.textContent?.trim() || el.querySelector('img[alt]')?.getAttribute('alt')?.trim() || '',
          imageUrl: el.querySelector('img[alt]')?.getAttribute('src') || '',
          rawPrice: el.querySelector('.p13n-sc-price, .a-price .a-offscreen')?.textContent?.trim() || ''
        })));
    } finally { await page.close(); }
  `;
  const response = await rpc('tools/call', { name: 'run', arguments: { code: script, timeout: 30000 } });
  const payload = response.result?.structuredContent;
  if (!payload?.ok) throw new SourceError('parse_error', 'BrowserOS Neo could not read rendered page');
  const nested = payload.value as { value?: unknown } | unknown[] | undefined;
  const value = nested && !Array.isArray(nested) && typeof nested === 'object' && 'value' in nested ? nested.value : nested;
  if (!Array.isArray(value)) throw new SourceError('parse_error', 'BrowserOS Neo returned unexpected data');
  const unique = new Map<string, Observation>();
  const observedAt = new Date().toISOString();
  for (const item of value as { asin?: string; name?: string; imageUrl?: string; rawPrice?: string }[]) {
    if (!item.asin || !/^[A-Z0-9]{10}$/.test(item.asin) || !item.name || unique.has(item.asin)) continue;
    unique.set(item.asin, {
      asin: item.asin, name: item.name.slice(0, 500), categorySlug, sourceAdapter: 'browseros-neo', observedAt,
      sourceUrl: `https://www.amazon.co.jp/dp/${item.asin}`,
      imageUrl: item.imageUrl?.startsWith('https://') ? item.imageUrl : null,
      priceJpy: parseJpy(item.rawPrice ?? '')
    });
    if (unique.size >= config.maxDiscover) break;
  }
  if (!unique.size) throw new SourceError('parse_error', 'BrowserOS Neo extracted no valid products');
  return [...unique.values()];
}
