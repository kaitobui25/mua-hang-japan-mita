import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { translatePendingNames } from './translation/jobs.js';
import { compactPendingTitles } from './translation/compact-title.js';
import { shouldRunTranslation, translationCron, translationTimezone } from './translation/schedule.js';
import { translateCodexNames } from './translation/codex-jobs.js';
import { randomUUID } from 'node:crypto';

const command = process.argv[2];
async function translateNames(trigger: 'manual' | 'scheduled') {
  const engine = process.env.MITA_NAMES_ENGINE ?? 'openrouter';
  if (!['openrouter', 'codex'].includes(engine)) throw new Error('invalid_name_translation_engine');
  if (engine === 'openrouter') return translateAndCompact();
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
async function translateAndCompact() {
  const names = await translatePendingNames();
  // The concise presentation is optional until its additive local migration
  // has been applied. A provider or quota failure must not revoke full titles.
  try {
    const titles = await compactPendingTitles();
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
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue', max: config.bossPoolMax, connectionTimeoutMillis: 10000 });
  boss.on('error', () => console.error('Name translation scheduler database unavailable.'));
  try {
    await boss.start();
    await boss.createQueue('translation.names.daily');
    await boss.work('translation.names.daily', { includeMetadata: true }, async jobs => {
      for (const job of jobs) {
        if (!shouldRunTranslation(job.createdOn, startedAt)) {
          console.log('Skipped missed 05:00 JST name translation window.');
          continue;
        }
        console.log('05:00 JST name translation started.');
        console.log('Name translation finished:', await translateNames('scheduled'));
      }
    });
    await boss.schedule('translation.names.daily', translationCron, {}, { tz: translationTimezone });
    console.log('Independent name translator active, 05:00 Asia/Tokyo daily.');
    const halt = async () => {
      await boss.stop();
      await db.end();
      process.exit(0);
    };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) {
    await boss.stop();
    await db.end();
    throw error;
  }
} else {
  console.error('Usage: tsx src/translator.ts once|daily');
  process.exitCode = 1;
  await db.end();
}
