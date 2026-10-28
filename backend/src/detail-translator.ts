import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { translatePendingDetails } from './translation/detail-jobs.js';
import { localEndpoint } from './translation/local.js';
import { detailTranslationCron, detailTranslationTimezone, parseDetailCommand, shouldRunDetailTranslation } from './translation/detail-schedule.js';

const stop = new AbortController();
const startedAt = new Date();
let boss: PgBoss | undefined;
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
try {
  const { command, limit } = parseDetailCommand(process.argv.slice(2));
  localEndpoint();
  if (command === 'once') {
    console.log('Local DETAIL translation:', await translatePendingDetails({ limit, signal: stop.signal }));
  } else {
    boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue', max: config.bossPoolMax, connectionTimeoutMillis: 10000 });
    boss.on('error', () => console.error('Local DETAIL scheduler database unavailable.'));
    await boss.start();
    await boss.createQueue('translation.details.daily');
    await boss.work('translation.details.daily', { includeMetadata: true }, async jobs => {
      for (const job of jobs) {
        if (stop.signal.aborted || !shouldRunDetailTranslation(job.createdOn, startedAt)) {
          console.log('Skipped missed 05:15 JST DETAIL translation window.');
          continue;
        }
        console.log('05:15 JST local DETAIL translation:', await translatePendingDetails({ signal: stop.signal }));
      }
    });
    await boss.schedule('translation.details.daily', detailTranslationCron, {}, { tz: detailTranslationTimezone });
    console.log('Local DETAIL translator scheduled, 05:15 Asia/Tokyo daily; no startup catch-up.');
    if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
  }
} finally {
  stop.abort();
  try { await boss?.stop(); }
  finally { await db.end(); }
}
