import fs from 'node:fs/promises';

const MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 1000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const streamFiles = {
  supervisor: 'mita-supervisor.jsonl',
  port_control: 'mita-port-control-audit.jsonl',
  backend_control: 'backend-4000/audit.jsonl'
} as const;
export type RuntimeStreamId = keyof typeof streamFiles;
export type SafeRuntimeEvent = {
  source: 'pc'; timestamp: string; category: 'workers' | 'sync' | 'control';
  severity: 'info' | 'warning' | 'error'; title: string;
};
export type RuntimeStream = {
  id: RuntimeStreamId; status: 'available' | 'empty' | 'missing' | 'unreadable'; truncated: boolean;
};
export type SafeRuntimeEvents = { events: SafeRuntimeEvent[]; streams: RuntimeStream[]; truncated: boolean };
type Label = Pick<SafeRuntimeEvent, 'title' | 'severity' | 'category'>;
const label = (title: string, severity: Label['severity'] = 'info', category: Label['category'] = 'control'): Label =>
  ({ title, severity, category });
const supervisorLabels = {
  supervisor_started: label('Đã bật bộ quản lý worker'),
  supervisor_stopped: label('Đã tắt bộ quản lý worker'),
  database_unavailable: label('Không kết nối được cơ sở dữ liệu', 'error', 'workers'),
  day_started: label('Đã mở chu kỳ công việc mới', 'info', 'workers'),
  sync_started: label('Đã bắt đầu đồng bộ', 'info', 'sync')
} as const;
const jobLabels = {
  running: label('Worker đang chạy', 'info', 'workers'),
  completed: label('Worker đã hoàn tất', 'info', 'workers'),
  partial: label('Worker hoàn tất một phần', 'warning', 'workers'),
  skipped: label('Worker đã bỏ qua lượt chạy', 'warning', 'workers'),
  failed: label('Worker gặp lỗi', 'error', 'workers')
} as const;
const backendLabels = {
  'existing-local-postgresql-started': label('Đã bật PostgreSQL cục bộ'),
  'already-stopped': label('Backend đã ở trạng thái tắt'),
  'different-session-left-running': label('Đã giữ backend đang chạy', 'warning'),
  stopped: label('Đã tắt backend'),
  'wrapper-exited-no-restart': label('Trình chạy backend đã thoát', 'warning'),
  'already-running-not-adopted': label('Backend đã chạy; chưa tiếp quản', 'warning'),
  'dependency-install-confirmed': label('Đã xác nhận cài thư viện backend'),
  launched: label('Đã khởi chạy backend'),
  ready: label('Backend đã sẵn sàng'),
  'owned-startup-cleanup-unconfirmed': label('Chưa xác nhận dọn tiến trình backend', 'warning'),
  'rejected-or-failed': label('Thao tác backend bị từ chối hoặc lỗi', 'error')
} as const;

function lookup<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

function safeTimestamp(value: unknown, now: number): string | null {
  if (typeof value !== 'string') return null;
  // Accept producer ISO timestamps, including PowerShell's seven fractional digits.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 ||
      (match[6] !== undefined && (+match[6] > 14 || +match[7] > 59 || +match[6] === 14 && +match[7] !== 0))) return null;
  const date = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1]) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= now - WINDOW_MS && time <= now ? new Date(time).toISOString() : null;
}

