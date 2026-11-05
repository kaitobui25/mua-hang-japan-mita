import { load } from 'cheerio';
import type { PoolClient } from 'pg';
import { db } from '../db/pool.js';
import { uniqueImages } from './enrichment.js';
import { AMAZON_ACCESS_LOCK, amazonGate, recordAmazonPause } from './source-access.js';
import { ScraplingSession, QuoteTransportError } from './scrapling.js';
import { parseJpy, SourceError, type Observation } from './source.js';

export type ManualAmazonMode = 'images' | 'price' | 'presence';
type Candidate = { asin: string; category_slug: string; image_url: string | null;
  price_observed_at: Date | null; last_seen_at: Date; urls: string[] | null };
type Evidence = { asin: string; observedAt: string; priceJpy?: number | null;
  availability?: 'in_stock' | 'out_of_stock' | 'unknown'; imageUrls?: string[];
  completeGallery?: boolean; presence?: 'present' | 'not_found_http_404' };
type Failure = { asin: string | null; code: string; detail: string };
type ItemOutcome = { asin: string; outcome: 'updated' | 'unchanged' | 'present' | 'not_found_http_404' | 'failed';
  availability?: string; priceJpy?: number | null; reason?: string };

export type ManualAmazonResult = {
  version: 1; worker: 'amazon'; mode: ManualAmazonMode;
  state: 'completed' | 'partial' | 'failed' | 'blocked' | 'busy' | 'unresolved';
  selected: number; attempted: number; succeeded: number; failed: number;
  updated: number; unchanged: number; deferred: number; present: number;
  outOfStock: number; notFoundHttp404: number; unknownAvailability: number; unresolved: number;
  failures: Failure[]; items: ItemOutcome[];
};

export function selectManualCandidates(rows: Candidate[], mode: ManualAmazonMode, limit: number): Candidate[] {
  if (!['images','price','presence'].includes(mode) || !Number.isInteger(limit) || limit < 1 || limit > 300)
    throw Error('invalid_manual_amazon_request');
  return [...rows].sort((a, b) => {
    const score = (r: Candidate) => mode === 'images' ? uniqueImages(r.urls?.length ? r.urls : [r.image_url]).length :
      mode === 'price' ? r.price_observed_at?.getTime() ?? 0 : r.last_seen_at.getTime();
    return score(a) - score(b) || a.asin.localeCompare(b.asin);
  }).slice(0,limit);
}

/** Only an ASIN-bound Amazon detail HTML can demonstrate that its page exists.
 * An empty price or unknown stock state does NOT demonstrate that it disappeared. */
export function parseManualEvidence(html: string, asin: string, observedAt: Date): Evidence {
  const $ = load(html);
  const ids: string[] = $('input#ASIN, input[name="ASIN"]').map((_,el) => $(el).attr('value')?.trim().toUpperCase() ?? '').get();
  $('link[rel="canonical"]').each((_,el) => {
    const raw = $(el).attr('href');
    try {
      const url = new URL(raw ?? '');
      const id = url.hostname === 'www.amazon.co.jp' || url.hostname === 'amazon.co.jp'
        ? url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1] : null;
      ids.push(id?.toUpperCase() ?? 'invalid');
    } catch { ids.push('invalid'); }
  });
  const title = $('#productTitle').first().text().trim();
  if (!ids.length || ids.some(id => id !== asin) || title.length < 8)
    throw new SourceError('parse_error','Amazon page/ASIN identity not confirmed');
  const priceText = $('#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #corePrice_feature_div .priceToPay .a-offscreen, #priceblock_ourprice, #price_inside_buybox').first().text();
  const availability = $('#availability').first().text();
  return { asin, observedAt: observedAt.toISOString(), priceJpy: parseJpy(priceText),
    availability: /在庫切れ|現在お取り扱いできません|currently unavailable|out of stock/i.test(availability) ? 'out_of_stock'
      : /在庫あり|in stock/i.test(availability) ? 'in_stock' : 'unknown' };
}

export function validateManualEvidence(item: Evidence, asin: string): Date {
  const observed = new Date(item.observedAt);
  if (item.asin !== asin || !Number.isFinite(observed.getTime()) || observed.getTime() > Date.now() + 1000)
    throw new SourceError('parse_error','Amazon evidence identity/time invalid');
  return observed;
}

