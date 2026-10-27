import { PgBoss } from 'pg-boss';
import { Pool } from 'pg';
import { config } from './config.js';
import { db } from './db/pool.js';
import { importObservedSnapshot, syncCatalog, seedExistingDetails, acknowledgeSourceAccess } from './ingestion/sync.js';
import { processNextImport } from './admin/imports.js';
import { dailyCron, dailyTimezone, shouldRunDaily } from './ingestion/schedule.js';
import { translatePendingProducts } from './translation/jobs.js';
import { openNeoManualVerification } from './ingestion/neo.js';
import { seeds } from './ingestion/source.js';
import { claimDueAmazonContinuation, seedAmazonPause } from './ingestion/source-access.js';
import { nextTranslationDelayMs, TRANSLATION_IDLE_DELAY_MS } from './translation/schedule.js';

// Prevent the scheduled scan, import queue and translation timer from spending the
// same free daily model quota concurrently in this Windows worker process.
let translationWork: ReturnType<typeof translatePendingProducts> | undefined;
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
    const { rows } = await db.query(`SELECT c.slug AS category_slug,
      (SELECT count(*)::int FROM products p WHERE p.category_slug=c.slug) AS products,
      (SELECT count(*)::int FROM product_details d JOIN products p ON p.asin=d.asin WHERE p.category_slug=c.slug) AS detailed,
      (SELECT count(*)::int FROM product_translations t JOIN products p ON p.asin=t.asin WHERE p.category_slug=c.slug AND t.status='success' AND t.locale='vi') AS translated,
      (SELECT count(*)::int FROM product_translations t JOIN products p ON p.asin=t.asin
        WHERE p.category_slug=c.slug AND t.status='success' AND t.locale='vi' AND t.name_only) AS title_only,
      (SELECT count(*)::int FROM product_translations t JOIN products p ON p.asin=t.asin
        WHERE p.category_slug=c.slug AND t.status='success' AND t.locale='vi' AND NOT t.name_only) AS fully_translated,
      (SELECT count(*)::int FROM product_detail_queue q WHERE q.category_slug=c.slug AND q.state='pending') AS pending,
      (SELECT count(*)::int FROM product_detail_queue q WHERE q.category_slug=c.slug AND q.state='failed') AS failed,
      (SELECT count(*)::int FROM product_detail_queue q WHERE q.category_slug=c.slug AND q.state='needs_human') AS needs_human
      FROM categories c WHERE c.slug IN ('thuc-pham-bo-sung','thuc-pham-cho-be') ORDER BY c.slug`);
    console.table(rows);
    const pauses = await db.query(`SELECT source,reason,continuation_due_at,timeout_recorded_at FROM source_access_blocks`);
    if (pauses.rows.length) console.table(pauses.rows);
  } finally { await db.end(); }
} else if (command === 'backfill:ack') {
  try {
    const asin = process.env.BACKFILL_ACK_ASIN?.trim().toUpperCase() ?? '';
    const confirmed = process.env.BACKFILL_ACCESS_CONFIRMED === '1';
    console.log('Manually verified ASINs requeued:', await acknowledgeSourceAccess(asin, confirmed));
  } finally { await db.end(); }
} else if (command === 'captcha:open') {
  try {
    // Explicit owner action to open a previously blocked page; no scraping,
    // challenge submission, status reset, or source request from the worker.
    const asin = process.env.BACKFILL_CAPTCHA_ASIN?.trim().toUpperCase() ?? '';
    if (asin && !/^[A-Z0-9]{10}$/.test(asin)) throw Error('Invalid BACKFILL_CAPTCHA_ASIN');
    const { rows } = await db.query<{ asin: string; category_slug: string }>(
      `SELECT asin,category_slug FROM product_detail_queue WHERE state='needs_human'
       AND ($1::text='' OR asin=$1) ORDER BY category_slug,asin LIMIT 1`, [asin]);
    const blocked = await db.query(`SELECT 1 FROM source_access_blocks WHERE source='amazon.co.jp'`);
    if (!rows[0] && !blocked.rowCount) throw Error('No blocked Amazon page awaits manual verification');
    if (asin && !rows[0]) throw Error('Selected ASIN is not waiting for human verification');
    const url = rows[0] ? `https://www.amazon.co.jp/dp/${rows[0].asin}` : seeds[0].url;
    await openNeoManualVerification(url);
    console.log(`BrowserOS Neo opened ${url}. Solve CAPTCHA in the visible browser; source remains blocked until explicit manual ACK.`);
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
      discover: async () => ({ observations: [], issues: [] }),
      onCaptcha: openNeoManualVerification
    }));
  } finally { await db.end(); }
} else if (command === 'daily') {
  const startedAt = new Date();
  // pg-boss DatabaseOptions.max controls its own pg.Pool (separate from db).
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'mita_queue', max: config.bossPoolMax, connectionTimeoutMillis: 10000 });
  // OpenRouter inference may occupy the only default DB connection for many
  // seconds. Keep the CAPTCHA deadline observable with DB_POOL_MAX=1.
  const continuationPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  boss.on('error', () => console.error('Catalog scheduler error; check database/tunnel connectivity.'));
  let stopping = false;
  let importWork: Promise<void> = Promise.resolve();
  let continuationWork: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let continuationTimer: ReturnType<typeof setTimeout> | undefined;
  let translationTimer: ReturnType<typeof setTimeout> | undefined;
  // One shared scheduler for startup polling, manual import and CAPTCHA
  // fallback: an actively progressing batch replaces an old 2-hour timer.
  const scheduleTranslation = (delayMs: number) => {
    if (stopping) return;
    if (translationTimer) clearTimeout(translationTimer);
    translationTimer = setTimeout(() => void pollTranslations(), delayMs);
  };
  const triggerTranslation = async (limit = 30) => {
    try {
      const result = await runTranslation(limit);
      scheduleTranslation(nextTranslationDelayMs(result));
      return result;
    } catch {
      console.error('Background translation unavailable; source catalog retained.');
      scheduleTranslation(TRANSLATION_IDLE_DELAY_MS);
      return null;
    }
  };
  const pollTranslations = async () => { await triggerTranslation(); };
  const pollContinuation = () => {
    continuationWork = (async () => {
      try {
        // A durable 30s deadline turns a source-wide CAPTCHA pause into
        // independent catalog work. This timer never awaits Admin Import,
        // which may wait behind translator's occupied DB_POOL_MAX=1 connection.
        if (await claimDueAmazonContinuation(continuationPool)) {
          console.warn('Amazon still blocked after 30s; local translation fallback dispatched. No Amazon retry or auto-ACK.');
          void triggerTranslation().then(result => {
            if (result) console.log(`CAPTCHA fallback finished: ${result.translated} translations updated, ${result.failed} unavailable, ${result.skipped} unchanged.`);
          });
        }
      } catch {
        console.error('CAPTCHA continuation timer unavailable; retrying without clearing the source block.');
      } finally {
        if (!stopping) continuationTimer = setTimeout(pollContinuation, 3000);
      }
    })();
  };
  const pollImports = () => {
    importWork = (async () => {
      try {
        if (await processNextImport()) void triggerTranslation(1);
      }
      catch { console.error('ASIN import queue error; check database/tunnel connectivity.'); }
      if (!stopping) timer = setTimeout(pollImports, 3000);
    })();
  };
  try {
    console.log('Queued existing ASINs for next scheduled detail scan:', await seedExistingDetails());
    const pauseConnection = await continuationPool.connect();
    try { await seedAmazonPause(pauseConnection); }
    finally { pauseConnection.release(); }
    await boss.start();
    await boss.createQueue('catalog.daily');
    await boss.work('catalog.daily', { includeMetadata: true }, async jobs => {
      for (const job of jobs) {
        if (shouldRunDaily(job.createdOn, startedAt)) await syncAndTranslate();
        else console.log('Skipped daily scan from downtime/outside the scheduled window.');
      }
    });
    await boss.schedule('catalog.daily', dailyCron, {}, { tz: dailyTimezone });
    pollContinuation();
    pollImports();
    // Translation can catch up while PC is on even when it missed the 04:00
    // scan; this does NOT perform an off-schedule Amazon scrape.
    scheduleTranslation(5000);
    console.log('Mita catalog worker active, 04:00 Asia/Tokyo daily');
    const halt = async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (continuationTimer) clearTimeout(continuationTimer);
      if (translationTimer) clearTimeout(translationTimer);
      await continuationWork;
      await importWork;
      if (translationWork) await translationWork.catch(() => {});
      await boss.stop(); await continuationPool.end(); await db.end(); process.exit(0);
    };
    process.once('SIGINT', () => void halt());
    process.once('SIGTERM', () => void halt());
  } catch (error) { await boss.stop(); await continuationPool.end(); await db.end(); throw error; }
} else {
  console.error('Usage: tsx src/worker.ts once|import|translate|backfill:seed|backfill:status|backfill:ack|captcha:open|backfill|daily');
  process.exitCode = 1;
  await db.end();
}
