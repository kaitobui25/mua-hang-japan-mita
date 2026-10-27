import { load } from 'cheerio';
import { extractEnrichment } from './enrichment.js';
import { fetchPageWithRetry, parseJpy, SourceError, type Observation } from './source.js';

export function normalizeAmazonInput(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Nhập ASIN hoặc URL sản phẩm HTTPS Amazon.co.jp.');
  const value = input.trim();
  if (/^[a-z0-9]{10}$/i.test(value)) return value.toUpperCase();
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('URL Amazon không hợp lệ.'); }
  if (url.protocol !== 'https:' || !['amazon.co.jp', 'www.amazon.co.jp'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('Chỉ nhận URL HTTPS Amazon.co.jp.');
  const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i)?.[1];
  if (!asin) throw new Error('Không tìm thấy ASIN trong đường dẫn sản phẩm.');
  return asin.toUpperCase();
}

export function parseDetail(html: string, asin: string, categorySlug: string): Observation {
  if (/captcha|enter the characters you see below|ロボットではない/i.test(html)) throw new SourceError('needs_human', 'Amazon yêu cầu xác minh thủ công.');
  const $ = load(html);
  const actualAsin = $('input#ASIN').attr('value')?.trim().toUpperCase();
  const canonical = $('link[rel="canonical"]').attr('href');
  let canonicalAsin: string | undefined;
  if (canonical) { try { canonicalAsin = normalizeAmazonInput(canonical); } catch { /* Require a valid source identity below. */ } }
  if ((actualAsin && actualAsin !== asin) || (canonicalAsin && canonicalAsin !== asin) || (!actualAsin && !canonicalAsin)) throw new SourceError('parse_error', 'ASIN nguồn không khớp yêu cầu.');
  const name = $('#productTitle').text().trim();
  // Scope the quote to the product buy box, never recommendations or list prices.
  const priceText = $('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #priceblock_ourprice').first().text();
  const priceJpy = parseJpy(priceText);
  const observedAt = new Date().toISOString();
  const sourceUrl = `https://www.amazon.co.jp/dp/${asin}`;
  const enrichment = extractEnrichment($, asin, observedAt, sourceUrl);
  const imageUrl = enrichment.imageUrls[0];
  const availabilityText = $('#availability').text();
  const availability = /在庫切れ|現在お取り扱いできません|currently unavailable|out of stock/i.test(availabilityText) ? 'out_of_stock'
    : /在庫あり|in stock/i.test(availabilityText) ? 'in_stock' : 'unknown';
  if (name.length < 8 || !imageUrl) throw new SourceError('parse_error', 'Nguồn thiếu tên hoặc ảnh Amazon hợp lệ.');
  return { ...enrichment, asin, name: name.slice(0, 500), categorySlug, priceJpy, imageUrl, availability,
    sourceUrl, sourceAdapter: 'http-detail', observedAt };
}
export async function collectDetail(asin: string, categorySlug: string) {
  asin = normalizeAmazonInput(asin);
  return parseDetail(await fetchPageWithRetry(`https://www.amazon.co.jp/dp/${asin}`), asin, categorySlug);
}
