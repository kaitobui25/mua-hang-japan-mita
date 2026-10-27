import { randomUUID } from 'node:crypto';
import { db } from '../db/pool.js';
import { AdminError, audit, pagination, transaction } from './data.js';
import { normalizeAmazonInput, collectDetail } from '../ingestion/detail.js';
import { ingestObservations } from '../ingestion/store.js';
import { SourceError, isAmazonCaptcha, type Observation } from '../ingestion/source.js';
import { openNeoManualVerification } from '../ingestion/neo.js';
import { AMAZON_ACCESS_LOCK } from '../ingestion/source-access.js';

export async function enqueueImport(input: unknown, category: unknown, actor: number) {
  let asin: string;
  try { asin = normalizeAmazonInput(input); } catch (error) { throw new AdminError(400, (error as Error).message); }
  if (!['thuc-pham-bo-sung', 'thuc-pham-cho-be'].includes(category as string)) throw new AdminError(400, 'Chọn một trong hai danh mục.');
  return transaction(async client => {
    // Serialize enqueue checks so duplicates and the global queue limits are atomic.
    await client.query('SELECT pg_advisory_xact_lock(724301)');
    const existing = await client.query('SELECT asin,admin_hidden_at FROM products WHERE asin=$1', [asin]);
    if (existing.rows[0]) return { existingProduct: existing.rows[0] };
    const active = await client.query("SELECT * FROM catalog_import_requests WHERE asin=$1 AND state IN ('pending','running')", [asin]);
    if (active.rows[0]) return { request: active.rows[0], duplicate: true };
    const recent = await client.query("SELECT count(*)::int AS count FROM catalog_import_requests WHERE created_at>now()-interval '1 hour'");
    const pending = await client.query("SELECT count(*)::int AS count FROM catalog_import_requests WHERE state IN ('pending','running')");
    if (recent.rows[0].count >= 20 || pending.rows[0].count >= 20) throw new AdminError(429, 'Tối đa 20 yêu cầu mỗi giờ hoặc đang chờ. Hãy thử sau.');
    const result = await client.query('INSERT INTO catalog_import_requests(id,asin,category_slug,actor_id) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), asin, category, actor]);
    await audit(client, actor, 'catalog.import_requested', asin, null, { id: result.rows[0].id, category });
    return { request: result.rows[0], duplicate: false };
  });
}
export async function listImports(q: Record<string, string | undefined>) {
  const { page, limit, offset } = pagination(q);
  const result = await db.query('SELECT id,asin,category_slug,state,error,created_at,started_at,finished_at FROM catalog_import_requests ORDER BY created_at DESC,id LIMIT $1 OFFSET $2', [limit, offset]);
  const total = await db.query('SELECT count(*)::int AS total FROM catalog_import_requests');
  return { items: result.rows, total: total.rows[0].total, page, limit };
}

// One request at a time per worker; SKIP LOCKED also supports multiple local workers.
// No automatic source retry after denial. An interrupted claim requires owner review.
export async function processNextImport(collector: (asin: string, category: string) => Promise<Observation> = collectDetail) {
  const client = await db.connect();
  try {
    // Do not claim a job while another importer or the daily sync is fetching
    // Amazon. A busy lock leaves the job pending for the next worker poll.
    const guard = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [AMAZON_ACCESS_LOCK]);
    if (!guard.rows[0].acquired) return false;
    try {
      await client.query("UPDATE catalog_import_requests SET state='needs_human',error='Worker bị gián đoạn; kiểm tra trước khi yêu cầu lại.',finished_at=now() WHERE state='running' AND started_at<now()-interval '5 minutes'");
      // Check the persisted Amazon gate *after* claiming the common source lock.
      const gate = await client.query<{ blocked: boolean }>(`SELECT (
        EXISTS (SELECT 1 FROM source_access_blocks WHERE source='amazon.co.jp') OR
        EXISTS (SELECT 1 FROM product_detail_queue WHERE state='needs_human')) AS blocked`);
      if (gate.rows[0].blocked) return false;
      const claimed = await client.query(`UPDATE catalog_import_requests SET state='running',started_at=now()
        WHERE id=(SELECT id FROM catalog_import_requests WHERE state='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
      const job = claimed.rows[0];
      if (!job) return false;
      try {
        const observation = await collector(job.asin, job.category_slug);
        if (observation.asin !== job.asin || observation.categorySlug !== job.category_slug || !observation.name?.trim() ||
          !observation.imageUrl || !Number.isInteger(observation.priceJpy) || observation.priceJpy! <= 0 ||
          !Number.isFinite(new Date(observation.observedAt).getTime()) || new Date(observation.observedAt).getTime() > Date.now()) throw new SourceError('parse_error', 'Dữ liệu sản phẩm không hợp lệ.');
        await client.query('BEGIN');
        try {
          const current = await client.query("SELECT id FROM catalog_import_requests WHERE id=$1 AND state='running' FOR UPDATE", [job.id]);
          if (current.rowCount) {
            await ingestObservations([observation], undefined, client);
            await client.query("UPDATE catalog_import_requests SET state='succeeded',finished_at=now() WHERE id=$1", [job.id]);
            await audit(client, job.actor_id, 'catalog.import_succeeded', job.asin, null, { id: job.id });
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      } catch (error) {
        const state = error instanceof SourceError && ['blocked', 'needs_human'].includes(error.state) ? 'needs_human' : 'failed';
        if (state === 'needs_human') {
          await client.query(`INSERT INTO source_access_blocks(source,reason)
            VALUES('amazon.co.jp','Admin ASIN import requires manual Amazon verification')
            ON CONFLICT(source) DO UPDATE SET reason=EXCLUDED.reason,blocked_at=now()`);
        }
        // Store a source message, never arbitrary SQL/connection errors or secrets.
        const message = error instanceof SourceError ? error.message.slice(0, 1000) : 'Không thể lưu sản phẩm; kiểm tra worker và cơ sở dữ liệu.';
        await client.query("UPDATE catalog_import_requests SET state=$2,error=$3,finished_at=now() WHERE id=$1 AND state='running'", [job.id, state, message]);
        if (collector === collectDetail && error instanceof SourceError && isAmazonCaptcha(error)) {
          try {
            await openNeoManualVerification(`https://www.amazon.co.jp/dp/${job.asin}`);
            console.warn('Amazon CAPTCHA: BrowserOS Neo tab opened for owner verification. Import and source access remain blocked.');
          } catch {
            console.warn('Amazon CAPTCHA: BrowserOS Neo unavailable; import remains blocked pending owner verification.');
          }
        }
      }
      return true;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [AMAZON_ACCESS_LOCK]);
    }
  } finally { client.release(); }
}
