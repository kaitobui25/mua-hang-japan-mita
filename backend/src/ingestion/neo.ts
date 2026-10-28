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
    throw new SourceError('temporary', `BrowserOS Neo is unavailable: ${String(error)}`, 'browseros-neo');
  }
  let response: RpcResult;
  try {
    response = await rpc('tools/call', { name, arguments: args });
  } catch (error) {
    throw new SourceError('temporary', `BrowserOS Neo execution is unavailable: ${String(error)}`, 'browseros-neo');
  }
  if (response.result?.isError) throw new SourceError('temporary', 'BrowserOS Neo tool could not open the manual verification page', 'browseros-neo');
  return response;
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
