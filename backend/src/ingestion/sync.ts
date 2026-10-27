import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from '../db/pool.js';
import { discoverHttp, seeds, SourceError, type DiscoveryResult, type DiscoveryIssue, type Observation } from './source.js';
import { ingestObservations } from './store.js';
import { discoverNeo } from './neo.js';

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

export async function syncCatalog() {
  const runResult = await db.query<{ id: string }>('INSERT INTO sync_runs DEFAULT VALUES RETURNING id');
  const id = Number(runResult.rows[0].id);
  let discovered = 0, saved = 0, errors = 0, blocked = false;
  try {
    for (const seed of seeds) {
      try {
        const { observations, issues } = await collectCategory(seed);
        discovered += observations.length;
        saved += await ingestObservations(observations, id);
        for (const issue of issues) {
          errors++;
          if (issue.state === 'blocked' || issue.state === 'needs_human') blocked = true;
          await db.query('INSERT INTO sync_errors(sync_run_id,category_slug,adapter,state,message) VALUES($1,$2,$3,$4,$5)', [id, seed.categorySlug, issue.adapter, issue.state, issue.page ? `Page ${issue.page}: ${issue.message}` : issue.message]);
        }
        console.log(`${seed.categorySlug}: ${observations.length} discovered`);
      } catch (error) {
        errors++;
        const status = error instanceof SourceError ? error.state : 'temporary';
        if (status === 'blocked' || status === 'needs_human') blocked = true;
        console.error(`${seed.categorySlug}: ${status}:`, error);
        await db.query('INSERT INTO sync_errors(sync_run_id,category_slug,adapter,state,message) VALUES($1,$2,$3,$4,$5)', [id, seed.categorySlug, error instanceof SourceError ? error.adapter : 'http', status, String(error)]);
      }
    }
    const state = blocked ? 'needs_human' : errors ? (saved ? 'partial' : 'failed') : 'success';
    await db.query('UPDATE sync_runs SET finished_at=now(),state=$2,discovered_count=$3,saved_count=$4,error_count=$5 WHERE id=$1', [id, state, discovered, saved, errors]);
    console.log(`Sync ${id}: ${state}; saved ${saved}; errors ${errors}`);
    return { id, state, discovered, saved, errors };
  } catch (error) {
    await db.query('UPDATE sync_runs SET finished_at=now(),state=$2,note=$3 WHERE id=$1', [id, 'failed', String(error)]);
    throw error;
  }
}

export async function importObservedSnapshot() {
  const path = fileURLToPath(new URL('../../data/observed-amazon.json', import.meta.url));
  const raw = JSON.parse(await readFile(path, 'utf8')) as Observation[];
  return ingestObservations(raw);
}
