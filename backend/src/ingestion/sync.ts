import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from '../db/pool.js';
import { discoverHttp, seeds, SourceError, type DiscoveryResult, type DiscoveryIssue, type Observation } from './source.js';
import { ingestObservations } from './store.js';
import { discoverNeo, collectDetailNeo } from './neo.js';
import { collectDetail } from './detail.js';
import { config } from '../config.js';
import type { PoolClient } from 'pg';

export async function collectCategory(
  seed: { categorySlug: string; url: string },
  http: (category: string, url: string) => Promise<DiscoveryResult> = discoverHttp,
  neo: (category: string, url: string) => Promise<Observation[]> = discoverNeo
): Promise<DiscoveryResult> {
  let result: DiscoveryResult;
  try {
    result = await http(seed.categorySlug, seed.url);
  } catch (error) {
    // Only source markup/JS failures permit browser fallback, not access denial.
    if (!(error instanceof SourceError) || error.state !== 'parse_error') throw error;
    return { observations: await neo(seed.categorySlug, seed.url), issues: [] };
  }

  // A later HTTP page can be blocked while earlier pages were valid. The
  // retained ASINs must not trigger another browser after that denial.
  if (result.issues.some(issue => issue.state === 'blocked' || issue.state === 'needs_human')) return result;

  const missing = result.observations.filter(o => o.priceJpy == null);
  if (!missing.length) return result;
  const observations = new Map(result.observations.map(o => [o.asin, o]));
  const issues = [...result.issues];
  try {
    // Preserve the full HTTP discovery. Neo can supplement verified prices and
    // explicit family identifiers without replacing otherwise-valid HTTP data.
    for (const item of await neo(seed.categorySlug, seed.url)) {
      const previous = observations.get(item.asin);
      if (previous && (
        (previous.priceJpy == null && item.priceJpy != null) ||
        (item.parentAsin != null && item.parentAsin !== previous.parentAsin) ||
        (item.sourceProductId != null && item.sourceProductId !== previous.sourceProductId)
      )) {
        const refreshPrice = previous.priceJpy == null && item.priceJpy != null;
        observations.set(item.asin, {
          ...previous,
          ...(refreshPrice ? { priceJpy: item.priceJpy, observedAt: item.observedAt, sourceAdapter: item.sourceAdapter } : {}),
          parentAsin: item.parentAsin ?? previous.parentAsin,
          sourceProductId: item.sourceProductId ?? previous.sourceProductId
        });
      }
    }
    const unresolved = [...observations.values()].filter(o => o.priceJpy == null).length;
    if (unresolved) issues.push({ adapter: 'browseros-neo', state: 'parse_error', message: `${unresolved} discovered ASINs have no observed price after Neo fallback` });
  } catch (error) {
    const failure = error instanceof SourceError ? error : new SourceError('needs_human', String(error), 'browseros-neo');
    issues.push({ adapter: failure.adapter, state: failure.state, message: failure.message });
  }
  return { observations: [...observations.values()], issues };
}

type Connection = Pick<PoolClient, 'query'>;
type DetailCollector = (asin: string, categorySlug: string) => Promise<Observation>;

