import { claimGalleryPilot, galleryPilotAsins, galleryPilotCategory, galleryPilotDue, galleryPilotMarker } from './gallery-pilot.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from '../db/pool.js';
import { seeds, SourceError, type DiscoveryResult, type DiscoveryIssue, type Observation } from './source.js';
import { ingestObservations } from './store.js';
import { ScraplingSession, isScraplingStopping } from './scrapling.js';
import { collectDetail } from './detail.js';
import { config } from '../config.js';
import type { PoolClient } from 'pg';
import { AMAZON_ACCESS_LOCK, recordAmazonPause, amazonGate, completeAmazonReentry } from './source-access.js';

export async function collectCategory(
  seed: { categorySlug: string; url: string },
  discover?: (category: string, url: string) => Promise<DiscoveryResult>,
  _legacyNeo?: (category: string, url: string) => Promise<Observation[]>
): Promise<DiscoveryResult> {
  if (discover) return discover(seed.categorySlug, seed.url);
  const session = new ScraplingSession();
  try { return await session.discover(seed.categorySlug, seed.url); }
  finally { session.close(); }
}

type Connection = Pick<PoolClient, 'query'>;
type DetailCollector = (asin: string, categorySlug: string) => Promise<Observation>;

export async function collectEnrichedDetail(asin: string, categorySlug: string,
  collector: DetailCollector = collectDetail, _legacyNeo?: DetailCollector): Promise<Observation> {
  return collector(asin, categorySlug);
}

export async function enqueueDetails(category: string, observations: Pick<Observation, 'asin' | 'parentAsin' | 'sourceUrl'>[], connection: Connection = db) {
  for (const o of observations) {
    if (!/^[A-Z0-9]{10}$/.test(o.asin)) continue;
    const parent = o.parentAsin && /^[A-Z0-9]{10}$/.test(o.parentAsin) ? o.parentAsin : null;
    await connection.query(`INSERT INTO product_detail_queue(category_slug,asin,parent_asin,provenance)
      VALUES($1,$2,$3,$4) ON CONFLICT(category_slug,asin) DO UPDATE SET
      parent_asin=COALESCE(EXCLUDED.parent_asin,product_detail_queue.parent_asin),
      provenance=CASE WHEN EXCLUDED.parent_asin IS NOT NULL THEN EXCLUDED.provenance ELSE product_detail_queue.provenance END`,
    [category, o.asin, parent, JSON.stringify({ sourceUrl: o.sourceUrl, parentAsin: parent })]);
  }
}

/** Queue existing local catalog ASINs without touching Amazon or their existing snapshots. */
export async function seedExistingDetails(connection: Connection = db): Promise<number> {
  const result = await connection.query(`INSERT INTO product_detail_queue(category_slug,asin)
    SELECT category_slug,asin FROM products WHERE category_slug IN ('thuc-pham-bo-sung','thuc-pham-cho-be')
    ON CONFLICT(category_slug,asin) DO NOTHING`);
  return result.rowCount ?? 0;
}

