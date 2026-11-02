import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AdminError } from './data.js';
import { compareOverview, compareProducts, type Evidence } from './desktop-diagnostics-model.js';
import { readPcEvidence, readVpsEvidence } from './desktop-diagnostics-source.js';
import { readSafeRuntimeEvents, type SafeRuntimeEvents } from './desktop-runtime-events.js';

type Source = { status: 'available' | 'unavailable' | 'disabled'; evidence: Evidence | null };
type Snapshot = { id: string; session: string; createdAt: string; expiresAt: string;
  pc: Source; vps: Source; runtime: SafeRuntimeEvents | null };
// Keep a user-requested frozen comparison available during inspection. Refresh
// creates a new snapshot; the bounded two-session cache prevents unbounded RAM.
const ttl = 2 * 60 * 60 * 1000;

function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > max) {
    throw new AdminError(400, 'Invalid diagnostics range.');
  }
  return Number(value);
}

export function diagnosticsQuery(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminError(400, 'Invalid diagnostics query.');
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) {
    throw new AdminError(400, 'Invalid diagnostics query.');
  }
  return query as Record<string, string | undefined>;
}

function metadata(snapshot: Snapshot) {
  const source = (value: Source, label: string) => ({ label, status: value.status,
    capturedAt: value.evidence?.capturedAt ?? null });
  return { snapshotId: snapshot.id, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt,
    comparisonStatus: snapshot.pc.evidence && snapshot.vps.evidence ? 'available' : 'unavailable',
    sources: { pc: source(snapshot.pc, 'PC'), vps: source(snapshot.vps, 'VPS') } };
}

/** Register in adminRoutes' authenticated, local-only scope; both roles can GET.
 * Refresh once, then reuse snapshotId for every tab/page. Evidence is retained
 * only for that refresh; a new refresh never falls back to previous evidence.
 */
