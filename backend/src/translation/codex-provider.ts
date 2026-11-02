import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { assessCodexQuota, type CodexQuota } from './codex-quota.js';
import { codexNamePrompt, codexNameSchema } from './codex.js';
import type { NameInput } from './openrouter.js';
import { CODEX_NAME_MODEL } from './codex-store.js';

export interface CodexProvider {
  quota(): Promise<CodexQuota>;
  translate(products: NameInput[]): Promise<string>;
  close(): Promise<void>;
}
export class CodexProviderError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
/** JSONL stdio only; no shell, no raw stderr/payload logging, no credential files.
 * The native CLI handles its existing ChatGPT login in the normal way.
 * https://learn.chatgpt.com/docs/app-server */
class Rpc {
  private nextId = 0;
  private buffer = '';
  private broken = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  onNotification: (message: Message) => void = () => {};
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.broken) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, 'utf8') > 1024 * 1024) return this.fail();
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message: Message;
        try { message = JSON.parse(line) as Message; }
        catch { this.fail(); return; }
        if (!message || typeof message !== 'object') { this.fail(); return; }
        // Never approve a tool/credential/permission request from the server.
        if (message.method && message.id !== undefined) {
          this.send({ id: message.id, error: { code: -32601, message: 'Requests disabled for title translation' } });
          this.fail(); return;
        }
        if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) { this.fail(); return; }
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new CodexProviderError('codex_rpc_error'));
          else pending.resolve(message.result);
        } else this.onNotification(message);
      }
    });
    child.stderr.resume();
    child.on('error', () => this.fail());
    child.on('exit', () => this.fail());
    child.stdin.on('error', () => this.fail());
  }
  send(message: Message) { if (!this.broken) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    if (this.broken) return Promise.reject(new CodexProviderError('codex_unavailable'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail() {
    if (this.broken) return;
    this.broken = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new CodexProviderError('codex_unavailable'));
    }
    this.pending.clear();
    this.onNotification({ method: 'transport/closed' });
    this.child.kill();
  }
}

export function codexLaunch(environment: NodeJS.ProcessEnv = process.env) {
  // Deployment must verify its CLI version, quota/auth and sandbox before opting in.
  // No flag here claims the real-account smoke has already happened.
  if (environment.MITA_CODEX_AUTOMATION_VERIFIED !== '1') throw new CodexProviderError('codex_not_verified');
  const executable = environment.MITA_CODEX_EXECUTABLE ?? '';
  if (!isAbsolute(executable) || !['.exe', '.js', '.mjs'].includes(extname(executable).toLowerCase())) {
    throw new CodexProviderError('codex_executable_required');
  }
  // Codex CLI 0.161.0 app-server does not accept the exec-only flags
  // --ignore-user-config, --ignore-rules or --ephemeral. Per-thread sandbox,
  // approvalPolicy and ephemeral state are enforced below instead.
  const args = ['app-server', '--listen', 'stdio://',
    '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'features.hooks=false',
    '-c', 'features.multi_agent=false', '-c', 'features.remote_plugin=false', '-c', 'web_search="disabled"'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME']) {
    if (environment[name]) env[name] = environment[name];
  }
  return { command: extname(executable).toLowerCase() === '.exe' ? executable : process.execPath,
    args: extname(executable).toLowerCase() === '.exe' ? args : [executable, ...args], env };
}

/** One app-server process supplies both quota and inference: no account mismatch,
 * no API key fallback, no persisted conversations, and a fresh thread per batch. */
export async function createCodexProvider(options: { spawn?: typeof spawn; environment?: NodeJS.ProcessEnv } = {}): Promise<CodexProvider> {
  const launch = codexLaunch(options.environment);
  const cwd = await mkdtemp(join(tmpdir(), 'mita-codex-names-'));
  let rpc: Rpc | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  const close = async () => {
    rpc?.fail();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 2000); child!.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    // Windows can hold app-server temp files briefly after the child exits.
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  };
  try {
    child = (options.spawn ?? spawn)(launch.command, launch.args, { cwd, env: launch.env, windowsHide: true, shell: false });
    rpc = new Rpc(child);
    await rpc.request('initialize', { clientInfo: { name: 'mita_name_translator', version: '1.0.0' } });
    rpc.send({ method: 'initialized', params: {} });
    const account = await rpc.request('account/read', { refreshToken: false }) as { account?: { type?: string; email?: string } };
    if (account?.account?.type !== 'chatgpt' || !account.account.email) throw new CodexProviderError('codex_chatgpt_login_required');
    const email = account.account.email;
    const session = rpc;
    const readQuota = async (): Promise<CodexQuota> => {
        try {
          const current = await session.request('account/read', { refreshToken: false }) as typeof account;
          if (current?.account?.type !== 'chatgpt' || current.account.email !== email) {
            return { allowed: false, reason: 'quota_unknown', remainingFiveHour: null };
          }
          const result = await session.request('account/rateLimits/read');
          return assessCodexQuota(result, new Date());
        } catch { return { allowed: false, reason: 'quota_unknown', remainingFiveHour: null }; }
    };
    return {
      close,
      quota: readQuota,
      translate: async products => {
        const prompt = codexNamePrompt(products);
        // Recheck at the inference boundary too: DB attempt reservations can
        // take time after the job's earlier quota observation.
        const quota = await readQuota();
        if (!quota.allowed) throw new CodexProviderError(quota.reason);
        const started = await session.request('thread/start', {
          model: CODEX_NAME_MODEL, modelProvider: 'openai', cwd, approvalPolicy: 'never', sandbox: 'read-only',
          ephemeral: true, config: { web_search: 'disabled', 'features.shell_tool': false,
            'features.apps': false, 'features.hooks': false, 'features.multi_agent': false,
            'features.remote_plugin': false, mcp_servers: {} }
        }) as { thread?: { id?: string } };
        const threadId = started?.thread?.id;
        if (!threadId) throw new CodexProviderError('codex_thread_unavailable');
        return new Promise<string>((resolve, reject) => {
          let output: string | undefined;
          let settled = false;
          const timer = setTimeout(() => { session.fail(); }, 240000);
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); session.onNotification = () => {};
            if (error) reject(error);
            else if (output !== undefined) resolve(output);
            else reject(new CodexProviderError('codex_empty_output'));
          };
          session.onNotification = message => {
            if (message.method === 'transport/closed') return finish(new CodexProviderError('codex_unavailable'));
            const params = message.params;
            if (params?.threadId !== threadId) return;
            if (message.method === 'item/started' || message.method === 'item/completed') {
              const item = params.item as { type?: string; text?: string } | undefined;
              if (item?.type && !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) {
                // Fail closed if a future CLI exposes any tool despite the config.
                session.fail(); return;
              }
              if (message.method === 'item/completed' && item?.type === 'agentMessage') {
                if (typeof item.text !== 'string' || Buffer.byteLength(item.text, 'utf8') > 256000) { session.fail(); return; }
                output = item.text;
              }
            }
            if (message.method === 'turn/completed') {
              const turn = params.turn as { status?: string } | undefined;
              finish(turn?.status === 'completed' ? undefined : new CodexProviderError('codex_turn_failed'));
            }
          };
          void session.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }],
            model: CODEX_NAME_MODEL, effort: 'low', approvalPolicy: 'never', outputSchema: codexNameSchema,
            sandboxPolicy: { type: 'readOnly', networkAccess: false }
          }).catch(() => finish(new CodexProviderError('codex_turn_start_failed')));
        });
      }
    };
  } catch (error) { await close(); throw error; }
}
