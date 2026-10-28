import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { translatePendingNames } from './translation/jobs.js';
import { shouldRunTranslation, translationCron, translationTimezone } from './translation/schedule.js';

const command = process.argv[2];

if (command === 'once') {
  try { console.log('Manual name translation:', await translatePendingNames()); }
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
        console.log('Name translation finished:', await translatePendingNames());
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
