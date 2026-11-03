import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { SourceError, type Observation, type DiscoveryResult } from './source.js';

const active = new Set<ScraplingSession>();
export class QuoteTransportError extends Error {
  constructor(public code: 'amazon_unavailable' | 'amazon_blocked' | 'amazon_rate_limited' | 'amazon_response_too_large',
    public retryAfterAt?: string) { super(code); }
}
const maxQuoteBody = 3_000_000;
const maxQuoteCompressed = 1_500_000;
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
  private pending?: { id: number; quote: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
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
      if (this.buffer.length > 2 * 1024 * 1024) {
        this.close(this.pending?.quote ? new QuoteTransportError('amazon_response_too_large') : undefined); return;
      }
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
          else if (pending.quote) {
            const code = reply.state === 'rate_limited' ? 'amazon_rate_limited' : reply.state === 'blocked' ? 'amazon_blocked' :
              reply.code === 'amazon_response_too_large' ? 'amazon_response_too_large' : 'amazon_unavailable';
            const retry = typeof reply.retryAfterAt === 'string' && Number.isFinite(Date.parse(reply.retryAfterAt))
              ? new Date(reply.retryAfterAt).toISOString() : undefined;
            pending.reject(new QuoteTransportError(code, retry));
          }
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
  private request(payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    this.start();
    if (this.pending) return Promise.reject(new SourceError('temporary', 'Concurrent Scrapling IPC request rejected', 'scrapling'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      // Allow one explicitly permitted 429 retry after a two-minute cooldown,
      // plus bounded network/parse time; callers may set a shorter test timeout.
      const timer = setTimeout(() => this.close(), timeoutMs ?? this.transport.timeoutMs ?? 240_000);
      this.pending = { id, quote: payload.op === 'quote', resolve, reject, timer };
      const line = JSON.stringify({ ...payload, id }) + '\n';
      if (Buffer.byteLength(line) > 4096) { this.close(); return; }
      this.child!.stdin.write(line);
    });
  }
  async quote(asin: string, quantity: number, timeoutMs: number): Promise<{ html: string; observedAt: Date }> {
    if (typeof asin !== 'string' || asin.length !== 10 || !/^[A-Z0-9]{10}$/.test(asin) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new QuoteTransportError('amazon_unavailable');
    const url = `https://www.amazon.co.jp/dp/${asin}?quantity=${quantity}`;
    const started = Date.now();
    const result = await this.request({ op: 'quote', asin, quantity, url, timeoutMs }, timeoutMs);
    if (!result || typeof result !== 'object') throw new QuoteTransportError('amazon_unavailable');
    const reply = result as Record<string, unknown>;
    const observedAt = new Date(typeof reply.observedAt === 'string' ? reply.observedAt : NaN);
    if (reply.asin !== asin || reply.quantity !== quantity || reply.url !== url ||
        !Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== reply.observedAt ||
        observedAt.getTime() < started || observedAt.getTime() > Date.now() || Date.now() - started > timeoutMs ||
        !Number.isInteger(reply.htmlBytes) || Number(reply.htmlBytes) < 1 || typeof reply.htmlZlibBase64 !== 'string') {
      throw new QuoteTransportError('amazon_unavailable');
    }
    if (Number(reply.htmlBytes) > maxQuoteBody || reply.htmlZlibBase64.length > Math.ceil(maxQuoteCompressed / 3) * 4) {
      throw new QuoteTransportError('amazon_response_too_large');
    }
    if (reply.htmlZlibBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.htmlZlibBase64)) {
      throw new QuoteTransportError('amazon_unavailable');
    }
    let body: Buffer;
    try {
      const compressed = Buffer.from(reply.htmlZlibBase64, 'base64');
      if (compressed.toString('base64') !== reply.htmlZlibBase64) throw Error('Noncanonical base64');
      // Node's info:true result is not represented by the installed @types/node overload.
      const decoded = inflateSync(compressed, { maxOutputLength: maxQuoteBody, info: true }) as unknown as
        { buffer: Buffer; engine: { bytesWritten: number } };
      if (decoded.engine.bytesWritten !== compressed.length) throw Error('Trailing compressed data');
      body = decoded.buffer;
    } catch (error) {
      throw new QuoteTransportError((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
        ? 'amazon_response_too_large' : 'amazon_unavailable');
    }
    if (body.length !== reply.htmlBytes || Date.now() - started > timeoutMs) throw new QuoteTransportError('amazon_unavailable');
    try { return { html: new TextDecoder('utf-8', { fatal: true }).decode(body), observedAt }; }
    catch { throw new QuoteTransportError('amazon_unavailable'); }
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
  close(error?: Error) {
    this.closed = true;
    active.delete(this);
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error ?? new SourceError('temporary', 'Scrapling subprocess stopped (timeout, cancellation, dependency or protocol failure)', 'scrapling')); }
    this.child?.kill();
  }
}
