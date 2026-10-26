import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { importObservedSnapshot, syncCatalog } from './ingestion/sync.js';

const command = process.argv[2];
if (command === 'once') {
  try { await syncCatalog(); }
  finally { await db.end(); }
} else if (command === 'import') {
  try { console.log('Imported observed products:', await importObservedSnapshot()); }
  finally { await db.end(); }
} else if (command === 'daily') {
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue' });
  try {
    await boss.start();
    await boss.createQueue('catalog.daily');
    await boss.work('catalog.daily', async () => { await syncCatalog(); });
    await boss.schedule('catalog.daily', '0 4 * * *', {}, { tz: 'Asia/Tokyo' });
    console.log('Mita catalog worker active, 04:00 Asia/Tokyo daily');
    const halt = async () => { await boss.stop(); await db.end(); process.exit(0); };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) { await boss.stop(); await db.end(); throw error; }
} else {
  console.error('Usage: tsx src/worker.ts once|import|daily');
  process.exitCode = 1;
  await db.end();
}
