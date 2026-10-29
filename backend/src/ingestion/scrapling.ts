import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SourceError, type Observation, type DiscoveryResult } from './source.js';

const active = new Set<ScraplingSession>();
let stopping = false;
export const isScraplingStopping = () => stopping;
export function stopScraplingSessions() {
  stopping = true;
  for (const session of active) session.close();
}
process.once('exit', stopScraplingSessions);
process.once('SIGINT', stopScraplingSessions);
process.once('SIGTERM', stopScraplingSessions);

/** One sequential persistent Python connection session per sync/import. */
export class ScraplingSession {
  constructor(private readonly transport: { executable?: string; script?: string; timeoutMs?: number } = {}) {}
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending?: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private closed = false;
  private start() {
    if (this.closed || stopping) throw new SourceError('temporary', 'Scrapling session stopped', 'scrapling');
    if (this.child) return;
    const python = this.transport.executable || process.env.MITA_SCRAPLING_PYTHON || fileURLToPath(new URL('../../.venv-scrapling/Scripts/python.exe', import.meta.url));
    // Deliberately exclude DATABASE_URL, API keys and all application secrets.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    try {
      this.child = spawn(python, ['-u', this.transport.script || fileURLToPath(new URL('../../python/amazon_bridge.py', import.meta.url))], { windowsHide: true, env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
    } catch {
      this.closed = true;
      throw new SourceError('temporary', 'Unable to launch Scrapling Python; run scripts/check-scrapling.ps1', 'scrapling');
    }
    active.add(this);
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 2 * 1024 * 1024) { this.close(); return; }
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const reply = JSON.parse(line);
          const pending = this.pending;
          if (!pending || reply.id !== pending.id || typeof reply.ok !== 'boolean') throw Error('Invalid IPC response');
          clearTimeout(pending.timer); this.pending = undefined;
          if (reply.ok) pending.resolve(reply.result);
          else pending.reject(new SourceError(['temporary', 'parse_error', 'rate_limited', 'blocked'].includes(reply.state) ? reply.state : 'parse_error', String(reply.message).slice(0, 1000), 'scrapling',
            typeof reply.retryAfterAt === 'string' ? reply.retryAfterAt : undefined));
        } catch { this.close(); }
      }
    });
    // Drain diagnostics without exposing arbitrary page content or environment data.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
    this.child.stdin.on('error', () => this.close());
  }
  private request(payload: Record<string, unknown>): Promise<unknown> {
    this.start();
    if (this.pending) return Promise.reject(new SourceError('temporary', 'Concurrent Scrapling IPC request rejected', 'scrapling'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      // Allow one explicitly permitted 429 retry after a two-minute cooldown,
      // plus bounded network/parse time; callers may set a shorter test timeout.
      const timer = setTimeout(() => this.close(), this.transport.timeoutMs ?? 240_000);
      this.pending = { id, resolve, reject, timer };
      const line = JSON.stringify({ ...payload, id }) + '\n';
      if (Buffer.byteLength(line) > 4096) { this.close(); return; }
      this.child!.stdin.write(line);
    });
  }
  async detail(asin: string, category: string): Promise<Observation> {
    return await this.request({ op: 'detail', asin, category }) as Observation;
  }
  async discover(category: string, url: string): Promise<DiscoveryResult> {
    const found = new Map<string, Observation>();
    const issues: DiscoveryResult['issues'] = [];
    for (let page = 1; page <= (category === 'thuc-pham-bo-sung' ? 6 : 5); page++) {
      const target = new URL(url);
      if (page > 1) target.searchParams.set(category === 'thuc-pham-bo-sung' ? 'pg' : 'page', String(page));
      try {
        const items = await this.request({ op: 'listing', category, url: target.href }) as Observation[];
        if (!items.length && page === 1) throw new SourceError('parse_error', 'Scrapling listing contains no valid ASINs', 'scrapling');
        let added = 0;
        for (const item of items) if (!found.has(item.asin)) { found.set(item.asin, item); added++; }
        if (!added) break;
      } catch (error) {
        if (page === 1) throw error;
        const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error), 'scrapling');
        issues.push({ adapter: failure.adapter, state: failure.state, message: failure.message,
          retryAfterAt: failure.retryAfterAt, page });
        break;
      }
    }
    return { observations: [...found.values()], issues };
  }
  close() {
    this.closed = true;
    active.delete(this);
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new SourceError('temporary', 'Scrapling subprocess stopped (timeout, cancellation, dependency or protocol failure)', 'scrapling')); }
    this.child?.kill();
  }
}
