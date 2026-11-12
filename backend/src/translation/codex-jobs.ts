import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import { config } from '../config.js';
import { codexNamePrompt, parseCodexNames } from './codex.js';
import { assertCodexNameSchema, saveCodexName, type CodexSnapshot } from './codex-store.js';
import { createCodexProvider, CodexProviderError, CodexQuotaBeforeInferenceError, type CodexProvider } from './codex-provider.js';

export type CodexNameRun = {
  version: 1; worker: 'names'; engine: 'codex'; runId: string; trigger: 'manual' | 'scheduled';
  state: 'completed' | 'partial' | 'deferred'; reason: string | null;
  selected: number; translated: number; failed: number; skipped: number; warnings: number; paused: boolean;
};
type Connection = Pick<PoolClient, 'query' | 'release'>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function codexRunInput(input: { runId?: string; trigger?: string; maxProducts?: number }) {
  const runId = input.runId ?? randomUUID(), trigger = input.trigger ?? 'manual';
  const maxProducts = input.maxProducts ?? (trigger === 'scheduled' ? 300 : 20);
  if (!uuid.test(runId) || !['manual', 'scheduled'].includes(trigger) ||
      !Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 300) throw new Error('invalid_codex_run');
  return { runId, trigger: trigger as 'manual' | 'scheduled', maxProducts };
}

function* batches(rows: CodexSnapshot[]) {
  let packed: CodexSnapshot[] = [];
  for (const row of rows) {
    try { codexNamePrompt([...packed, row]); }
    catch { if (packed.length) { yield packed; packed = []; } }
    packed.push(row);
  }
  if (packed.length) yield packed;
}

/** No imports/startup/catch-up call this function. The caller supplies the explicit
 * manual/scheduled dispatch; one scheduled run per JST day is enforced durably. */
