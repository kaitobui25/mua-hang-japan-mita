import { load } from 'cheerio';
import { config } from '../config.js';

export const seeds = [
  { categorySlug: 'thuc-pham-bo-sung', url: 'https://www.amazon.co.jp/gp/bestsellers/hpc/3457072051' },
  { categorySlug: 'thuc-pham-cho-be', url: 'https://www.amazon.co.jp/s?k=%E3%83%99%E3%83%93%E3%83%BC%E3%83%95%E3%83%BC%E3%83%89&i=food-beverage' }
] as const;

export type Observation = {
  asin: string; name: string; brand?: string | null; categorySlug: string;
  sourceUrl: string; imageUrl?: string | null; priceJpy?: number | null;
  observedAt: string; sourceAdapter: string;
};

export class SourceError extends Error {
  constructor(public state: 'blocked' | 'temporary' | 'parse_error', message: string) { super(message); }
}

const asinPattern = /^[A-Z0-9]{10}$/;

export function parseJpy(text: string): number | null {
  const match = text.replace(/\s/g, '').match(/[￥¥]\s*([0-9,]+)(?:\.[0-9]{1,2})?/);
  if (!match) return null;
  let digits = match[1];
  // Amazon bestseller markup sometimes concatenates two trailing superscript
  // characters to the integer price, e.g. ¥6,98070 => ¥6,980.
  if (/^\d{1,3}(?:,\d{3})+\d{2}$/.test(digits)) digits = digits.slice(0, -2);
  // Reject other malformed groupings rather than publishing fictitious prices.
  if (!/^(?:\d{1,5}|\d{1,3}(?:,\d{3})+)$/.test(digits)) return null;
  const amount = Number(digits.replaceAll(',', ''));
  return Number.isFinite(amount) && amount > 0 && amount <= 100_000 ? amount : null;
}

export async function getHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.amazonTimeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.7',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (response.status === 403 || response.status === 429) throw new SourceError('blocked', `Amazon HTTP ${response.status}; manual review required`);
  if (response.status >= 500 || response.status === 408) throw new SourceError('temporary', `Amazon HTTP ${response.status}`);
  if (!response.ok) throw new SourceError('parse_error', `Unexpected source HTTP ${response.status}`);
  const html = await response.text();
  if (/captcha|enter the characters you see below|ロボットではない/i.test(html.slice(0, 10000))) {
    throw new SourceError('blocked', 'Amazon requested human verification');
  }
  return html;
}

export function parseListing(html: string, categorySlug: string, observedAt = new Date().toISOString()): Observation[] {
  const $ = load(html);
  const found = new Map<string, Observation>();
  const cards = categorySlug === 'thuc-pham-cho-be'
    ? $('div[data-component-type="s-search-result"][data-asin]')
    : $('[data-asin]');
  cards.each((_, node) => {
    const card = $(node);
    const asin = (card.attr('data-asin') ?? '').toUpperCase();
    if (!asinPattern.test(asin) || found.has(asin)) return;
    const picture = card.find('img').filter((_, el) => Boolean($(el).attr('alt'))).first();
    const title = card.find('h2').first().text().trim() ||
      picture.attr('alt')?.trim() ||
      card.find('[class*="line-clamp"] , [class*="truncate"] ').first().text().trim();
    if (!title || title.length < 8) return;
    const priceElement = card.find('.p13n-sc-price, .a-price .a-offscreen').first();
    // Never parse the entire card: prices from recommendations/rank/discount merge in its text.
    const priceJpy = parseJpy(priceElement.text());
    const rawImage = picture.attr('data-src') || picture.attr('src') || null;
    const imageUrl = rawImage?.startsWith('https://') ? rawImage : null;
    found.set(asin, {
      asin, name: title.slice(0, 500), brand: null, categorySlug,
      sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
      imageUrl, priceJpy, observedAt, sourceAdapter: 'http'
    });
  });
  return [...found.values()];
}

export async function discoverHttp(categorySlug: string, url: string): Promise<Observation[]> {
  const results = new Map<string, Observation>();
  const pageCount = categorySlug === 'thuc-pham-bo-sung' ? 6 : 5;
  for (let page = 1; page <= pageCount && results.size < config.maxDiscover; page++) {
    const target = new URL(url);
    if (page > 1) target.searchParams.set(categorySlug === 'thuc-pham-bo-sung' ? 'pg' : 'page', String(page));
    let html: string;
    try {
      html = await getHtml(target.toString());
    } catch (error) {
      // A later pagination page can fail without invalidating the first page.
      // Access denial is different: stop instead of trying alternate browsers.
      if (page === 1 || (error instanceof SourceError && error.state === 'blocked')) throw error;
      console.warn(`Pagination ended at page ${page} (${categorySlug}): ${String(error)}`);
      break;
    }
    const observations = parseListing(html, categorySlug);
    if (!observations.length && page === 1) throw new SourceError('parse_error', `No valid ASINs found on ${url}`);
    if (!observations.length) break;
    let newlySeen = 0;
    for (const observation of observations) {
      if (!results.has(observation.asin) && results.size < config.maxDiscover) {
        results.set(observation.asin, observation);
        newlySeen++;
      }
    }
    if (newlySeen === 0) break;
    if (page < pageCount) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return [...results.values()];
}
