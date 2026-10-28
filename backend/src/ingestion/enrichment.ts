import type { CheerioAPI } from 'cheerio';
import type { DetailSnapshot } from './source.js';

const asinPattern = /^[A-Z0-9]{10}$/;
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

// Parse source JSON values without executing scripts or repairing invented data.
export function jsonProperty(script: string, key: string): unknown {
  const value = jsonPropertySource(script, key);
  try { return value === undefined ? undefined : JSON.parse(value); } catch { return undefined; }
}
function jsonPropertySource(script: string, key: string): string | undefined {
  const match = new RegExp(`["']${key}["']\\s*:\\s*`).exec(script);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const first = script[start];
  if (first === '"') {
    for (let i = start + 1; i < script.length; i++) {
      if (script[i] === '\\') { i++; continue; }
      if (script[i] === '"') return script.slice(start, i + 1);
    }
    return undefined;
  }
  if (first !== '[' && first !== '{') return undefined;
  let depth = 0, quote: string | undefined;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (quote && c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = undefined; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '{') depth++;
    if ((c === ']' || c === '}') && --depth === 0) {
      return script.slice(start, i + 1);
    }
  }
  return undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function amazonImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com'].includes(url.hostname) &&
      /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(url.pathname + url.search);
  } catch { return false; }
}
// Reject thumbnail-sized URLs observed in Amazon markup/legacy galleries. An
// unmodified URL has no encoded dimensions, so keep it as observed rather than
// guessing a larger URL that might not exist.
export function galleryImageUrl(value: unknown, observedMaxSides: ReadonlyMap<string, number> = new Map()): value is string {
  if (!amazonImageUrl(value)) return false;
  const modifier = new URL(value).pathname.match(/\._([^/]+)_\.(?:jpe?g|png|webp)$/i)?.[1] ?? '';
  const encodedSides = [...modifier.matchAll(/(?:^|_)(?:AC_)?(?:SL|SX|SY|SR|US|UX|UY|UL|SS)(\d+)(?:,(\d+))?(?=_|$)/gi)]
    .flatMap(match => [Number(match[1]), ...(match[2] ? [Number(match[2])] : [])]);
  if (encodedSides.length && Math.max(...encodedSides) < 800) return false;
  const observedSide = observedMaxSides.get(value);
  return observedSide === undefined || observedSide >= 800;
}
export function uniqueImages(
  urls: unknown[], dimensions: ReadonlyMap<string, number> = new Map(),
  observedMaxSides: ReadonlyMap<string, number> = new Map()
): string[] {
  const found = new Map<string, { url: string; area: number } | null>();
  for (const url of urls.filter(amazonImageUrl)) {
    // Identity ignores Amazon resize modifiers, but the returned URL is always observed.
    const key = imageIdentity(url);
    // A thumbnail may establish photo order, even though it must not be
    // displayed. A later large URL fills that position without moving it.
    if (!found.has(key)) found.set(key, null);
    if (!galleryImageUrl(url, observedMaxSides)) continue;
    const pathname = new URL(url).pathname;
    const size = Number(pathname.match(/(?:SL|SX|SY|AC_SL|AC_SX|AC_SY)(\d+)/)?.[1] ?? 0);
    const area = dimensions.get(url) ?? size * size;
    const previous = found.get(key);
    if (!previous || area > previous.area) found.set(key, { url, area });
  }
  return [...found.values()].filter((image): image is { url: string; area: number } => image !== null)
    .slice(0, 5).map(image => image.url);
}
function imageIdentity(url: string): string {
  return new URL(url).pathname.replace(/\._[^/]+_\./, '.');
}
function dynamicImage(value: string | undefined, dimensions: Map<string, number>, maxSides: Map<string, number>): string[] {
  if (!value) return [];
  try {
    const images = record(JSON.parse(value));
    for (const [url, size] of Object.entries(images)) {
      if (Array.isArray(size) && size.length === 2 && size.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
        dimensions.set(url, Math.max(dimensions.get(url) ?? 0, size[0] * size[1]));
        maxSides.set(url, Math.max(maxSides.get(url) ?? 0, size[0], size[1]));
      }
    }
    return Object.keys(images).filter(amazonImageUrl);
  } catch { return []; }
}

