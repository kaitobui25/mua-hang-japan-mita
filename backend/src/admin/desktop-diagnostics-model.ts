import { usableTranslation } from '../translation/warnings.js';
import { validateTitlePresentation } from '../translation/compact-title.js';

export const MAX_PRODUCTS = 20000;
export type ProductEvidence = {
  asin: string; originalName: string; fullVietnameseName: string | null;
  shortVietnameseName: string | null; displayName: string; nameNotice: string | null;
  coverUrl: string | null;
  images: { url: string; observedAt: string }[];
  sourceAdapter: string; sourceObservedAt: string; updatedAt: string;
  translatedAt: string | null; shortTitleUpdatedAt: string | null;
  hiddenAt: string | null;
  translationStatus: string | null; translationScope: 'name_only' | 'full' | null;
};
export type SchemaTable = { name: string; columns: number; indexes: number };
const eventKinds = {
  catalog_issue: { category: 'catalog', severity: 'warning', title: 'Catalog source reported an issue' },
  catalog_running: { category: 'catalog', severity: 'info', title: 'Catalog collection started' },
  catalog_success: { category: 'catalog', severity: 'info', title: 'Catalog collection completed' },
  catalog_failed: { category: 'catalog', severity: 'error', title: 'Catalog collection failed' },
  catalog_status: { category: 'catalog', severity: 'warning', title: 'Catalog collection status recorded' },
  translation_running: { category: 'translation', severity: 'info', title: 'Title translation started' },
  translation_completed: { category: 'translation', severity: 'info', title: 'Title translation completed' },
  translation_failed: { category: 'translation', severity: 'error', title: 'Title translation failed' },
  translation_status: { category: 'translation', severity: 'warning', title: 'Title translation partial or deferred' },
  vps_sync_running: { category: 'sync', severity: 'info', title: 'Đồng bộ VPS đã bắt đầu' },
  vps_sync_completed: { category: 'sync', severity: 'info', title: 'Đồng bộ VPS đã hoàn tất' },
  vps_sync_partial: { category: 'sync', severity: 'warning', title: 'Đồng bộ VPS giữ lại một phần ảnh' },
  vps_sync_failed: { category: 'sync', severity: 'error', title: 'Đồng bộ VPS thất bại' }
} as const;
export type SafeEvent = { source: 'pc' | 'vps'; category: 'catalog' | 'translation' | 'sync';
  severity: 'info' | 'warning' | 'error'; timestamp: string; title: string };
export type LogSource = { id: string; status: 'available' | 'missing'; truncated: boolean };
export type Evidence = {
  capturedAt: string; database: string; serverAddress: string | null; serverPort: number | null;
  tables: SchemaTable[]; products: ProductEvidence[];
  catalog: { products: number; translations: number; images: number; details: number };
  logs: { status: 'available' | 'missing'; truncated: boolean; sources: LogSource[]; events: SafeEvent[] };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_evidence');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 6000): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('invalid_evidence');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid_evidence');
  return Number(value);
}
function timestamp(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error('invalid_evidence');
  return new Date(result).toISOString();
}
function nullableTimestamp(value: unknown) { return value === null ? null : timestamp(value); }
function vietnamese(value: unknown, max = 6000): string | null {
  try {
    const result = usableTranslation(value, max).trim();
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(result) ? null : result;
  } catch { return null; }
}

function imageUrl(value: unknown): string {
  const url = text(value, 2048);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
      !['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com'].includes(parsed.hostname)) {
    throw new Error('invalid_image_source');
  }
  return url;
}