export async function updateOnlyImages(client: Pick<PoolClient,'query'>, asin: string, item: Evidence): Promise<boolean> {
  const observed = validateManualEvidence(item, asin);
  const incoming = uniqueImages(item.imageUrls ?? []);
  if (!incoming.length) throw new SourceError('parse_error','No suitable Amazon images observed');
  const prior = await client.query<{ source_url: string; source_observed_at: Date }>(
    'SELECT source_url,source_observed_at FROM product_images WHERE asin=$1 ORDER BY position', [asin]);
  const old = prior.rows.map(r => r.source_url);
  const usableOld = uniqueImages(old);
  // Never erase a good gallery merely because Amazon returned a partial page.
  const next = item.completeGallery && incoming.length >= usableOld.length
    ? incoming : uniqueImages([...usableOld, ...incoming]);
  if (old.length === next.length && old.every((url,i) => url === next[i])) return false;
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM product_images WHERE asin=$1', [asin]);
    for (const [index,url] of next.entries()) {
      const oldRow = prior.rows.find(r => r.source_url === url);
      await client.query('INSERT INTO product_images(asin,position,source_url,source_observed_at) VALUES($1,$2,$3,$4)',
        [asin,index+1,url,oldRow?.source_observed_at ?? observed]);
    }
    await client.query('UPDATE products SET image_url=$2,updated_at=now() WHERE asin=$1', [asin,next[0]]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function updateOnlyPrice(client: Pick<PoolClient,'query'>, asin: string, item: Evidence): Promise<boolean> {
  const observed = validateManualEvidence(item, asin);
  if (!Number.isSafeInteger(item.priceJpy) || (item.priceJpy ?? 0) < 1 || (item.priceJpy ?? 0) > 100000)
    throw new SourceError('parse_error','Amazon JPY price not confirmed; previous price preserved');
  await client.query('BEGIN');
  try {
    const saved = await client.query(`UPDATE products SET price_jpy=$2,price_observed_at=$3,updated_at=now()
      WHERE asin=$1 AND (price_observed_at IS NULL OR price_observed_at<=$3) RETURNING asin`,
    [asin,item.priceJpy,observed]);
    if (saved.rows.length) await client.query(`INSERT INTO price_observations(asin,price_jpy,observed_at,source_adapter)
      VALUES($1,$2,$3,'scrapling-detail') ON CONFLICT DO NOTHING`, [asin,item.priceJpy,observed]);
    await client.query('COMMIT');
    return saved.rows.length > 0;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function runManualAmazonScan(options: {
  mode: ManualAmazonMode; limit: number;
  connect?: () => Promise<PoolClient>;
  fetch?: (asin: string, category: string) => Promise<Evidence>;
  pause?: (milliseconds: number) => Promise<void>;
}): Promise<ManualAmazonResult> {
  const { mode, limit } = options;
  selectManualCandidates([],mode,limit); // validate before connecting to DB / Amazon
  const report: ManualAmazonResult = { version:1,worker:'amazon',mode,state:'completed',
    selected:0,attempted:0,succeeded:0,failed:0,updated:0,unchanged:0,deferred:0,
    present:0,outOfStock:0,notFoundHttp404:0,unknownAvailability:0,unresolved:0,failures:[],items:[] };
  const client = await (options.connect ?? (() => db.connect()))();
  const acquired: number[] = [];
  const session = options.fetch ? null : new ScraplingSession();
  try {
    for (const key of [AMAZON_ACCESS_LOCK,70400300,70400301]) {
      const held = await client.query<{ acquired:boolean }>('SELECT pg_try_advisory_lock($1) AS acquired',[key]);
      if (!held.rows[0]?.acquired) {
        report.state='busy';report.failures.push({asin:null,code:'worker_busy',detail:'Another worker or sync is active'});
        return report;
      }
      acquired.push(key);
    }
    if (!await amazonGate(client,false)) {
      report.state='blocked'; report.failures.push({asin:null,code:'amazon_cooldown',detail:'Amazon source cooldown; manual retry forbidden'});
      return report;
    }
    const catalog = await client.query<Candidate>(`SELECT p.asin,p.category_slug,p.image_url,p.price_observed_at,p.last_seen_at,
      array_agg(i.source_url ORDER BY i.position) FILTER (WHERE i.position IS NOT NULL) AS urls
      FROM products p LEFT JOIN product_images i USING(asin)
      WHERE p.category_slug IN ('thuc-pham-bo-sung','thuc-pham-cho-be')
      GROUP BY p.asin ORDER BY p.asin`);
    const selected = selectManualCandidates(catalog.rows,mode,limit);
    report.selected=selected.length;
    const getEvidence = options.fetch ?? (async (asin:string, category:string): Promise<Evidence> => {
      if (mode==='images') {
        const item: Observation = await session!.detail(asin,category);
        return {asin:item.asin,observedAt:item.observedAt,imageUrls:item.imageUrls,
          completeGallery: item.detail?.provenance.sections.includes('gallery:complete')};
      }
      return await session!.inspect(asin,category);
    });
    for (const row of selected) {
      if (report.attempted) await (options.pause ?? (ms => new Promise(resolve => setTimeout(resolve,ms))))(1200);
      report.attempted++;
      try {
        const item=await getEvidence(row.asin,row.category_slug);
        validateManualEvidence(item,row.asin);
        if (item.presence==='not_found_http_404') {
          if (mode==='price') {
            report.failed++;
            report.failures.push({asin:row.asin,code:'http_404',detail:'Product page returned HTTP 404; old price preserved'});
            report.items.push({asin:row.asin,outcome:'failed',reason:'http_404'});
            continue;
          }
          report.succeeded++;report.notFoundHttp404++;
          report.items.push({asin:row.asin,outcome:'not_found_http_404'});
          console.log(`MANUAL_AMAZON_ITEM ${row.asin} HTTP_404 (not proof of permanent removal)`);
          continue;
        }
        let changed=false;
        if (mode==='images') changed=await updateOnlyImages(client,row.asin,item);
        else if (mode==='price') changed=await updateOnlyPrice(client,row.asin,item);
        else {
          report.present++;
          if (item.availability==='out_of_stock') report.outOfStock++;
          if (item.availability==='unknown') report.unknownAvailability++;
        }
        report.succeeded++;
        if (changed) report.updated++; else report.unchanged++;
        report.items.push({asin:row.asin,outcome:mode==='presence'?'present':changed?'updated':'unchanged',
          availability:item.availability,priceJpy:mode==='price'?item.priceJpy:undefined});
        console.log(`MANUAL_AMAZON_ITEM ${row.asin} OK ${mode==='presence'?'present':changed?'updated':'unchanged'}`);
      } catch (error) {
        const failure=error instanceof SourceError ? error : error instanceof QuoteTransportError ?
          new SourceError(error.code==='amazon_blocked'?'blocked':error.code==='amazon_rate_limited'?'rate_limited':'temporary',
            error.code,'scrapling',error.retryAfterAt) :
          new SourceError('temporary','Amazon read or save failed');
        const code = failure.state === 'blocked' || failure.state === 'rate_limited' ? failure.state :
          /HTTP 404/.test(failure.message) ? 'http_404_unconfirmed' : failure.state;
        if (!(error instanceof SourceError) && !(error instanceof QuoteTransportError)) {
          report.unresolved++;
          report.failures.push({asin:row.asin,code:'database_or_runtime_outcome_unresolved',detail:'Inspect DB/log before any retry'});
          report.items.push({asin:row.asin,outcome:'failed',reason:'unresolved'});
          report.deferred=selected.length-report.attempted;
          report.state='unresolved';
          break;
        }
        report.failed++;
        report.failures.push({asin:row.asin,code,detail:failure.message.slice(0,160)});
        report.items.push({asin:row.asin,outcome:'failed',reason:code});
        console.log(`MANUAL_AMAZON_ITEM ${row.asin} FAILED ${code}`);
        if (failure.state === 'blocked' || failure.state === 'rate_limited') {
          await recordAmazonPause(client,failure.message,failure.retryAfterAt);
          report.deferred=selected.length-report.attempted;
          report.state='blocked';
          break;
        }
      }
    }
    if (report.state==='completed' && report.failed) report.state=report.succeeded?'partial':'failed';
    return report;
  } finally {
    session?.close();
    let discard=false;
    for (const key of acquired.reverse()) {
      try { await client.query('SELECT pg_advisory_unlock($1)',[key]); }
      catch { discard=true; }
    }
    client.release(discard);
  }
}
