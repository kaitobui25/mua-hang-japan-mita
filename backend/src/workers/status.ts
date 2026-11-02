import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/pool.js';
import { nextWorkerWindow, readWorkerSettings } from './settings.js';
import { codexNameProgress } from '../translation/codex-store.js';

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const logs = join(root, '.agents', 'runtime');
type JobRecord = { state?: string; updatedAt?: string; runId?: string; reason?: string };
type Snapshot = { day?: string; jobs?: Record<string, JobRecord>; sync?: JobRecord };

async function currentSnapshot(): Promise<Snapshot | null> {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10);
  try {
    const raw = await readFile(join(logs, 'mita-daily-' + today + '.json'), 'utf8');
    if (raw.length > 1024 * 1024) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as Snapshot;
    return snapshot.day === today ? snapshot : null;
  } catch { return null; }
}

/** Counts are DB-authoritative; legacy snapshot is displayed separately, not as proof of a live process. */
export async function workerOverview(now = new Date()) {
  const settings = await readWorkerSettings();
  const snapshot = await currentSnapshot();
  const coverage = await db.query<{ total: number; translated: number }>(
    "SELECT count(*)::int AS total,count(*) FILTER (WHERE t.name IS NOT NULL AND t.status IN ('success','warning'))::int AS translated FROM products p LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'");
  const detail = await db.query<{ translated: number; total: number }>(
    'SELECT count(*) FILTER (WHERE translated IS NOT NULL)::int AS translated,count(*)::int AS total FROM local_detail_translation_items');
  let codex: Awaited<ReturnType<typeof codexNameProgress>> | null = null;
  let warningAsins: { asin: string; issues: unknown; outcome: string }[] = [];
  let warningTotal = 0;
  try {
    codex = await codexNameProgress(db);
    if (codex.lastRun) {
      const result = await db.query<{ asin: string; issues: unknown; outcome: string }>(`
        SELECT asin,issues,outcome FROM codex_name_run_items WHERE run_id=$1
          AND jsonb_array_length(issues)>0 ORDER BY asin LIMIT 50`, [codex.lastRun.id]);
      warningAsins = result.rows;
      const total = await db.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM codex_name_run_items WHERE run_id=$1
          AND jsonb_array_length(issues)>0`, [codex.lastRun.id]);
      warningTotal = total.rows[0]?.n ?? 0;
    }
  } catch (error) {
    // Old installations may not yet have the additive Codex schema.
    // All other DB failures remain visible instead of fabricating zero metrics.
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '42P01') throw error;
  }
  const workers: Record<string, unknown> = {};
  for (const name of ['amazon','names','detail','sync'] as const) {
    const previous = name === 'sync' ? snapshot?.sync : snapshot?.jobs?.[name];
    workers[name] = {
      state: previous?.state ?? 'unknown', observedAt: previous?.updatedAt ?? null,
      lastRun: previous?.runId ?? null, reason: previous?.reason ?? null,
      nextRun: name === 'sync' ? null : nextWorkerWindow(name, settings, now),
      nextActions: name === 'sync' ? 'Chờ 3 worker kết thúc và điều kiện sync' :
        name === 'names' ? settings.engine === 'codex' ? 'Tên mới/lỗi rồi dịch lại luân phiên, tối đa 300 ASIN/ngày' :
          'Tên còn thiếu/lỗi theo quota OpenRouter' :
          name === 'amazon' ? 'Thu thập sản phẩm theo lịch, tôn trọng chặn nguồn' :
          'Dịch các slot chi tiết chưa hoàn tất',
      coverage: name === 'names' ? coverage.rows[0] : name === 'detail' ? detail.rows[0] : null,
      rotation: name === 'names' ? codex?.rotation ?? null : null,
      lastResult: name === 'names' ? codex?.lastRun ?? null : null,
      warningAsins: name === 'names' ? warningAsins : [],
      warningAsinsTotal: name === 'names' ? warningTotal : 0,
      warnings: name === 'names' ? codex?.lastRun?.warnings ?? null : null,
      failed: name === 'names' ? codex?.lastRun?.failed ?? null : null,
      success: name === 'names' ? codex?.lastRun?.translated ?? null : null,
      logPath: join(logs, name === 'sync' ? 'nightly-sync.out.log' : name + '.out.log'),
      processLive: null
    };
  }
  return { settings, workers, snapshotObserved: snapshot !== null, statusSource: 'snapshot+database;process-unverified' };
}
