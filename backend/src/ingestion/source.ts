import { load } from 'cheerio';
import { config } from '../config.js';

export const seeds = [
  { categorySlug: 'thuc-pham-bo-sung', url: 'https://www.amazon.co.jp/gp/bestsellers/hpc/3457072051' },
  { categorySlug: 'thuc-pham-cho-be', url: 'https://www.amazon.co.jp/s?k=%E3%83%99%E3%83%93%E3%83%BC%E3%83%95%E3%83%BC%E3%83%89&i=food-beverage' }
] as const;

export type StructuredDetail = {
  features: string[]; ingredients: string[]; usage: string[];
  specs: Record<string, string>; cautions: string[];
};
export type DetailSnapshot = StructuredDetail & {
  variantAttributes: Record<string, string>;
  childAsins: string[];
  sourceObservedAt: string;
  provenance: {
    sourceUrl: string; adapter: string; sections: string[];
    fieldObservedAt?: Record<string, string>;
    variantGroup?: { parentAsin: string; sourceUrl: string };
  };
};
export type Observation = {
  asin: string; name: string; brand?: string | null; categorySlug: string;
  sourceUrl: string; imageUrl?: string | null; priceJpy?: number | null;
  observedAt: string; sourceAdapter: string;
  parentAsin?: string | null; sourceProductId?: string | null;
  imageUrls?: string[]; detail?: DetailSnapshot;
  availability?: 'in_stock' | 'out_of_stock' | 'unknown';
};

export class SourceError extends Error {
  constructor(public state: 'blocked' | 'rate_limited' | 'temporary' | 'parse_error', message: string, public adapter: 'http' | 'browseros-neo' | 'scrapling' = 'http') { super(message); }
}

/** Identify a CAPTCHA for diagnostics; normal operations never open a browser. */
export function isAmazonCaptcha(error: Pick<SourceError, 'state' | 'message'>): boolean {
  return error.state === 'blocked' && /\bcaptcha\b/i.test(error.message);
}

export type DiscoveryIssue = { state: SourceError['state']; adapter: SourceError['adapter']; message: string; page?: number };
export type DiscoveryResult = { observations: Observation[]; issues: DiscoveryIssue[] };

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
  let response: Response;
  try {
    response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(config.amazonTimeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.7',
      Accept: 'text/html,application/xhtml+xml'
    }
    });
  } catch (error) {
    throw new SourceError('temporary', `Amazon network/timeout error: ${String(error)}`);
  }
  if (response.status === 403 || response.status === 429) throw new SourceError(response.status === 429 ? 'rate_limited' : 'blocked', `Amazon HTTP ${response.status}; source cooldown required`);
  if (response.status >= 500 || response.status === 408) throw new SourceError('temporary', `Amazon HTTP ${response.status}`);
  if (!response.ok) throw new SourceError('temporary', `Unexpected source HTTP ${response.status}`);
  const html = await response.text();
  if (/captcha|enter the characters you see below|ロボットではない/i.test(html)) {
    throw new SourceError('blocked', 'Amazon CAPTCHA requested human verification');
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
    // Only group variations when the source explicitly exposes a shared identifier.
    // Never guess a parent from similar names or adjacent listing cards.
    const rawParent = (card.attr('data-parent-asin') ?? '').toUpperCase();
    const parentAsin = asinPattern.test(rawParent) ? rawParent : null;
    const rawFamily = card.attr('data-product-family-id') ?? '';
    const sourceProductId = /^[A-Za-z0-9_-]{3,64}$/.test(rawFamily) ? rawFamily : null;
    found.set(asin, {
      asin, name: title.slice(0, 500), brand: null, categorySlug,
      parentAsin, sourceProductId, sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
      imageUrl, priceJpy, observedAt, sourceAdapter: 'http'
    });
  });
  return [...found.values()];
}

type DiscoverOptions = {
  fetchPage?: (url: string) => Promise<string>;
  delay?: (milliseconds: number) => Promise<void>;
  maxPages?: number;
};

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

// Three attempts total, only for network/timeouts/5xx. Never retry access denial.
export async function fetchPageWithRetry(url: string, fetchPage = getHtml, delay = sleep): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchPage(url);
    } catch (error) {
      const sourceError = error instanceof SourceError ? error : new SourceError('temporary', String(error));
      if (sourceError.state !== 'temporary' || attempt >= 3) throw sourceError;
      await delay(500 * 2 ** (attempt - 1));
    }
  }
}

export async function discoverHttp(categorySlug: string, url: string, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const results = new Map<string, Observation>();
  const issues: DiscoveryIssue[] = [];
  const delay = options.delay ?? sleep;
  const pageCount = options.maxPages ?? (categorySlug === 'thuc-pham-bo-sung' ? 6 : 5);
  for (let page = 1; page <= pageCount; page++) {
    const target = new URL(url);
    if (page > 1) target.searchParams.set(categorySlug === 'thuc-pham-bo-sung' ? 'pg' : 'page', String(page));
    let html: string;
    try {
      html = await fetchPageWithRetry(target.toString(), options.fetchPage ?? getHtml, delay);
    } catch (error) {
      if (page === 1) throw error;
      const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
      // Preserve the pages already read, but surface the incomplete crawl.
      issues.push({ state: failure.state, adapter: failure.adapter, page, message: failure.message });
      break;
    }
    const observations = parseListing(html, categorySlug);
    if (!observations.length && page === 1) throw new SourceError('parse_error', `No valid ASINs found on ${url}`);
    if (!observations.length) break;
    let newlySeen = 0;
    for (const observation of observations) {
      if (!results.has(observation.asin)) {
        results.set(observation.asin, observation);
        newlySeen++;
      }
    }
    if (newlySeen === 0) break;
    if (page < pageCount) await delay(1200);
  }
  return { observations: [...results.values()], issues };
}
