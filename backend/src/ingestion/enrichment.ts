import type { CheerioAPI } from 'cheerio';
import type { DetailSnapshot } from './source.js';

const asinPattern = /^[A-Z0-9]{10}$/;
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

// Parse source JSON values without executing scripts or repairing invented data.
export function jsonProperty(script: string, key: string): unknown {
  const match = new RegExp(`["']${key}["']\\s*:\\s*`).exec(script);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const first = script[start];
  if (first === '"') {
    for (let i = start + 1; i < script.length; i++) {
      if (script[i] === '\\') { i++; continue; }
      if (script[i] === '"') { try { return JSON.parse(script.slice(start, i + 1)); } catch { return undefined; } }
    }
    return undefined;
  }
  if (first !== '[' && first !== '{') return undefined;
  let depth = 0, quoted = false;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (quoted && c === '\\') { i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '[' || c === '{') depth++;
    if ((c === ']' || c === '}') && --depth === 0) {
      try { return JSON.parse(script.slice(start, i + 1)); } catch { return undefined; }
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
export function uniqueImages(urls: unknown[]): string[] {
  const found = new Set<string>();
  return urls.filter(amazonImageUrl).filter(url => {
    // Compare the underlying image identity, retaining the actual observed URL.
    const key = new URL(url).pathname.replace(/\._[^/]+_\./, '.');
    if (found.has(key)) return false;
    found.add(key); return true;
  }).slice(0, 5);
}
function dynamicImage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const images = record(JSON.parse(value));
    return Object.keys(images).filter(amazonImageUrl).sort((a, b) => {
      const area = (v: unknown) => Array.isArray(v) ? Number(v[0]) * Number(v[1]) || 0 : 0;
      return area(images[b]) - area(images[a]);
    })[0];
  } catch { return undefined; }
}

export function extractEnrichment($: CheerioAPI, asin: string, observedAt: string, sourceUrl: string) {
  const scripts = $('script').map((_, el) => $(el).html() ?? '').get();
  const images: unknown[] = [];
  const landing = $('#landingImage, #imgBlkFront').first();
  images.push(landing.attr('data-old-hires'));
  for (const script of scripts) {
    // Only the selected product's initial gallery, never other color/child galleries.
    if (!/["']colorImages["']\s*:/.test(script)) continue;
    const initial = jsonProperty(script.slice(script.search(/["']colorImages["']\s*:/)), 'initial');
    if (!Array.isArray(initial)) continue;
    for (const image of initial) {
      const item = record(image);
      images.push([item.hiRes, dynamicImage(JSON.stringify(item.main)), item.large].find(amazonImageUrl));
    }
  }
  $('#altImages img').each((_, el) => {
    images.push($(el).attr('data-old-hires'), dynamicImage($(el).attr('data-a-dynamic-image')));
  });
  images.push(dynamicImage(landing.attr('data-a-dynamic-image')), landing.attr('src'));
  const imageUrls = uniqueImages(images);
  const detail: DetailSnapshot = {
    features: [], ingredients: [], usage: [], specs: {}, cautions: [], variantAttributes: {}, childAsins: [],
    sourceObservedAt: observedAt, provenance: { sourceUrl, adapter: 'http-detail', sections: [] }
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
  if (parentAsin) detail.provenance.variantGroup = { parentAsin, sourceUrl };
  return { imageUrls, detail, parentAsin };
}