/** Project only approved fields; never pass through remote JSON, errors, or log messages. */
export function parseEvidence(value: unknown, source: 'pc' | 'vps'): Evidence {
  const raw = object(value);
  if (!Array.isArray(raw.products) || raw.products.length > MAX_PRODUCTS ||
      !Array.isArray(raw.tables) || raw.tables.length > 1000) throw new Error('evidence_limit');
  const ids = new Set<string>();
  const products = raw.products.map(value => {
    const row = object(value);
    const asin = text(row.asin, 10);
    if (!/^[A-Z0-9]{10}$/.test(asin) || ids.has(asin)) throw new Error('invalid_evidence');
    ids.add(asin);
    const originalName = text(row.originalName);
    const fullVietnameseName = vietnamese(row.fullVietnameseName);
    let shortVietnameseName: string | null = null;
    if (fullVietnameseName && vietnamese(row.shortVietnameseName, 120)) {
      try {
        shortVietnameseName = validateTitlePresentation({ asin, sourceName: originalName,
          translatedName: fullVietnameseName, brand: row.brand === null ? null : text(row.brand, 500) },
        { shortName: row.shortVietnameseName, omittedFacts: row.omittedFacts }).shortName;
      } catch { /* Invalid/stale compact titles must fall back to the full title. */ }
    }
    if (!Array.isArray(row.images) || row.images.length > 5) throw new Error('invalid_evidence');
    const coverUrl = row.coverUrl == null ? null : imageUrl(row.coverUrl);
    const images = row.images.map(value => {
      const image = object(value);
      const url = imageUrl(image.url);
      // Source image URLs only; the server never fetches them.
      return { url, observedAt: timestamp(image.observedAt) };
    });
    return { asin, originalName, fullVietnameseName, shortVietnameseName, coverUrl,
      displayName: shortVietnameseName ?? fullVietnameseName ?? originalName,
      nameNotice: fullVietnameseName ? null : 'Chưa có tên Việt', images,
      sourceAdapter: text(row.sourceAdapter, 100), sourceObservedAt: timestamp(row.sourceObservedAt),
      updatedAt: timestamp(row.updatedAt), translatedAt: nullableTimestamp(row.translatedAt),
      shortTitleUpdatedAt: nullableTimestamp(row.shortTitleUpdatedAt),
      hiddenAt: row.hiddenAt === undefined ? null : nullableTimestamp(row.hiddenAt),
      translationStatus: ['pending', 'success', 'warning', 'failed'].includes(String(row.translationStatus))
        ? String(row.translationStatus) : null,
      translationScope: fullVietnameseName && typeof row.nameOnly === 'boolean'
        ? (row.nameOnly ? 'name_only' as const : 'full' as const) : null };
  });
  const catalog = object(raw.catalog);
  const logs = object(raw.logs);
  if (!['available', 'missing'].includes(String(logs.status)) || typeof logs.truncated !== 'boolean' ||
      !Array.isArray(logs.events) || logs.events.length > 3000 || !Array.isArray(logs.sources) ||
      logs.sources.length !== 4) throw new Error('invalid_evidence');
  const sources: LogSource[] = logs.sources.map((value, index) => {
    const row = object(value);
    const id = ['catalog_issues', 'catalog_runs', 'translation_runs', 'vps_sync_ledger'][index];
    if (row.id !== id || !['available', 'missing'].includes(String(row.status)) || typeof row.truncated !== 'boolean') {
      throw new Error('invalid_log_source');
    }
    return { id, status: row.status as 'available' | 'missing', truncated: row.truncated };
  });
  const events: SafeEvent[] = logs.events.map(value => {
    const event = object(value);
    // Ignore every free-text column, even if a compromised source adds one.
    if (typeof event.code !== 'string' || !Object.hasOwn(eventKinds, event.code)) throw new Error('invalid_event_code');
    return { source, ...eventKinds[event.code as keyof typeof eventKinds], timestamp: timestamp(event.timestamp) };
  });
  const tables = raw.tables.map(value => {
    const table = object(value);
    const name = text(table.name, 128);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('invalid_evidence');
    return { name, columns: count(table.columns), indexes: count(table.indexes) };
  });
  if (new Set(tables.map(table => table.name)).size !== tables.length ||
      count(catalog.products) !== products.length) throw new Error('incomplete_evidence');
  return { capturedAt: timestamp(raw.capturedAt), database: text(raw.database, 128),
    serverAddress: raw.serverAddress === null ? null : text(raw.serverAddress, 64),
    serverPort: raw.serverPort === null ? null : count(raw.serverPort), tables, products,
    catalog: { products: count(catalog.products), translations: count(catalog.translations),
      images: count(catalog.images), details: count(catalog.details) },
    logs: { status: logs.status as 'available' | 'missing', truncated: logs.truncated, sources, events } };
}

export function compareProducts(pc: ProductEvidence[], vps: ProductEvidence[]) {
  const left = new Map(pc.map(row => [row.asin, row]));
  const right = new Map(vps.map(row => [row.asin, row]));
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(asin => {
    const p = left.get(asin) ?? null;
    const v = right.get(asin) ?? null;
    const differences: string[] = [];
    if (!p || !v) differences.push('presence');
    else {
      if (p.originalName !== v.originalName) differences.push('originalName');
      if (p.fullVietnameseName !== v.fullVietnameseName) differences.push('fullVietnameseName');
      if (p.shortVietnameseName !== v.shortVietnameseName) differences.push('shortVietnameseName');
      if (p.coverUrl !== v.coverUrl ||
          JSON.stringify(p.images.map(image => image.url)) !== JSON.stringify(v.images.map(image => image.url))) differences.push('images');
    }
    return { asin, different: differences.length > 0, differences, pc: p, vps: v };
  });
}

export function compareOverview(pc: Evidence, vps: Evidence) {
  const summary = (value: Evidence) => ({ capturedAt: value.capturedAt, database: value.database,
    serverAddress: value.serverAddress, serverPort: value.serverPort, tableCount: value.tables.length,
    columnCount: value.tables.reduce((sum, row) => sum + row.columns, 0),
    indexCount: value.tables.reduce((sum, row) => sum + row.indexes, 0), catalog: value.catalog });
  const p = new Map(pc.tables.map(table => [table.name, table]));
  const v = new Map(vps.tables.map(table => [table.name, table]));
  return { pc: summary(pc), vps: summary(vps),
    tableDifferences: [...new Set([...p.keys(), ...v.keys()])].sort().flatMap(name => {
      const a = p.get(name) ?? null; const b = v.get(name) ?? null;
      return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ name, pc: a, vps: b,
        classification: 'information', syncError: false }];
    }),
    productDifferences: compareProducts(pc.products, vps.products).reduce((result, row) => {
      for (const key of row.differences) result[key] = (result[key] ?? 0) + 1;
      return result;
    }, { presence: 0, originalName: 0, fullVietnameseName: 0, shortVietnameseName: 0, images: 0 } as Record<string, number>) };
}
