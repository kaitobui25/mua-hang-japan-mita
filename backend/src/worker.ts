import { stopScraplingSessions } from './ingestion/scrapling.js';
import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { db } from './db/pool.js';
import { importObservedSnapshot, syncCatalog, seedExistingDetails } from './ingestion/sync.js';
import { processNextImport } from './admin/imports.js';
import { dailyCron, dailyTimezone, shouldRunDaily } from './ingestion/schedule.js';
import { cronAtJst, readWorkerSettingsOrLegacy } from './workers/settings.js';

const command = process.argv[2];
if (command === 'once') {
  try {
    const raw = process.env.MITA_AMAZON_MANUAL_MAX_PRODUCTS;
    if (raw !== undefined && (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw)>300))
      throw Error('invalid_manual_amazon_limit');
    await syncCatalog(raw === undefined ? {} : { totalLimit: Number(raw) });
  }
  finally { await db.end(); }
} else if (command === 'import') {
  try { console.log('Imported observed products:', await importObservedSnapshot()); }
  finally { await db.end(); }
} else if (command === 'backfill:seed') {
  try { console.log('Existing catalog ASINs newly queued:', await seedExistingDetails()); }
  finally { await db.end(); }
} else if (command === 'backfill:status') {
  try {
    const { rows } = await db.query(`SELECT c.slug AS category_slug,
      (SELECT count(*)::int FROM products p WHERE p.category_slug=c.slug) AS products,
      (SELECT count(*)::int FROM product_details d JOIN products p ON p.asin=d.asin WHERE p.category_slug=c.slug) AS detailed,
      (SELECT count(*)::int FROM product_translations t JOIN products p ON p.asin=t.asin WHERE p.category_slug=c.slug AND t.status='success' AND t.locale='vi') AS translated,
      (SELECT count(*)::int FROM product_translations t JOIN products p ON p.asin=t.asin
        WHERE p.category_slug=c.slug AND t.status='success' AND t.locale='vi' AND t.name_only) AS title_only,
      (SELECT count(*)::int FROM product_translations t JOIN products p ON p.asin=t.asin
        WHERE p.category_slug=c.slug AND t.status='success' AND t.locale='vi' AND NOT t.name_only) AS fully_translated,
      (SELECT count(*)::int FROM product_detail_queue q WHERE q.category_slug=c.slug AND q.state='pending') AS pending,
      (SELECT count(*)::int FROM product_detail_queue q WHERE q.category_slug=c.slug AND q.state='failed') AS failed
      FROM categories c WHERE c.slug IN ('thuc-pham-bo-sung','thuc-pham-cho-be') ORDER BY c.slug`);
    console.table(rows);
    const pauses = await db.query(`SELECT source,reason,blocked_at,retry_after_at FROM source_access_blocks`);
    if (pauses.rows.length) console.table(pauses.rows);
  } finally { await db.end(); }
} else if (command === 'backfill') {
  const parsed = Number(process.env.BACKFILL_LIMIT_PER_CATEGORY ?? '15');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw Error('BACKFILL_LIMIT_PER_CATEGORY must be 1..200');
  const category = process.env.BACKFILL_CATEGORY_SLUG;
  if (category && !['thuc-pham-bo-sung', 'thuc-pham-cho-be'].includes(category)) throw Error('Invalid BACKFILL_CATEGORY_SLUG');
  try {
    console.log('Existing catalog ASINs newly queued:', await seedExistingDetails());
    // Deliberately no listing discovery; do not exceed category budget or bypass source denial.
    console.log('Manual backfill result:', await syncCatalog({
      limit: parsed, categories: category ? [category] : undefined,
      discover: async () => ({ observations: [], issues: [] })
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
  let schedulePoll: ReturnType<typeof setInterval> | undefined;
  const pollImports = () => {
    importWork = (async () => {
      try {
        await processNextImport();
      }
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
        const current = await readWorkerSettingsOrLegacy();
        if (shouldRunDaily(job.createdOn, startedAt, new Date(), current.schedules.amazon)) {
          await syncCatalog({ scheduled: true, galleryPilotDate: process.env.AMAZON_GALLERY_PILOT_DATE === 'verified'
            ? undefined : process.env.AMAZON_GALLERY_PILOT_DATE });
        } else console.log('Skipped daily scan from downtime/outside the scheduled window.');
      }
    });
    let scheduledTime = '';
    const refreshSchedule = async () => {
      const settings = await readWorkerSettingsOrLegacy();
      const desired = settings.schedules.amazon;
      if (desired !== scheduledTime) {
        await boss.schedule('catalog.daily', cronAtJst(desired), {}, { tz: dailyTimezone });
        scheduledTime = desired;
      }
    };
    await refreshSchedule();
    schedulePoll = setInterval(() => { void refreshSchedule().catch(() =>
      console.error('Amazon schedule refresh failed; previous schedule retained.')); }, 60000);
    pollImports();
    console.log('Mita catalog worker active, Scrapling FetcherSession + BeautifulSoup, 04:00 Asia/Tokyo daily');
    const halt = async () => {
      stopping = true;
      if (schedulePoll) clearInterval(schedulePoll);
      stopScraplingSessions();
      if (timer) clearTimeout(timer);
      await importWork;
      await boss.stop(); await db.end(); process.exit(0);
    };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) { if (schedulePoll) clearInterval(schedulePoll); await boss.stop(); await db.end(); throw error; }
} else {
  console.error('Usage: tsx src/worker.ts once|import|backfill:seed|backfill:status|backfill|daily');
  process.exitCode = 1;
  await db.end();
}
