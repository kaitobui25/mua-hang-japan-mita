import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { importObservedSnapshot, syncCatalog } from './ingestion/sync.js';
import { processNextImport } from './admin/imports.js';
import { dailyCron, dailyTimezone, shouldRunDaily } from './ingestion/schedule.js';

const command = process.argv[2];
if (command === 'once') {
  try { await syncCatalog(); }
  finally { await db.end(); }
} else if (command === 'import') {
  try { console.log('Imported observed products:', await importObservedSnapshot()); }
  finally { await db.end(); }
} else if (command === 'daily') {
  const startedAt = new Date();
  // pg-boss DatabaseOptions.max controls its own pg.Pool (separate from db).
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue', max: config.bossPoolMax, connectionTimeoutMillis: 10000 });
  boss.on('error', () => console.error('Catalog scheduler error; check database/tunnel connectivity.'));
  let stopping = false;
  let importWork: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollImports = () => {
    importWork = (async () => {
      try { await processNextImport(); }
      catch { console.error('ASIN import queue error; check database/tunnel connectivity.'); }
      if (!stopping) timer = setTimeout(pollImports, 3000);
    })();
  };
  try {
    await boss.start();
    await boss.createQueue('catalog.daily');
    await boss.work('catalog.daily', { includeMetadata: true }, async jobs => {
      for (const job of jobs) {
        if (shouldRunDaily(job.createdOn, startedAt)) await syncCatalog();
        else console.log('Skipped daily scan from downtime/outside the scheduled window.');
      }
    });
    await boss.schedule('catalog.daily', dailyCron, {}, { tz: dailyTimezone });
    pollImports();
    console.log('Mita catalog worker active, 04:00 Asia/Tokyo daily');
    const halt = async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await importWork;
      await boss.stop(); await db.end(); process.exit(0);
    };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) { await boss.stop(); await db.end(); throw error; }
} else {
  console.error('Usage: tsx src/worker.ts once|import|daily');
  process.exitCode = 1;
  await db.end();
}