export function extractEnrichment($: CheerioAPI, asin: string, observedAt: string, sourceUrl: string) {
  const scripts = $('script').map((_, el) => $(el).html() ?? '').get();
  const images: unknown[] = [];
  const dimensions = new Map<string, number>();
  const maxSides = new Map<string, number>();
  const hiResByIdentity = new Map<string, string>();
  const gallerySections: string[] = [];
  let completeGallery = false;
  const selectedNode = (node: ReturnType<CheerioAPI>) =>
    !node.closest('[id*="recommend"], [id*="sims-"], [id^="variation_"]').length &&
    !node.parents('[data-asin]').addBack('[data-asin]').toArray().some(el => {
      const owner = $(el).attr('data-asin');
      return owner && owner !== asin;
    });
  const landing = $('#landingImage, #imgBlkFront').filter((_, el) => selectedNode($(el))).first();
  const altImages = $('#altImages img').filter((_, el) => selectedNode($(el)));
  const landingHiRes = landing.attr('data-old-hires');
  const landingDynamic = dynamicImage(landing.attr('data-a-dynamic-image'), dimensions, maxSides);
  const landingImages = [landingHiRes, ...landingDynamic, landing.attr('src')];
  // Only product DOM images can bind an otherwise unowned script. Accepted scripts
  // must not lend their identities to later, unrelated scripts.
  const knownImages = new Set(landingImages.filter(amazonImageUrl).map(imageIdentity));
  altImages.each((_, el) => {
    const node = $(el);
    const candidates = [node.attr('data-old-hires'), ...dynamicImage(node.attr('data-a-dynamic-image'), dimensions, maxSides), node.attr('src')];
    for (const url of candidates.filter(amazonImageUrl)) knownImages.add(imageIdentity(url));
  });
  if (galleryImageUrl(landingHiRes, maxSides)) {
    images.push(landingHiRes);
    hiResByIdentity.set(imageIdentity(landingHiRes), landingHiRes);
  }
  for (const [index, script] of scripts.entries()) {
    // Only the selected product's initial gallery, never other color/child galleries.
    const node = $('script').eq(index);
    const owner = node.closest('[data-asin]').attr('data-asin');
    const currentAsin = jsonProperty(script, 'currentAsin');
    if (!selectedNode(node) || (jsonPropertySource(script, 'currentAsin') !== undefined && currentAsin !== asin)) continue;
    const initial = jsonProperty(jsonPropertySource(script, 'colorImages') ?? '', 'initial');
    if (!Array.isArray(initial)) continue;
    const bound = owner === asin || currentAsin === asin || initial.some(image => {
      const item = record(image);
      return [item.hiRes, item.large, item.thumb, ...Object.keys(record(item.main))]
        .filter(amazonImageUrl).some(url => knownImages.has(imageIdentity(url)));
    });
    if (!bound) continue;
    let valid = 0;
    for (const image of initial) {
      const item = record(image);
      const main = dynamicImage(JSON.stringify(item.main), dimensions, maxSides);
      // Amazon explicitly designates hiRes as the source for enlarged display.
      // Use main/large only where no usable hiRes was supplied.
      const hiRes = item.hiRes;
      const hasHiRes = galleryImageUrl(hiRes, maxSides);
      if (hasHiRes) hiResByIdentity.set(imageIdentity(hiRes), hiRes);
      const candidates = hasHiRes ? [hiRes]
        : main.filter(url => galleryImageUrl(url, maxSides)).length ? main : [item.large];
      if (candidates.some(url => galleryImageUrl(url, maxSides))) valid++;
      images.push(...candidates);
    }
    if (valid) gallerySections.push('colorImages.initial');
    if (valid > 0 && valid === initial.length) completeGallery = true;
  }
  altImages.each((_, el) => {
    const node = $(el);
    const hiRes = node.attr('data-old-hires');
    const dynamic = dynamicImage(node.attr('data-a-dynamic-image'), dimensions, maxSides);
    if (galleryImageUrl(hiRes, maxSides) && !hiResByIdentity.has(imageIdentity(hiRes))) {
      hiResByIdentity.set(imageIdentity(hiRes), hiRes);
    }
    const candidates = galleryImageUrl(hiRes, maxSides) ? [hiRes] : [...dynamic, node.attr('src')];
    images.push(...candidates);
    if (candidates.some(url => galleryImageUrl(url, maxSides))) gallerySections.push('altImages');
  });
  images.push(...(galleryImageUrl(landingHiRes, maxSides) ? [landingHiRes] : [...landingDynamic, landing.attr('src')]));
  if (landingImages.some(url => galleryImageUrl(url, maxSides))) gallerySections.push('landingImage');
  const imageUrls = uniqueImages(images, dimensions, maxSides)
    .map(url => hiResByIdentity.get(imageIdentity(url)) ?? url);
  const detail: DetailSnapshot = {
    features: [], ingredients: [], usage: [], specs: {}, cautions: [], variantAttributes: {}, childAsins: [],
    sourceObservedAt: observedAt, provenance: { sourceUrl, adapter: 'http-detail',
      sections: imageUrls.length ? [...new Set(gallerySections), completeGallery ? 'gallery:complete' : 'gallery:partial'] : [] }
  };
  const add = (field: 'features' | 'ingredients' | 'usage' | 'cautions', text: string, section: string) => {
    const value = clean(text);
    if (value && !detail[field].includes(value)) {
      detail[field].push(value);
      if (!detail.provenance.sections.includes(section)) detail.provenance.sections.push(section);
    }
  };
  $('#feature-bullets li .a-list-item').each((_, el) => add('features', $(el).text(), 'feature-bullets'));
  const classify = (label: string) => /原材料|成分|ingredients/i.test(label) ? 'ingredients'
    : /使用方法|使い方|お召し上がり|召し上がり方|directions|usage/i.test(label) ? 'usage'
    : /注意|警告|安全上|caution|warning|safety/i.test(label) ? 'cautions' : undefined;
  $('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #productOverview_feature_div tr').each((_, el) => {
    const label = clean($(el).find('th, td.a-span3').first().text());
    const value = clean($(el).find('td').last().text());
    if (!label || !value || label === value) return;
    detail.specs[label] = value;
    const field = classify(label);
    if (field) add(field, value, 'productDetails');
  });
  $('#detailBullets_feature_div li').each((_, el) => {
    const row = $(el).clone();
    const label = clean(row.find('.a-text-bold').first().text()).replace(/[:：\u200e\u200f]/g, '').trim();
    row.find('.a-text-bold').first().remove();
    const value = clean(row.text()).replace(/^[:：\s]+/, '');
    if (label && value) { detail.specs[label] = value; const field = classify(label); if (field) add(field, value, 'detailBullets'); }
  });
  $('#important-information h1, #important-information h2, #important-information h3, #important-information h4').each((_, el) => {
    const heading = $(el);
    const field = classify(clean(heading.text()));
    if (!field) return;
    const text = heading.nextUntil('h1,h2,h3,h4').text();
    add(field, text, 'important-information');
  });
  if (Object.keys(detail.specs).length) detail.provenance.sections.push('productDetails');
  let parentAsin: string | undefined;
  for (const script of scripts) {
    const parent = jsonProperty(script, 'parentAsin');
    const variations = record(jsonProperty(script, 'asinVariationValues'));
    const display = record(jsonProperty(script, 'dimensionValuesDisplayData'));
    // Bind a parent identifier to this ASIN, not an unrelated recommendation script.
    if (typeof parent === 'string' && asinPattern.test(parent) &&
      (asin in variations || asin in display || jsonProperty(script, 'currentAsin') === asin)) parentAsin = parent;
    if (!(asin in variations) && !(asin in display)) continue;
    const dimensions = jsonProperty(script, 'variationDisplayLabels');
    const labels = record(dimensions);
    const names = jsonProperty(script, 'dimensions');
    const values = record(jsonProperty(script, 'variationValues'));
    for (const [child, attributes] of Object.entries(variations)) {
      if (!asinPattern.test(child)) continue;
      detail.childAsins.push(child);
      if (child !== asin) continue;
      for (const [key, value] of Object.entries(record(attributes))) {
        const choices = values[key];
        const index = /^\d+$/.test(String(value));
        const resolved = index ? (Array.isArray(choices) ? choices[Number(value)] : undefined) : value;
        if (typeof resolved === 'string') detail.variantAttributes[typeof labels[key] === 'string' ? labels[key] as string : key] = clean(resolved);
      }
    }
    // Display arrays have dimension order explicitly supplied by the source.
    for (const child of Object.keys(display)) if (asinPattern.test(child)) detail.childAsins.push(child);
    const selected = display[asin];
    if (Array.isArray(names) && Array.isArray(selected) && names.length === selected.length) {
      names.forEach((key, i) => { if (typeof key === 'string' && typeof selected[i] === 'string') detail.variantAttributes[key] = clean(selected[i]); });
    }
  }
  $('[id^="variation_"]').each((_, el) => {
    const node = $(el);
    const value = clean(node.find('.selection').first().text());
    const key = node.attr('id')!.slice('variation_'.length);
    if (value && key) detail.variantAttributes[key] = value;
    node.find('[data-defaultasin], [data-asin]').each((_, child) => {
      const id = $(child).attr('data-defaultasin') || $(child).attr('data-asin') || '';
      if (asinPattern.test(id)) detail.childAsins.push(id);
    });
  });
  detail.childAsins = [...new Set(detail.childAsins)].filter(child => child !== asin);
  if (parentAsin || detail.childAsins.length || Object.keys(detail.variantAttributes).length) detail.provenance.sections.push('twister');
  const fields = ['features', 'ingredients', 'usage', 'specs', 'cautions', 'variantAttributes', 'childAsins'] as const;
  detail.provenance.fieldObservedAt = Object.fromEntries(fields
    .filter(field => Object.keys(detail[field]).length > 0).map(field => [field, observedAt]));
  if (imageUrls.length) detail.provenance.fieldObservedAt.images = observedAt;
  if (parentAsin) detail.provenance.variantGroup = { parentAsin, sourceUrl };
  return { imageUrls, detail, parentAsin };
}