// Low-level detail stage: production must call through syncCatalog, which owns
// the source-wide access lock and performs the cooldown preflight.
export async function processCategoryDetails(category: string, options: {
  connection?: Connection; collect?: DetailCollector; save?: (items: Observation[]) => Promise<number>;
  delay?: (milliseconds: number) => Promise<void>;
  limit?: number; pilot?: boolean; onIssue?: (issue: DiscoveryIssue & { asin?: string }) => Promise<void>;
} = {}) {
  const connection = options.connection ?? db;
  const collect = options.collect ?? collectEnrichedDetail;
  const save = options.save ?? (items => ingestObservations(items));
  const delay = options.delay ?? (options.collect ? async () => {} : (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const requested = options.limit ?? config.maxDiscover;
  const limit = Number.isFinite(requested) ? Math.max(0, Math.min(200, Math.floor(requested))) : 200;
  const attempted: string[] = [];
  let saved = 0, blocked = false;
  while (attempted.length < limit && !isScraplingStopping()) {
    const next = await connection.query<{ asin: string; parent_asin: string | null; provenance: { sourceUrl?: string } }>(`SELECT asin,parent_asin,provenance FROM product_detail_queue
      WHERE category_slug=$1 AND NOT (asin=ANY($2::varchar(10)[]))
      AND ($3::varchar(10)[] IS NULL OR asin=ANY($3::varchar(10)[]))
      ORDER BY last_attempt_at ASC NULLS FIRST,enqueued_at ASC,asin ASC LIMIT 1`, [category, attempted, options.pilot ? [...galleryPilotAsins] : null]);
    const candidate = next.rows[0];
    if (!candidate) break;
    if (attempted.length) await delay(1200);
    attempted.push(candidate.asin);
    // Record attempts separately from good observation times, also rotating failed items fairly.
    await connection.query(`UPDATE product_detail_queue SET last_attempt_at=now(),state='pending' WHERE category_slug=$1 AND asin=$2`, [category, candidate.asin]);
    try {
      const item = await collect(candidate.asin, category);
      if (item.asin !== candidate.asin || item.categorySlug !== category) throw new SourceError('parse_error', 'Detail identity differs from queued ASIN/category');
      if (!item.parentAsin && candidate.parent_asin) {
        item.parentAsin = candidate.parent_asin;
        if (item.detail && candidate.provenance.sourceUrl) item.detail.provenance.variantGroup = {
          parentAsin: candidate.parent_asin, sourceUrl: candidate.provenance.sourceUrl
        };
      }
      saved += await save([item]);
      if (saved % 25 === 0) console.log(`Detail backfill ${category}: ${saved} saved, ${attempted.length}/${limit} ASINs attempted`);
      if (!options.pilot) await enqueueDetails(category, (item.detail?.childAsins ?? []).map(asin => ({ asin, parentAsin: item.parentAsin, sourceUrl: item.sourceUrl })), connection);
      await connection.query(`UPDATE product_detail_queue SET state='success',last_success_at=now() WHERE category_slug=$1 AND asin=$2`, [category, candidate.asin]);
      if (item.priceJpy == null) await options.onIssue?.({ asin: candidate.asin, adapter: item.sourceAdapter.startsWith('scrapling') ? 'scrapling' : item.sourceAdapter.startsWith('browseros-neo') ? 'browseros-neo' : 'http', state: 'parse_error', message: 'Detail read without a current price; previous price observation retained' });
    } catch (error) {
      const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
      blocked = failure.state === 'blocked' || failure.state === 'rate_limited';
      // The source pause must survive a later queue-write failure.
      const issue = { asin: candidate.asin, adapter: failure.adapter, state: failure.state,
        message: failure.message, retryAfterAt: failure.retryAfterAt };
      if (blocked) await options.onIssue?.(issue);
      await connection.query('UPDATE product_detail_queue SET state=$3 WHERE category_slug=$1 AND asin=$2', [category, candidate.asin, 'failed']);
      if (!blocked) await options.onIssue?.(issue);
      if (blocked) break;
    }
  }
  const pending = await connection.query<{ count: string }>(`SELECT count(*)::text AS count FROM product_detail_queue
    WHERE category_slug=$1 AND (NOT (asin=ANY($2::varchar(10)[])) OR state <> 'success')`, [category, attempted]);
  return { attempted: attempted.length, saved, blocked, deferred: Number(pending.rows[0].count) };
}

export async function syncCatalog(options: {
  discover?: typeof collectCategory; collect?: DetailCollector; limit?: number; connection?: PoolClient;
  categories?: string[]; scheduled?: boolean; galleryPilotDate?: string;
} = {}) {
  if (options.galleryPilotDate !== undefined && !galleryPilotDue(options.galleryPilotDate, options.scheduled === true)) {
    return { state: 'pilot_outside_window' };
  }
  const pilot = options.galleryPilotDate !== undefined;
  let pilotClaimed = false;
  const runNote = (note: string, counters = {}) => pilotClaimed
    ? JSON.stringify({ ...counters, galleryPilot: galleryPilotMarker, summary: note }) : note;
  // A manual run must not overlap the scheduled worker and double the category budget.
  const lock = options.connection ?? await db.connect();
  const release = () => { if (!options.connection) lock.release(); };
  try {
    const locked = await lock.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [AMAZON_ACCESS_LOCK]);
    if (!locked.rows[0].acquired) { release(); return { state: 'already_running' }; }
  } catch (error) { release(); throw error; }
  let id: number | undefined;
  let discovered = 0, saved = 0, errors = 0, blocked = false;
  let attempted = 0, newProducts = 0, updatedProducts = 0, warnings = 0;
  const session = new ScraplingSession();
  const deferred: Record<string, number> = {};
  try {
    const runResult = await lock.query<{ id: string }>('INSERT INTO sync_runs DEFAULT VALUES RETURNING id');
    id = Number(runResult.rows[0].id);
    await seedExistingDetails(lock);
    if (!await amazonGate(lock, options.scheduled === true)) {
      const note = 'Amazon source cooldown; waiting for the next eligible daily 04:00 JST scan';
      await lock.query(`UPDATE sync_runs SET finished_at=now(),state='failed',error_count=1,note=$2 WHERE id=$1`, [id, note]);
      return { id, state: 'failed', discovered: 0, saved: 0, errors: 1, deferred };
    }
    if (pilot) {
      pilotClaimed = await claimGalleryPilot(lock, id);
      if (!pilotClaimed) {
        await lock.query("UPDATE sync_runs SET finished_at=now(),state='success',note='Gallery pilot already consumed; QA required before broad backfill' WHERE id=$1", [id]);
        return { id, state: 'pilot_consumed' };
      }
    }
    for (const seed of seeds) {
      if (isScraplingStopping()) { errors++; break; }
      if (pilot && seed.categorySlug !== galleryPilotCategory) continue;
      if (!pilot && options.categories && !options.categories.includes(seed.categorySlug)) continue;
      const report = async (issue: DiscoveryIssue & { asin?: string }) => {
        const missingPrice = issue.message === 'Detail read without a current price; previous price observation retained';
        if (missingPrice) warnings++;
        else errors++;
        if (issue.state === 'blocked' || issue.state === 'rate_limited') {
          blocked = true;
          await recordAmazonPause(lock, issue.message, issue.retryAfterAt);
        }
        await lock.query('INSERT INTO sync_errors(sync_run_id,category_slug,asin,adapter,state,message) VALUES($1,$2,$3,$4,$5,$6)',
          [id, seed.categorySlug, issue.asin ?? null, issue.adapter, issue.state, issue.page ? `Page ${issue.page}: ${issue.message}` : issue.message]);
      };
      try {
        // Every existing ASIN is eligible daily, including ones no longer on listings.
        try {
          const result = pilot ? { observations: [], issues: [] } : await (options.discover ? options.discover(seed) : session.discover(seed.categorySlug, seed.url));
          discovered += new Set(result.observations.map(o => o.asin)).size;
          // Persist access denial before any downstream queue work can fail.
          for (const issue of result.issues) await report(issue);
          await enqueueDetails(seed.categorySlug, result.observations, lock);
        } catch (error) {
          const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
          await report({ adapter: failure.adapter, state: failure.state, message: failure.message });
        }
        if (blocked) break;
        const result = await processCategoryDetails(seed.categorySlug, {
          connection: lock, collect: options.collect ?? ((asin, category) => session.detail(asin, category)), limit: pilot ? 5 : options.limit, pilot, onIssue: report,
          save: async items => {
            await lock.query('BEGIN');
            try {
              const existing = await lock.query<{ asin: string }>(
                'SELECT asin FROM products WHERE asin=ANY($1::varchar(10)[])',
                [items.map(item => item.asin)]);
              const count = await ingestObservations(items, id, lock);
              await lock.query('COMMIT');
              if (count) {
                newProducts += items.filter(item => !existing.rows.some(row => row.asin === item.asin)).length;
                updatedProducts += items.filter(item => existing.rows.some(row => row.asin === item.asin)).length;
              }
              return count;
            } catch (error) { await lock.query('ROLLBACK'); throw error; }
          }
        });
        saved += result.saved;
        attempted += result.attempted;
        deferred[seed.categorySlug] = result.deferred;
        console.log(`${seed.categorySlug}: ${result.attempted} unique ASINs attempted; ${result.deferred} deferred`);
        if (result.blocked) { blocked = true; break; }
      } catch (error) {
        const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
        await report({ adapter: failure.adapter, state: failure.state, message: failure.message });
        if (blocked) break;
      }
    }
    const state = errors ? (saved ? 'partial' : 'failed') : 'success';
    // A failed re-entry retains tomorrow's reservation, including transient failures.
    if (!errors) await completeAmazonReentry(lock);
    await lock.query('UPDATE sync_runs SET finished_at=now(),state=$2,discovered_count=$3,saved_count=$4,error_count=$5,note=$6 WHERE id=$1',
      [id, state, discovered, saved, errors, runNote(JSON.stringify({ deferred, attempted, newProducts, updatedProducts, warnings }), { deferred, attempted, newProducts, updatedProducts, warnings })]);
    return { id, state, discovered, saved, errors, warnings, attempted, newProducts, updatedProducts, deferred };
  } catch (error) {
    if (id) await lock.query('UPDATE sync_runs SET finished_at=now(),state=$2,note=$3 WHERE id=$1', [id, 'failed', runNote(String(error))]);
    throw error;
  } finally {
    session.close();
    try { await lock.query('SELECT pg_advisory_unlock($1)', [AMAZON_ACCESS_LOCK]); }
    finally { release(); }
  }
}

export async function importObservedSnapshot() {
  const path = fileURLToPath(new URL('../../data/observed-amazon.json', import.meta.url));
  const raw = JSON.parse(await readFile(path, 'utf8')) as Observation[];
  return ingestObservations(raw);
}
