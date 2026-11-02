import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseSafeRuntimeEvents, readSafeRuntimeEvents, type RuntimeStreamId } from '../src/admin/desktop-runtime-events.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const at = '2026-11-02T11:00:00Z';
const limit = 512 * 1024;
const jsonl = (...rows: unknown[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const supervisor = (event: string, extra = {}) => ({ at, event, ...extra });
const port = (extra = {}) => ({ atUtc: at, host: 'PC', service: 'gateway', action: 'start', result: 'start-confirmed', ...extra });
const backend = (extra = {}) => ({ AtUtc: at, Action: 'Start', Mode: 'Dev', Result: 'ready', ...extra });
const parse = (id: RuntimeStreamId, ...rows: unknown[]) => parseSafeRuntimeEvents(id, jsonl(...rows), now);

test('projects only fixed Vietnamese labels and normalized time; never forwards private fields', () => {
  const secret = 'PRIVATE-CUSTOMER-cookie-password-path-session-sid';
  const privateFields = { reason: secret, pid: 987654, day: secret, mode: secret, code: secret,
    message: secret, SessionId: secret, UserSid: secret, path: secret, credentials: secret };
  const results = [
    parse('supervisor', supervisor('worker_started', { ...privateFields, name: 'amazon' })),
    parse('port_control', { ...privateFields, ...port() }),
    parse('backend_control', { ...privateFields, ...backend() })
  ];
  for (const result of results) {
    assert.equal(result.events.length, 1);
    assert.deepEqual(Object.keys(result.events[0]).sort(), ['category', 'severity', 'source', 'timestamp', 'title']);
    assert.equal(result.events[0].source, 'pc');
    assert.equal(result.events[0].timestamp, '2026-11-02T11:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|987654|SessionId|UserSid|credentials/);
  }
  assert.equal(results[0].events[0].title, 'Đã khởi chạy worker');
});

test('maps the ten supervisor codes and known job/exit states without claiming partial sync succeeded', () => {
  const result = parse('supervisor',
    ...['supervisor_started', 'supervisor_stopped', 'database_unavailable', 'day_started', 'sync_started'].map(event => supervisor(event)),
    supervisor('code_updated', { name: 'names' }), supervisor('worker_started', { name: 'detail' }),
    supervisor('worker_exit', { name: 'amazon', code: 0 }),
    supervisor('worker_exit', { name: 'amazon', code: 1 }),
    supervisor('worker_exit', { name: 'amazon', code: null }),
    ...['running', 'completed', 'partial', 'skipped', 'failed'].map(state => supervisor('job_state', { name: 'names', state })),
    ...[0, 2, 1, -1].map(exitCode => supervisor('sync_finished', { exitCode })));
  assert.equal(result.events.length, 19);
  assert.ok(result.events.some(event => event.severity === 'error' && event.category === 'workers'));
  assert.ok(result.events.some(event => event.title === 'Đồng bộ hoàn tất một phần' && event.severity === 'warning'));
  assert.ok(result.events.some(event => event.title === 'Đồng bộ đã hoàn tất' && event.severity === 'info'));
});

test('rejects unknown/prototype enums, malformed records, and cross-stream field casing', () => {
  assert.equal(parse('supervisor',
    supervisor('review_sync_finished'), supervisor('__proto__'), supervisor('constructor'),
    supervisor('worker_started', { name: 'unknown' }), supervisor('job_state', { name: 'amazon', state: 'constructor' }),
    supervisor('sync_finished', { exitCode: '0' }), supervisor('worker_exit', { name: 'detail', code: 999 }),
    { AtUtc: at, event: 'day_started' }, null, [], 'raw secret').events.length, 0);
  assert.equal(parse('port_control', port({ host: 'VPS' }), port({ service: 'private-service' }),
    port({ action: 'stop' }), port({ result: '__proto__' }), backend()).events.length, 0);
  assert.equal(parse('backend_control', backend({ Mode: 'private-mode' }), backend({ Action: '__proto__' }),
    backend({ Result: 'constructor' }), port()).events.length, 0);
  const mixed = Buffer.from('not json\n{"event":\n' + jsonl(supervisor('day_started')).toString());
  assert.equal(parseSafeRuntimeEvents('supervisor', mixed, now).events.length, 1);
});

test('validates calendar, timezone and inclusive seven-day window; excludes future times', () => {
  const valid = ['2026-10-26T12:00:00Z', '2026-11-02T12:00:00Z', '2026-11-02T20:00:00.1234567+09:00'];
  const invalid = ['2026-10-26T11:59:59.999Z', '2026-11-02T12:00:00.001Z',
    '2026-02-30T10:00:00Z', '2026-11-02T24:00:00Z', '2026-11-02T11:00:60Z',
    '2026-11-02T11:00:00+15:00', '2026-11-02T11:00:00+09:99', '2026-11-02 11:00:00', 'yesterday', 123, null];
  const result = parse('supervisor', ...[...valid, ...invalid].map(at => supervisor('day_started', { at })));
  assert.equal(result.events.length, valid.length);
  assert.equal(result.events[0].timestamp, '2026-11-02T12:00:00.000Z');
  assert.equal(parseSafeRuntimeEvents('supervisor', jsonl(supervisor('day_started')), NaN).events.length, 0);
});

test('handles PowerShell BOM/CRLF, uncertain first line and incomplete final line', () => {
  const bytes = Buffer.from('\uFEFF' + jsonl(backend()).toString().replace(/\n/g, '\r\n'));
  assert.equal(parseSafeRuntimeEvents('backend_control', bytes, now).events.length, 1);
  const two = jsonl(supervisor('day_started'), supervisor('sync_started'));
  const tail = parseSafeRuntimeEvents('supervisor', two, now, true);
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].category, 'sync');
  assert.equal(tail.truncated, true);
  const final = parseSafeRuntimeEvents('supervisor', Buffer.from(two.toString().trimEnd()), now);
  assert.equal(final.events.length, 1);
  assert.equal(final.truncated, true);
  assert.deepEqual(parseSafeRuntimeEvents('supervisor', Buffer.from('partial'), now, true), { events: [], truncated: true });
});

test('parser bounds bytes and keeps newest 1000 even for unordered input', () => {
  const rows = Array.from({ length: 1100 }, (_, i) => supervisor('day_started', { at: new Date(now - i * 1000).toISOString() }));
  const result = parse('supervisor', ...rows.reverse());
  assert.equal(result.events.length, 1000);
  assert.equal(result.events[0].timestamp, new Date(now).toISOString());
  assert.equal(result.truncated, true);
  const huge = Buffer.concat([Buffer.alloc(limit, 120), Buffer.from('\n'), jsonl(supervisor('sync_started'))]);
  const bounded = parseSafeRuntimeEvents('supervisor', huge, now);
  assert.equal(bounded.events.length, 1);
  assert.equal(bounded.truncated, true);
});

test('control audit results use safe enums and stop-requested remains a request', () => {
  const ports = parse('port_control', port(), port({ service: 'supervisor' }),
    port({ action: 'stop', result: 'stop-requested' }), port({ result: 'rejected-or-failed' }));
  assert.equal(ports.events.length, 4);
  assert.ok(ports.events.some(event => event.title === 'Đã yêu cầu tắt gateway'));
  const results = ['existing-local-postgresql-started', 'already-stopped', 'different-session-left-running',
    'stopped', 'wrapper-exited-no-restart', 'already-running-not-adopted', 'dependency-install-confirmed',
    'launched', 'ready', 'owned-startup-cleanup-unconfirmed', 'rejected-or-failed'];
  assert.equal(parse('backend_control', ...results.map(Result => backend({ Result }))).events.length, results.length);
});

// All filesystem access below is mocked. No private runtime paths or DB are read.
type Fixture = Buffer | 'missing' | 'denied' | 'directory' | 'read-error' | 'short-read';
function installFiles(fixtures: Fixture[], chunkSize = Infinity) {
  let opened = 0;
  const reads: { index: number; length: number; position: number }[] = [];
  const closed: number[] = [];
  const paths: string[] = [];
  const open = mock.method(fs, 'open', (async (path: URL, flags: string) => {
    const index = opened++;
    paths.push(fileURLToPath(path).replace(/\\/g, '/'));
    assert.equal(flags, 'r');
    const fixture = fixtures[index];
    if (fixture === 'missing' || fixture === 'denied') throw Object.assign(new Error('PRIVATE'), { code: fixture === 'missing' ? 'ENOENT' : 'EACCES' });
    return {
      stat: async () => ({ size: Buffer.isBuffer(fixture) ? fixture.length : 100, isFile: () => fixture !== 'directory' }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads.push({ index, length, position });
        if (fixture === 'read-error') throw new Error('PRIVATE');
        if (!Buffer.isBuffer(fixture)) return { bytesRead: 0 };
        const bytesRead = fixture.copy(buffer, offset, position, position + Math.min(length, chunkSize));
        return { bytesRead };
      },
      close: async () => { closed.push(index); }
    };
  }) as unknown as typeof fs.open);
  return { open, reads, closed, paths };
}

test('reader distinguishes empty, missing and unreadable without leaking errors', async () => {
  const files = installFiles([Buffer.alloc(0), 'missing', 'denied']);
  try {
    const result = await readSafeRuntimeEvents();
    assert.deepEqual(result.streams.map(stream => stream.status), ['empty', 'missing', 'unreadable']);
    assert.deepEqual(result.events, []);
    assert.equal(result.truncated, false);
    assert.deepEqual(files.closed, [0]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|runtime|ENOENT|EACCES/);
    assert.ok(files.paths[0].endsWith('/.agents/runtime/mita-supervisor.jsonl'));
    assert.ok(files.paths[1].endsWith('/.agents/runtime/mita-port-control-audit.jsonl'));
    assert.ok(files.paths[2].endsWith('/.agents/runtime/backend-4000/audit.jsonl'));
  } finally { files.open.mock.restore(); }
});

test('reader bounds tail reads, handles short chunks, closes handles, and merges newest 1000 globally', async () => {
  const clock = mock.method(Date, 'now', () => now);
  const rows = Array.from({ length: 600 }, (_, i) => supervisor('day_started', { at: new Date(now - i * 1000).toISOString() }));
  const data = Buffer.concat([Buffer.alloc(limit, 120), Buffer.from('\n'), jsonl(...rows)]);
  const files = installFiles([data, jsonl(...Array.from({ length: 600 }, () => port())), Buffer.alloc(0)], 8192);
  try {
    const result = await readSafeRuntimeEvents();
    assert.equal(result.events.length, 1000);
    assert.equal(result.truncated, true);
    assert.equal(result.streams[0].truncated, true);
    assert.equal(result.events[0].timestamp, new Date(now).toISOString());
    assert.equal(result.events.filter(event => event.category === 'workers').length, 600);
    assert.ok(result.events.every((event, i) => !i || result.events[i - 1].timestamp >= event.timestamp));
    assert.equal(files.reads.find(read => read.index === 0)?.position, data.length - limit);
    assert.ok(files.reads.every(read => read.length <= limit));
    assert.deepEqual(files.closed.sort(), [0, 1, 2]);
  } finally { files.open.mock.restore(); clock.mock.restore(); }
});

test('global event cap reports truncation independently of each stream; filtered nonempty is available', async () => {
  const clock = mock.method(Date, 'now', () => now);
  const files = installFiles([
    jsonl(...Array.from({ length: 600 }, () => supervisor('day_started'))),
    jsonl(...Array.from({ length: 600 }, () => port())),
    Buffer.from('invalid JSON\n')
  ]);
  try {
    const result = await readSafeRuntimeEvents();
    assert.equal(result.events.length, 1000);
    assert.equal(result.truncated, true);
    assert.ok(result.streams.every(stream => stream.status === 'available' && !stream.truncated));
  } finally { files.open.mock.restore(); clock.mock.restore(); }
});

test('reader rejects non-files/read errors and reports concurrent shrink as truncated', async () => {
  const files = installFiles(['directory', 'read-error', 'short-read']);
  try {
    const result = await readSafeRuntimeEvents();
    assert.deepEqual(result.streams.map(stream => stream.status), ['unreadable', 'unreadable', 'available']);
    assert.equal(result.streams[2].truncated, true);
    assert.equal(result.truncated, true);
    assert.deepEqual(files.closed.sort(), [0, 1, 2]);
  } finally { files.open.mock.restore(); }
});