export async function collectEnrichedDetail(asin: string, categorySlug: string,
  http: DetailCollector = collectDetail, neo: DetailCollector = collectDetailNeo): Promise<Observation> {
  try { return await http(asin, categorySlug); }
  catch (error) {
    if (!(error instanceof SourceError) || error.state !== 'parse_error') throw error;
    return neo(asin, categorySlug);
  }
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

export async function processCategoryDetails(category: string, options: {
  connection?: Connection; collect?: DetailCollector; save?: (items: Observation[]) => Promise<number>;
  delay?: (milliseconds: number) => Promise<void>;
  limit?: number; onIssue?: (issue: DiscoveryIssue & { asin?: string }) => Promise<void>;
} = {}) {
  const connection = options.connection ?? db;
  const collect = options.collect ?? collectEnrichedDetail;
  const save = options.save ?? (items => ingestObservations(items));
  const delay = options.delay ?? (options.collect ? async () => {} : (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const requested = options.limit ?? config.maxDiscover;
  const limit = Number.isFinite(requested) ? Math.max(0, Math.min(200, Math.floor(requested))) : 200;
  const attempted: string[] = [];
  let saved = 0, blocked = false;
  while (attempted.length < limit) {
    const next = await connection.query<{ asin: string; parent_asin: string | null; provenance: { sourceUrl?: string } }>(`SELECT asin,parent_asin,provenance FROM product_detail_queue
      WHERE category_slug=$1 AND state <> 'needs_human' AND NOT (asin=ANY($2::varchar(10)[]))
      ORDER BY last_attempt_at ASC NULLS FIRST,enqueued_at ASC,asin ASC LIMIT 1`, [category, attempted]);
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
      await enqueueDetails(category, (item.detail?.childAsins ?? []).map(asin => ({ asin, parentAsin: item.parentAsin, sourceUrl: item.sourceUrl })), connection);
      await connection.query(`UPDATE product_detail_queue SET state='success',last_success_at=now() WHERE category_slug=$1 AND asin=$2`, [category, candidate.asin]);
      if (item.priceJpy == null) await options.onIssue?.({ asin: candidate.asin, adapter: item.sourceAdapter.startsWith('browseros-neo') ? 'browseros-neo' : 'http', state: 'parse_error', message: 'Detail read without a current price; previous price observation retained' });
    } catch (error) {
      const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
      blocked = failure.state === 'blocked' || failure.state === 'needs_human';
      await connection.query('UPDATE product_detail_queue SET state=$3 WHERE category_slug=$1 AND asin=$2', [category, candidate.asin, blocked ? 'needs_human' : 'failed']);
      await options.onIssue?.({ asin: candidate.asin, adapter: failure.adapter, state: failure.state, message: failure.message });
      if (blocked) break;
    }
  }
  const pending = await connection.query<{ count: string }>(`SELECT count(*)::text AS count FROM product_detail_queue
    WHERE category_slug=$1 AND (NOT (asin=ANY($2::varchar(10)[])) OR state <> 'success')`, [category, attempted]);
  return { attempted: attempted.length, saved, blocked, deferred: Number(pending.rows[0].count) };
}

export async function syncCatalog(options: {
  discover?: typeof collectCategory; collect?: DetailCollector; limit?: number; connection?: PoolClient;
} = {}) {
  // A manual run must not overlap the scheduled worker and double the category budget.
  const lock = options.connection ?? await db.connect();
  const release = () => { if (!options.connection) lock.release(); };
  try {
    const locked = await lock.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(70400200) AS acquired');
    if (!locked.rows[0].acquired) { release(); return { state: 'already_running' }; }
  } catch (error) { release(); throw error; }
  let id: number | undefined;
  let discovered = 0, saved = 0, errors = 0, blocked = false;
  const deferred: Record<string, number> = {};
  try {
    const runResult = await lock.query<{ id: string }>('INSERT INTO sync_runs DEFAULT VALUES RETURNING id');
    id = Number(runResult.rows[0].id);
    for (const seed of seeds) {
      const report = async (issue: DiscoveryIssue & { asin?: string }) => {
        errors++;
        if (issue.state === 'blocked' || issue.state === 'needs_human') blocked = true;
        await lock.query('INSERT INTO sync_errors(sync_run_id,category_slug,asin,adapter,state,message) VALUES($1,$2,$3,$4,$5,$6)',
          [id, seed.categorySlug, issue.asin ?? null, issue.adapter, issue.state, issue.page ? `Page ${issue.page}: ${issue.message}` : issue.message]);
      };
      try {
        // Every existing ASIN is eligible daily, including ones no longer on listings.
        await seedExistingDetails(lock);
        try {
          const result = await (options.discover ?? collectCategory)(seed);
          discovered += new Set(result.observations.map(o => o.asin)).size;
          await enqueueDetails(seed.categorySlug, result.observations, lock);
          for (const issue of result.issues) await report(issue);
        } catch (error) {
          const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
          await report({ adapter: failure.adapter, state: failure.state, message: failure.message });
        }
        if (blocked) break;
        const result = await processCategoryDetails(seed.categorySlug, {
          connection: lock, collect: options.collect, limit: options.limit, onIssue: report,
          save: async items => {
            await lock.query('BEGIN');
            try {
              const count = await ingestObservations(items, id, lock);
              await lock.query('COMMIT');
              return count;
            } catch (error) { await lock.query('ROLLBACK'); throw error; }
          }
        });
        saved += result.saved;
        deferred[seed.categorySlug] = result.deferred;
        console.log(`${seed.categorySlug}: ${result.attempted} unique ASINs attempted; ${result.deferred} deferred`);
        if (result.blocked) { blocked = true; break; }
      } catch (error) {
        const failure = error instanceof SourceError ? error : new SourceError('temporary', String(error));
        await report({ adapter: failure.adapter, state: failure.state, message: failure.message });
        if (blocked) break;
      }
    }
    const state = blocked ? 'needs_human' : errors ? (saved ? 'partial' : 'failed') : 'success';
    await lock.query('UPDATE sync_runs SET finished_at=now(),state=$2,discovered_count=$3,saved_count=$4,error_count=$5,note=$6 WHERE id=$1',
      [id, state, discovered, saved, errors, JSON.stringify({ deferred })]);
    return { id, state, discovered, saved, errors, deferred };
  } catch (error) {
    if (id) await lock.query('UPDATE sync_runs SET finished_at=now(),state=$2,note=$3 WHERE id=$1', [id, 'failed', String(error)]);
    throw error;
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock(70400200)'); }
    finally { release(); }
  }
}

export async function importObservedSnapshot() {
  const path = fileURLToPath(new URL('../../data/observed-amazon.json', import.meta.url));
  const raw = JSON.parse(await readFile(path, 'utf8')) as Observation[];
  return ingestObservations(raw);
}
