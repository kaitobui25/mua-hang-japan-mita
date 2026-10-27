import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { importObservedSnapshot, syncCatalog, seedExistingDetails } from './ingestion/sync.js';
import { processNextImport } from './admin/imports.js';
import { dailyCron, dailyTimezone, shouldRunDaily } from './ingestion/schedule.js';
import { translatePendingProducts } from './translation/jobs.js';

// Prevent the scheduled scan, import queue and translation timer from spending the
// same free daily model quota concurrently in this Windows worker process.
let translationWork: Promise<unknown> | undefined;
function runTranslation(limit = 30) {
  if (!translationWork) {
    translationWork = translatePendingProducts(limit).finally(() => { translationWork = undefined; });
  }
  return translationWork;
}

async function syncAndTranslate() {
  const result = await syncCatalog();
  try { await runTranslation(); }
  catch { console.error('Translation database job failed; catalog data remains available.'); }
  return result;
}

const command = process.argv[2];
if (command === 'once') {
  try { await syncAndTranslate(); }
  finally { await db.end(); }
} else if (command === 'import') {
  try { console.log('Imported observed products:', await importObservedSnapshot()); }
  finally { await db.end(); }
} else if (command === 'translate') {
  const parsed = Number(process.env.TRANSLATION_BATCH_LIMIT ?? '30');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) throw Error('TRANSLATION_BATCH_LIMIT must be 1..30');
  try { await runTranslation(parsed); }
  finally { await db.end(); }
} else if (command === 'backfill:seed') {
  try { console.log('Existing catalog ASINs newly queued:', await seedExistingDetails()); }
  finally { await db.end(); }
} else if (command === 'backfill:status') {
  try {
    const { rows } = await db.query(`SELECT p.category_slug,COUNT(DISTINCT p.asin)::int AS products,
      COUNT(DISTINCT d.asin)::int AS detailed,
      COUNT(DISTINCT t.asin)::int AS translated,
      COUNT(DISTINCT q.asin) FILTER (WHERE q.state='pending')::int AS pending,
      COUNT(DISTINCT q.asin) FILTER (WHERE q.state='failed')::int AS failed,
      COUNT(DISTINCT q.asin) FILTER (WHERE q.state='needs_human')::int AS needs_human
      FROM products p LEFT JOIN product_details d ON d.asin=p.asin
      LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi' AND t.status='success'
      LEFT JOIN product_detail_queue q ON q.asin=p.asin AND q.category_slug=p.category_slug
      GROUP BY p.category_slug ORDER BY p.category_slug`);
    console.table(rows);
  } finally { await db.end(); }
} else if (command === 'backfill') {
  const parsed = Number(process.env.BACKFILL_LIMIT_PER_CATEGORY ?? '15');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw Error('BACKFILL_LIMIT_PER_CATEGORY must be 1..200');
  try {
    console.log('Existing catalog ASINs newly queued:', await seedExistingDetails());
    // Deliberately no listing discovery; do not exceed category budget or bypass source denial.
    console.log('Manual backfill result:', await syncCatalog({
      limit: parsed, discover: async () => ({ observations: [], issues: [] })
    }));
  } finally { await db.end(); }
} else if (command === 'daily') {
  const startedAt = new Date();
  // pg-boss DatabaseOptions.max controls its own pg.Pool (separate from db).
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue', max: config.bossPoolMax, connectionTimeoutMillis: 10000 });
  boss.on('error', () => console.error('Catalog scheduler error; check database/tunnel connectivity.'));
  let stopping = false;
  let importWork: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let translationTimer: ReturnType<typeof setTimeout> | undefined;
  const pollTranslations = async () => {
    try { await runTranslation(); }
    catch { console.error('Background translation unavailable; source catalog retained.'); }
    if (!stopping) translationTimer = setTimeout(() => void pollTranslations(), 2 * 60 * 60 * 1000);
  };
  const pollImports = () => {
    importWork = (async () => {
      try { if (await processNextImport()) void runTranslation(1).catch(() => {}); }
      catch { console.error('ASIN import queue error; check database/tunnel connectivity.'); }
      if (!stopping) timer = setTimeout(pollImports, 3000);
    })();
  };
  try {
    console.log('Queued existing ASINs for next scheduled detail scan:', await seedExistingDetails());
    await boss.start();
    await boss.createQueue('catalog.daily');
    await boss.work('catalog.daily', { includeMetadata: true }, async jobs => {
      for (const job of jobs) {
        if (shouldRunDaily(job.createdOn, startedAt)) await syncAndTranslate();
        else console.log('Skipped daily scan from downtime/outside the scheduled window.');
      }
    });
    await boss.schedule('catalog.daily', dailyCron, {}, { tz: dailyTimezone });
    pollImports();
    // Translation can catch up while PC is on even when it missed the 04:00
    // scan; this does NOT perform an off-schedule Amazon scrape.
    translationTimer = setTimeout(() => void pollTranslations(), 5000);
    console.log('Mita catalog worker active, 04:00 Asia/Tokyo daily');
    const halt = async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (translationTimer) clearTimeout(translationTimer);
      await importWork;
      if (translationWork) await translationWork.catch(() => {});
      await boss.stop(); await db.end(); process.exit(0);
    };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) { await boss.stop(); await db.end(); throw error; }
} else {
  console.error('Usage: tsx src/worker.ts once|import|translate|backfill:seed|backfill:status|backfill|daily');
  process.exitCode = 1;
  await db.end();
}
