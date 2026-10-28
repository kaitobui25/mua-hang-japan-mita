import { hasJapanese } from './local.js';

export type DetailText = {
  features: string[]; ingredients: string[]; usage: string[]; cautions: string[];
  specs: Record<string, string>;
};
export type DetailItem = { slot: string; source: string; translated: string | null; retry_after?: Date | string | null };
export const detailSections = ['features', 'ingredients', 'usage', 'cautions'] as const;

export function detailItems(snapshot: DetailText): DetailItem[] {
  const items: DetailItem[] = [];
  for (const section of detailSections) snapshot[section].forEach((source, index) => {
    if (hasJapanese(source)) items.push({ slot: `${section}:${index}`, source, translated: null });
  });
  // Values are never passed to inference, normalized, or trimmed.
  Object.keys(snapshot.specs).forEach((source, index) => {
    if (hasJapanese(source)) items.push({ slot: `specs:${index}`, source, translated: null });
  });
  return items;
}

export function renderDetail(snapshot: DetailText, items: DetailItem[]): DetailText {
  const translations = new Map(items.filter(i => i.translated !== null).map(i => [i.slot, i]));
  const translated = (slot: string, source: string) => {
    const item = translations.get(slot);
    return item?.source === source ? item.translated! : source;
  };
  const result = { ...snapshot, specs: Object.create(null) as Record<string, string> };
  for (const section of detailSections) result[section] = snapshot[section].map((source, index) => translated(`${section}:${index}`, source));
  const originalKeys = new Set(Object.keys(snapshot.specs));
  Object.entries(snapshot.specs).forEach(([source, value], index) => {
    let key = translated(`specs:${index}`, source);
    // Reserve every original key, including pending/non-Japanese keys.
    if ((key !== source && originalKeys.has(key)) || Object.hasOwn(result.specs, key)) {
      const base = `${key} [${source}]`;
      key = base;
      let suffix = 2;
      while (originalKeys.has(key) || Object.hasOwn(result.specs, key)) key = `${base} (${suffix++})`;
    }
    result.specs[key] = value;
  });
  return result;
}