function eventLabel(id: RuntimeStreamId, row: Record<string, unknown>): Label | undefined {
  if (id === 'supervisor') {
    const fixed = lookup(supervisorLabels, row.event);
    if (fixed) return fixed;
    if (row.event === 'sync_finished') {
      if (row.exitCode === 0) return label('Đồng bộ đã hoàn tất', 'info', 'sync');
      if (row.exitCode === 2) return label('Đồng bộ hoàn tất một phần', 'warning', 'sync');
      if (row.exitCode === 1 || row.exitCode === -1) return label('Đồng bộ gặp lỗi', 'error', 'sync');
      return;
    }
    if (!['amazon', 'names', 'detail'].includes(row.name as string)) return;
    if (row.event === 'job_state') return lookup(jobLabels, row.state);
    if (row.event === 'code_updated') return label('Đã cập nhật mã worker', 'info', 'workers');
    if (row.event === 'worker_started') return label('Đã khởi chạy worker', 'info', 'workers');
    if (row.event === 'worker_exit') {
      if (row.code === 0) return label('Tiến trình worker đã thoát', 'info', 'workers');
      if (row.code === 1 || row.code === 2 || row.code === -1) return label('Tiến trình worker thoát có lỗi', 'error', 'workers');
      if (row.code === null) return label('Tiến trình worker đã bị ngắt', 'warning', 'workers');
    }
    return;
  }
  if (id === 'port_control') {
    if (row.host !== 'PC' || !['gateway', 'supervisor'].includes(row.service as string)) return;
    const service = row.service === 'gateway' ? 'gateway' : 'bộ quản lý worker';
    if (row.action === 'start' && row.result === 'start-confirmed') return label(`Đã xác nhận bật ${service}`);
    if (row.action === 'stop' && row.result === 'stop-requested') return label(`Đã yêu cầu tắt ${service}`);
    if (['start', 'stop'].includes(row.action as string) && row.result === 'rejected-or-failed') {
      return label(`Thao tác ${service} bị từ chối hoặc lỗi`, 'error');
    }
    return;
  }
  if (id === 'backend_control' && ['Start', 'Stop', 'Restart', 'Status', 'Run'].includes(row.Action as string) &&
      ['Start', 'Dev'].includes(row.Mode as string)) return lookup(backendLabels, row.Result);
}

/** Pure bounded parser for synthetic fixtures. Unknown/free-text fields are never projected.
 * startsMidLine means the byte tail's first line is uncertain, so discard it conservatively.
 * A non-newline-terminated final record is deferred until a later snapshot.
 */
export function parseSafeRuntimeEvents(id: RuntimeStreamId, input: Buffer, now: number, startsMidLine = false) {
  let truncated = startsMidLine || input.length > MAX_BYTES;
  const bytes = input.subarray(Math.max(0, input.length - MAX_BYTES));
  let start = 0;
  if (truncated) {
    const newline = bytes.indexOf(10);
    start = newline < 0 ? bytes.length : newline + 1;
  }
  const events: SafeRuntimeEvent[] = [];
  if (!Number.isFinite(now)) return { events, truncated };
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start);
    if (end < 0) { truncated = true; break; }
    const line = bytes.subarray(start, end).toString('utf8').replace(/^\uFEFF/, '');
    start = end + 1;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const timestamp = safeTimestamp(id === 'supervisor' ? record.at : id === 'port_control' ? record.atUtc : record.AtUtc, now);
    if (!timestamp) continue;
    const safe = eventLabel(id, record);
    if (safe) events.push({ source: 'pc', timestamp, ...safe });
  }
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { events: events.slice(0, MAX_EVENTS), truncated: truncated || events.length > MAX_EVENTS };
}

/** No caller-selected paths, environment configuration, DB, processes or network access.
 * Resolves identically from backend/src/admin and backend/dist/admin.
 * available means nonempty bytes were read, even when all records were rejected/old.
 */
export async function readSafeRuntimeEvents(): Promise<SafeRuntimeEvents> {
  const now = Date.now();
  const results = await Promise.all((Object.keys(streamFiles) as RuntimeStreamId[]).map(async id => {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const stream: RuntimeStream = { id, status: 'unreadable', truncated: false };
    try {
      handle = await fs.open(new URL(`../../../.agents/runtime/${streamFiles[id]}`, import.meta.url), 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('invalid_stream');
      const size = Math.min(stat.size, MAX_BYTES);
      const offset = stat.size - size;
      stream.truncated = offset > 0;
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const { bytesRead } = await handle.read(buffer, read, size - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const parsed = parseSafeRuntimeEvents(id, buffer.subarray(0, read), now, offset > 0);
      stream.status = stat.size === 0 ? 'empty' : 'available';
      stream.truncated = parsed.truncated || read < size;
      return { events: parsed.events, stream };
    } catch (error) {
      // Return only a fixed status, never filesystem error messages or paths.
      stream.status = !handle && (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
      return { events: [] as SafeRuntimeEvent[], stream };
    } finally {
      if (handle) await handle.close().catch(() => { /* Read-only handle; no error text escapes. */ });
    }
  }));
  const events = results.flatMap(result => result.events).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const streams = results.map(result => result.stream);
  return { events: events.slice(0, MAX_EVENTS), streams,
    truncated: streams.some(stream => stream.truncated) || events.length > MAX_EVENTS };
}