export async function translateCodexNames(options: {
  runId?: string; trigger?: string; maxProducts?: number; signal?: AbortSignal;
  connect?: () => Promise<Connection>; provider?: () => Promise<CodexProvider>;
} = {}): Promise<CodexNameRun> {
  const input = codexRunInput(options);
  const run: CodexNameRun = { version: 1, worker: 'names', engine: 'codex', runId: input.runId, trigger: input.trigger,
    state: 'deferred', reason: null, selected: 0, translated: 0, failed: 0, skipped: 0, warnings: 0, paused: false };
  const target = new URL(config.databaseUrl);
  if (process.env.MITA_VPS_WORKER === '1' || !['postgres:', 'postgresql:'].includes(target.protocol) ||
      target.hostname !== '127.0.0.1' || target.port !== '5433' || target.search || target.hash) {
    throw new Error('codex_requires_local_database');
  }
  const client = await (options.connect ?? (() => db.connect()))();
  const acquired: number[] = [];
  let provider: CodexProvider | undefined;
  try {
    await client.query('SET search_path TO public');
    await assertCodexNameSchema(client);
    const identity = await client.query<{ database: string; address: string; port: number }>(`
      SELECT current_database() AS database,host(inet_server_addr()) AS address,inet_server_port() AS port`);
    if (identity.rows[0]?.database !== decodeURIComponent(target.pathname.slice(1)) || identity.rows[0]?.port !== 5433 ||
        !['127.0.0.1', '::1'].includes(identity.rows[0]?.address)) {
      throw new Error('codex_database_identity_mismatch');
    }
    // Manual work excludes *all* workers and catalog sync (which takes the same
    // three locks). A busy lock rejects immediately; no queued manual dispatch.
    const locks = input.trigger === 'manual' ? [70400200, 70400300, 70400301] : [70400300];
    for (const key of locks) {
      const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [key]);
      if (!result.rows[0]?.acquired) return { ...run, reason: 'worker_or_sync_busy', paused: true };
      acquired.push(key);
    }
    // A previous uncertain run requires inspection; never infer that releasing
    // the process lock means its DB commit/run outcome is known.
    const unresolved = await client.query('SELECT id FROM codex_name_runs WHERE state=\'running\' LIMIT 1');
    if (unresolved.rows.length) return { ...run, reason: 'previous_run_unresolved', paused: true };
    const inserted = await client.query(`INSERT INTO codex_name_runs(id,trigger,jst_day)
      VALUES($1,$2,(now() AT TIME ZONE 'Asia/Tokyo')::date) ON CONFLICT DO NOTHING RETURNING id`, [input.runId, input.trigger]);
    if (!inserted.rows.length) return { ...run, reason: 'run_already_recorded', paused: true };
    const finish = async (reason: string | null) => {
      run.reason = reason;
      run.paused = reason !== null;
      run.state = run.translated || run.failed || run.skipped ?
        (reason || run.failed || run.skipped ? 'partial' : 'completed') : (reason ? 'deferred' : 'completed');
      await client.query(`UPDATE codex_name_runs SET state=$2,reason=$3,selected=$4,translated=$5,failed=$6,
        skipped=$7,warnings=$8,finished_at=now() WHERE id=$1 AND state='running'`,
      [run.runId, run.state, run.reason, run.selected, run.translated, run.failed, run.skipped, run.warnings]);
      return run;
    };
    try { provider = await (options.provider ?? createCodexProvider)(); }
    catch (error) { return await finish(error instanceof CodexProviderError ? error.reason : 'codex_unavailable'); }
    let firstQuota;
    try { firstQuota = await provider.quota(); } catch { return await finish('quota_unknown'); }
    if (!firstQuota.allowed) return await finish(firstQuota.reason);
    await client.query('BEGIN');
    let cycleId: string;
    let candidates: CodexSnapshot[];
    try {
      // Exhausted items stay visible as incomplete, but do not deadlock rotation.
      await client.query(`UPDATE codex_name_cycles c SET finished_at=now() WHERE finished_at IS NULL
        AND EXISTS (SELECT 1 FROM codex_name_cycle_items i WHERE i.cycle_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM codex_name_cycle_items i WHERE i.cycle_id=c.id AND i.completed_at IS NULL AND i.attempts<3)`);
      await client.query(`INSERT INTO codex_name_cycles DEFAULT VALUES ON CONFLICT DO NOTHING`);
      const cycle = await client.query<{ id: string }>('SELECT id FROM codex_name_cycles WHERE finished_at IS NULL');
      cycleId = cycle.rows[0].id;
      // Cohort grows with newly observed products; progress reports its actual size.
      await client.query(`INSERT INTO codex_name_cycle_items(cycle_id,asin)
        SELECT $1,asin FROM products ON CONFLICT DO NOTHING`, [cycleId]);
      // Revisit completed titles if Amazon has changed the source since translation.
      // A successful old translation is otherwise omitted until the next full cycle.
      await client.query(`UPDATE codex_name_cycle_items i
        SET completed_at=NULL,attempts=0,last_attempt_at=NULL
        FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
        WHERE i.cycle_id=$1 AND i.asin=p.asin AND i.completed_at IS NOT NULL
          AND t.name_model='gpt-6.1-sol' AND t.name_source->>'name' IS DISTINCT FROM p.name`, [cycleId]);
      const selected = await client.query<CodexSnapshot>(`SELECT p.asin,p.name,p.brand,t.name AS prior_name,t.updated_at::text AS prior_updated_at
        FROM codex_name_cycle_items i JOIN products p ON p.asin=i.asin
        LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
        WHERE i.cycle_id=$1 AND i.completed_at IS NULL AND i.attempts<3
        ORDER BY CASE WHEN t.name_model='gpt-6.1-sol' AND
            t.name_source->>'name' IS DISTINCT FROM p.name THEN -1
          WHEN t.name IS NULL OR t.status IN ('failed','pending','warning') THEN 0 ELSE 1 END,
          i.last_attempt_at ASC NULLS FIRST,t.translated_at ASC NULLS FIRST,p.asin LIMIT $2`, [cycleId, input.maxProducts]);
      candidates = selected.rows;
      for (const row of candidates) await client.query(`INSERT INTO codex_name_run_items(run_id,asin,source,prior_name,prior_updated_at)
        VALUES($1,$2,$3,$4,$5)`, [run.runId, row.asin,
        JSON.stringify({ asin: row.asin, name: row.name, brand: row.brand }), row.prior_name, row.prior_updated_at]);
      await client.query('UPDATE codex_name_runs SET cycle_id=$2,selected=$3 WHERE id=$1', [run.runId, cycleId, candidates.length]);
      await client.query('COMMIT');
      run.selected = candidates.length;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    const failed = async (rows: CodexSnapshot[], issue: string) => {
      for (const row of rows) await client.query(`UPDATE codex_name_run_items SET outcome='failed',issues=$3
        WHERE run_id=$1 AND asin=$2 AND outcome='selected'`, [run.runId, row.asin, JSON.stringify([issue])]);
      run.failed += rows.length;
    };
    for (const packed of batches(candidates)) {
      let pending = packed;
      // Retry only invalid output; a provider/transport error terminates the run.
      // Durable cycle attempts bound retries across crashes and future runs.
      for (let attempt = 0; pending.length && attempt < 3; attempt++) {
        if (options.signal?.aborted) return await finish('cancelled');
        let quota;
        try { quota = await provider.quota(); } catch { return await finish('quota_unknown'); }
        if (!quota.allowed) return await finish(quota.reason);
        const reserved: CodexSnapshot[] = [];
        await client.query('BEGIN');
        try {
          for (const row of pending) {
            const reservation = await client.query(`UPDATE codex_name_cycle_items SET attempts=attempts+1,last_attempt_at=now()
              WHERE cycle_id=$1 AND asin=$2 AND attempts<3 AND completed_at IS NULL RETURNING asin`, [cycleId, row.asin]);
            if (reservation.rows.length) {
              await client.query('UPDATE codex_name_run_items SET attempts=attempts+1 WHERE run_id=$1 AND asin=$2', [run.runId, row.asin]);
              reserved.push(row);
            }
          }
          await client.query('COMMIT');
        } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
        const exhausted = pending.filter(row => !reserved.includes(row));
        if (exhausted.length) await failed(exhausted, 'attempt_cap');
        pending = reserved;
        if (!pending.length) break;
        try { codexNamePrompt(pending); }
        catch { await failed(pending, 'source_too_large'); break; }
        let content: string;
        try { content = await provider.translate(pending); }
        catch (error) {
          if (error instanceof CodexQuotaBeforeInferenceError) {
            // The real provider certifies this happened before thread/start.
            // Restore only this batch's reservations; never refund uncertain
            // inference/transport errors that may have reached the model.
            await client.query('BEGIN');
            try {
              for (const row of pending) {
                const cycle = await client.query(`UPDATE codex_name_cycle_items SET attempts=attempts-1
                  WHERE cycle_id=$1 AND asin=$2 AND completed_at IS NULL AND attempts>0 RETURNING asin`, [cycleId, row.asin]);
                const item = await client.query(`UPDATE codex_name_run_items SET attempts=attempts-1
                  WHERE run_id=$1 AND asin=$2 AND outcome='selected' AND attempts>0 RETURNING asin`, [run.runId, row.asin]);
                if (cycle.rows.length !== 1 || item.rows.length !== 1) throw new Error('codex_quota_reservation_mismatch');
              }
              await client.query('COMMIT');
            } catch (refundError) {
              try { await client.query('ROLLBACK'); } catch {}
              throw refundError;
            }
          }
          return await finish(error instanceof CodexProviderError &&
            ['quota_unknown', 'quota_low', 'quota_exhausted'].includes(error.reason) ? error.reason : 'codex_provider_failed');
        }
        let result;
        try { result = parseCodexNames(pending, content); }
        catch {
          if (attempt === 2) await failed(pending, 'invalid_output');
          continue;
        }
        for (const row of pending) {
          const full = result.names.get(row.asin);
          if (!full) continue;
          const saved = await saveCodexName(client, { runId: run.runId, cycleId, source: row,
            full, short: result.shortNames.get(row.asin) ?? null });
          if (saved.saved) { run.translated++; if (saved.issues.length) run.warnings++; }
          else run.skipped++;
        }
        pending = pending.filter(row => result.rejectedAsins.includes(row.asin));
        if (attempt === 2 && pending.length) await failed(pending, 'invalid_output');
      }
    }
    return await finish(null);
  } finally {
    try { await provider?.close(); }
    finally {
      let discard = false;
      for (const key of acquired.reverse()) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [key]); }
        catch { discard = true; }
      }
      // An unconfirmed unlock must destroy the session, never return locks to the pool.
      client.release(discard);
    }
  }
}