export function registerDesktopDiagnostics(server: FastifyInstance,
  readers = { pc: readPcEvidence, vps: readVpsEvidence }, runtimeReader = readSafeRuntimeEvents) {
  const snapshots = new Map<string, Snapshot>();
  let refreshing = false;
  function prune() {
    for (const [id, snapshot] of snapshots) if (Date.parse(snapshot.expiresAt) <= Date.now()) snapshots.delete(id);
  }
  function get(request: FastifyRequest, query: Record<string, string | undefined>) {
    prune();
    if (!query.snapshotId || !/^[a-f0-9]{48}$/.test(query.snapshotId)) throw new AdminError(400, 'snapshotId is required.');
    const snapshot = snapshots.get(query.snapshotId);
    if (!snapshot || snapshot.session !== request.adminSession!.csrfToken) throw new AdminError(410, 'Snapshot expired. Refresh diagnostics.');
    return snapshot;
  }
  server.get('/desktop/snapshot', async request => {
    diagnosticsQuery(request.query, []);
    prune();
    if (refreshing) throw new AdminError(429, 'Diagnostics refresh in progress.');
    refreshing = true;
    try {
      const [pc, vps, runtime] = await Promise.allSettled([readers.pc(), readers.vps(), runtimeReader()]);
      const now = Date.now();
      const snapshot: Snapshot = { id: randomBytes(24).toString('hex'), session: request.adminSession!.csrfToken,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(),
        pc: pc.status === 'fulfilled' ? { status: 'available', evidence: pc.value } : { status: 'unavailable', evidence: null },
        vps: vps.status === 'fulfilled' ? { status: vps.value ? 'available' : 'disabled', evidence: vps.value }
          : { status: 'unavailable', evidence: null },
        runtime: runtime.status === 'fulfilled' ? runtime.value : null };
      // Bound memory globally, and invalidate this session's older refresh.
      for (const [id, old] of snapshots) if (old.session === snapshot.session) snapshots.delete(id);
      while (snapshots.size >= 2) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(snapshot.id, snapshot);
      return metadata(snapshot);
    } finally { refreshing = false; }
  });
  server.get('/desktop/products', async request => {
    const query = diagnosticsQuery(request.query, ['snapshotId', 'page', 'pageSize', 'onlyDifferent', 'asin', 'q']);
    const snapshot = get(request, query);
    const page = integer(query.page, 1, 100000);
    const pageSize = integer(query.pageSize, 50, 200);
    if (query.onlyDifferent !== undefined && !['0', '1'].includes(query.onlyDifferent) ||
        query.asin !== undefined && !/^[A-Z0-9]{10}$/.test(query.asin) ||
        query.q !== undefined && (query.q.length > 120 || /[\u0000-\u001f]/.test(query.q))) throw new AdminError(400, 'Invalid products filter.');
    const pc = snapshot.pc.evidence; const vps = snapshot.vps.evidence;
    // Browsing an available side must still work while the other source is
    // unavailable; comparisons are unknown, never fabricated as differences.
    if (!pc && !vps) return { ...metadata(snapshot), page, pageSize, total: null, items: [],
      reason: 'Both catalog sources are unavailable.' };
    const search = query.q?.trim().normalize('NFKC').toLocaleLowerCase('vi-VN');
    const rows = (pc && vps ? compareProducts(pc.products, vps.products) :
      (pc?.products ?? vps?.products ?? []).map(product => ({ asin: product.asin,
        different: false, differences: [] as string[], pc: pc ? product : null, vps: vps ? product : null }))).filter(row =>
      (query.onlyDifferent !== '1' || row.different) && (!query.asin || query.asin === row.asin) &&
      (!search || [row.asin, row.pc?.originalName, row.pc?.fullVietnameseName, row.pc?.shortVietnameseName,
        row.vps?.originalName, row.vps?.fullVietnameseName, row.vps?.shortVietnameseName]
        .some(value => value?.normalize('NFKC').toLocaleLowerCase('vi-VN').includes(search))));
    return { ...metadata(snapshot), page, pageSize, total: rows.length,
      items: rows.slice((page - 1) * pageSize, page * pageSize) };
  });
  server.get('/desktop/overview', async request => {
    const query = diagnosticsQuery(request.query, ['snapshotId']);
    const snapshot = get(request, query);
    return { ...metadata(snapshot), comparison: snapshot.pc.evidence && snapshot.vps.evidence
      ? compareOverview(snapshot.pc.evidence, snapshot.vps.evidence) : null };
  });
  server.get('/desktop/logs', async request => {
    const query = diagnosticsQuery(request.query, ['snapshotId', 'hours', 'limit', 'source', 'severity']);
    const snapshot = get(request, query);
    const hours = integer(query.hours, 24, 168); const limit = integer(query.limit, 100, 500);
    if (query.source && !['pc', 'vps'].includes(query.source) ||
        query.severity && !['info', 'warning', 'error'].includes(query.severity)) throw new AdminError(400, 'Invalid logs filter.');
    const since = Date.parse(snapshot.createdAt) - hours * 3600000;
    const sources = (['pc', 'vps'] as const).filter(source => !query.source || query.source === source)
      .map(source => ({ source,
        status: snapshot[source].evidence?.logs.status ?? snapshot[source].status,
        streams: snapshot[source].evidence?.logs.sources ?? null,
        truncated: snapshot[source].evidence?.logs.truncated ?? false,
        // Only pre-approved metadata from fixed local runtime JSONL is ingested.
        runtimeLogStatus: source === 'pc' ? (snapshot.runtime === null ? 'unavailable' :
          snapshot.runtime.streams.some(stream => stream.status === 'available') ? 'available' : 'missing') : 'missing',
        runtimeStreams: source === 'pc' ? snapshot.runtime?.streams ?? null : null }));
    const events = ([...(['pc', 'vps'] as const).flatMap(source => snapshot[source].evidence?.logs.events ?? []),
      ...(snapshot.runtime?.events ?? [])])
      .filter(event => Date.parse(event.timestamp) >= since && (!query.source || event.source === query.source) &&
        (!query.severity || event.severity === query.severity)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return { ...metadata(snapshot), hours, sources, truncated: events.length > limit || sources.some(source => source.truncated) ||
      (snapshot.runtime?.truncated ?? false),
      items: events.slice(0, limit) };
  });
}
