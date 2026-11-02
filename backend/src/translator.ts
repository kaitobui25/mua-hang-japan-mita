import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { translatePendingNames } from './translation/jobs.js';
import { compactPendingTitles } from './translation/compact-title.js';
import { shouldRunTranslation, translationCron, translationTimezone } from './translation/schedule.js';
import { translateCodexNames } from './translation/codex-jobs.js';
import { applyLocalCodexVerification } from './translation/codex-provider.js';
import { randomUUID } from 'node:crypto';
import { cronAtJst, readWorkerSettingsOrLegacy } from './workers/settings.js';

const command = process.argv[2];
async function translateNames(trigger: 'manual' | 'scheduled', chosenEngine?: 'openrouter' | 'codex') {
  // Persisted Owner choice is authoritative once the additive settings schema
  // exists. Old installations retain OpenRouter until explicitly migrated.
  const engine = chosenEngine ?? (await readWorkerSettingsOrLegacy()).engine;
  if (!['openrouter', 'codex'].includes(engine)) throw new Error('invalid_name_translation_engine');
  if (engine === 'openrouter') {
    const cap = process.env.MITA_NAMES_MAX_PRODUCTS;
    if (cap !== undefined && (!/^[1-9][0-9]{0,2}$/.test(cap) || Number(cap)>300)) throw Error('invalid_manual_names_limit');
    return translateAndCompact(cap === undefined ? undefined : Number(cap));
  }
  applyLocalCodexVerification();
  const runId = process.env.MITA_NAMES_RUN_ID ?? randomUUID();
  try {
    const run = await translateCodexNames({ trigger, runId,
      maxProducts: process.env.MITA_NAMES_MAX_PRODUCTS === undefined ? undefined : Number(process.env.MITA_NAMES_MAX_PRODUCTS)
    });
    console.log('MITA_WORKER_RESULT ' + JSON.stringify(run));
    return run;
  } catch (error) {
    const safeReasons = ['invalid_codex_run', 'codex_schema_unavailable', 'codex_requires_local_database', 'codex_database_identity_mismatch'];
    const reason = error instanceof Error && safeReasons.includes(error.message) ? error.message : 'database_outcome_unresolved';
    // Unknown DB outcomes must never be reported as zero or automatically retried.
    console.log('MITA_WORKER_RESULT ' + JSON.stringify({ version: 1, worker: 'names', engine,
      runId: /^[a-f0-9-]{36}$/i.test(runId) ? runId : null, trigger, state: 'failed', reason,
      selected: null, translated: null, failed: null, skipped: null, warnings: null, paused: true }));
    throw new Error(reason);
  }
}
async function translateAndCompact(maxProducts?: number) {
  const names = await translatePendingNames({maxProducts});
  // The concise presentation is optional until its additive local migration
  // has been applied. A provider or quota failure must not revoke full titles.
  try {
    // A manual limit covers distinct products, not two independent lists that
    // could each consume 300 ASINs. Shorten the same selected cohort; when no
    // full-name candidate exists, process the existing short-title backlog.
    const titles = await compactPendingTitles({maxProducts, allowedAsins: names.selectedAsins});
    console.log('Concise product titles:', titles);
  } catch {
    console.error('Concise title job deferred; full product titles remain available.');
  }
  return names;
}

if (command === 'once') {
  try {
    const trigger = process.env.MITA_NAMES_TRIGGER ?? 'manual';
    if (trigger !== 'manual' && trigger !== 'scheduled') throw new Error('invalid_name_translation_trigger');
    console.log('Name translation:', await translateNames(trigger));
  }
  finally { await db.end(); }
} else if (command === 'daily') {
  const startedAt = new Date();
  let schedulePoll: ReturnType<typeof setInterval> | undefined;
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue', max: config.bossPoolMax, connectionTimeoutMillis: 10000 });
  boss.on('error', () => console.error('Name translation scheduler database unavailable.'));
  try {
    await boss.start();
    await boss.createQueue('translation.names.daily');
    await boss.work('translation.names.daily', { includeMetadata: true }, async jobs => {
      for (const job of jobs) {
        const current = await readWorkerSettingsOrLegacy();
        if (!shouldRunTranslation(job.createdOn, startedAt, new Date(), current.schedules.names)) {
          console.log('Skipped missed 05:00 JST name translation window.');
          continue;
        }
        console.log('05:00 JST name translation started.');
        try {
          console.log('Name translation finished:', await translateNames('scheduled', current.engine));
        } catch (error) {
          if (current.engine !== 'codex') throw error;
          // The Codex worker already emits a bounded MITA_WORKER_RESULT with
          // an explicit failure reason. PgBoss retrying this same JST job can
          // replay an uncertain DB outcome, so acknowledge instead of retry.
          console.error('Scheduled name translation failed; automatic retry disabled.');
        }
      }
    });
    let scheduledTime = '';
    const refreshSchedule = async () => {
      const current = await readWorkerSettingsOrLegacy();
      if (current.schedules.names !== scheduledTime) {
        await boss.schedule('translation.names.daily', cronAtJst(current.schedules.names), {}, { tz: translationTimezone });
        scheduledTime = current.schedules.names;
      }
    };
    await refreshSchedule();
    schedulePoll = setInterval(() => { void refreshSchedule().catch(() =>
      console.error('Name schedule refresh failed; previous schedule retained.')); }, 60000);
    console.log('Independent name translator active, 05:00 Asia/Tokyo daily.');
    const halt = async () => {
      if (schedulePoll) clearInterval(schedulePoll);
      await boss.stop();
      await db.end();
      process.exit(0);
    };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) {
    if (schedulePoll) clearInterval(schedulePoll);
    await boss.stop();
    await db.end();
    throw error;
  }
} else {
  console.error('Usage: tsx src/translator.ts once|daily');
  process.exitCode = 1;
  await db.end();
}
