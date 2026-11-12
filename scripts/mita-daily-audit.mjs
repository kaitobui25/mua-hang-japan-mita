// Only the entrypoint under the PowerShell named mutex may run a live audit.
// No migrations, service control, order cleanup, payment or direct DB writes.
import { createHash, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tableSpecs } from '../backend/scripts/sync-catalog-vps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://mitajapanshop.duckdns.org';
const categories = ['thuc-pham-bo-sung', 'thuc-pham-cho-be'];
const runtime = path.join(root, '.agents', 'runtime', 'daily-audit');
const sha = value => createHash('sha256').update(value).digest('hex');
class AuditError extends Error {}
const need = (condition, message) => { if (!condition) throw new AuditError(message); };
export const jstDay = (now = new Date()) => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export function checkoutKey(day) {
  need(/^\d{4}-\d{2}-\d{2}$/.test(day), 'Ngày JST không hợp lệ.');
  // Permanent domain/version: NEVER change this formula to retry a failed checkout.
  const hex = sha(`mita-daily-audit:live-checkout:v1:${origin}:${day}`).slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const s = hex.join('');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
const fingerprint = payload => sha(JSON.stringify({ items: payload.items, quoteItems: [], customer: payload.customer }));
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const safeName = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 180);
const states = new Set(['pending','running','completed','skipped','partial','failed','unknown','deferred','success']);
const safeState = state => states.has(state) ? state : 'không xác định';
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const metric = (value, label) => safeCount(value) === null ? null : `${label}: ${value}`;
const syncLogPaths = {
  journal:'mita-supervisor.jsonl', stderr:'nightly-sync.err.log', stdout:'nightly-sync.out.log'
};
const knownTables = new Set(tableSpecs.map(([table]) => table));

// Private worker/sync messages are untrusted and may contain credentials or customer data.
// Report ONLY recognized, bounded state fields, SQLSTATEs and numeric VERIFY counts.
export function diagnoseJob(job, day) {
  const fix = 'Đối chiếu mita-daily-' + day + '.json và nhật ký Supervisor; kiểm tra lượt job đã ghi nhận trước khi quyết định xử lý, không tự chạy bù.';
  if (!job) return { reason:'Supervisor chưa ghi nhận job trong ngày JST.', fix };
  if (job.day !== day) return { reason:'Job không có bằng chứng thuộc ngày JST đang kiểm tra.', fix };
  const state = safeState(job.state);
  if ([job.failed,job.warnings].some(value => value != null && safeCount(value) === null)) {
    return { reason:'Số liệu lỗi/cảnh báo của job không hợp lệ; chưa thể xác nhận sạch lỗi.', fix };
  }
  const counts = [metric(job.failed,'lỗi'),metric(job.warnings,'cảnh báo')].filter(Boolean);
  if (state === 'completed' && counts.every(x => !/^(lỗi|cảnh báo): [1-9]/.test(x))) return null;
  if (state === 'partial' || counts.some(x => /^(lỗi|cảnh báo): [1-9]/.test(x))) {
    return { reason:`Job ${state}; ${counts.length ? counts.join(', ') : 'chưa có số liệu lỗi/cảnh báo'}.`, fix:'Đối chiếu số liệu run trong DB local với log worker tương ứng; xử lý các mục thất bại sau khi xác minh, không chạy bù từ audit.' };
  }
  const descriptions = {
    failed:'Job được Supervisor ghi nhận failed.',
    unknown:'Supervisor không xác định được kết quả job.',
    running:'Job vẫn ở trạng thái running; chưa có kết quả cuối.',
    pending:'Job chưa có kết quả chạy trong ngày.',
    skipped:'Job đã bị bỏ qua theo trạng thái Supervisor.',
    deferred:'Job được hoãn; chưa hoàn tất trong ngày.'
  };
  return { reason:descriptions[state] ?? 'Trạng thái job chưa được nhận diện.', fix };
}

export function diagnoseLedger(row, day, syncEvidence = null) {
  const committed = Boolean(row?.committed_at && /^[a-f0-9]{64}$/.test(row.source_hash) && /^[a-f0-9]{64}$/.test(row.remote_hash));
  const state = safeState(row?.state);
  if (state === 'completed' && committed) return { status:'OK', committed };
  const status = state === 'failed' ? 'FAIL' : 'WARN';
  const fix = 'Đối chiếu ledger VPS và nhật ký nightly-sync; giữ nguyên run/ledger, không tự chạy lại hoặc sửa DB.';
  if (state === 'failed' && row?.note === 'Transfer rolled back before COMMIT') {
    return { status, committed,
      reason:`Ledger xác nhận ROLLBACK trước COMMIT.${syncEvidence?.reason ? ' ' + syncEvidence.reason : ''}`,
      fix:syncEvidence?.fix ?? 'Đọc lỗi trong nightly-sync.err.log và kết quả VERIFY trước khi đề xuất sửa schema/dữ liệu; không tự chạy lại.' };
  }
  if (state === 'partial' && committed && row?.note === 'Partial gallery preserved; verify identities') {
    return { status, committed, reason:'Ledger xác nhận đã COMMIT nhưng ảnh gallery chưa đầy đủ; giữ lại ảnh tốt trước đó.', fix:'Đối chiếu danh tính và độ đầy đủ ảnh trong log GALLERY/VERIFY; chỉ đồng bộ lại theo quy trình được duyệt.' };
  }
  const note = typeof row?.note === 'string' ? row.note : '';
  const partial = /^(?:Partial galleries preserved: ([0-9]{1,8})(?:; )?)?(?:Deferred stale Codex titles: ([0-9]{1,8}) \(source_changed\))?$/.exec(note);
  if (state === 'partial' && committed && partial && (Number(partial[1]) > 0 || Number(partial[2]) > 0)) {
    const reasons = [];
    if (Number(partial[1]) > 0) reasons.push(`${Number(partial[1])} gallery thiếu ảnh hoàn chỉnh được giữ ảnh cũ`);
    if (Number(partial[2]) > 0) reasons.push(`${Number(partial[2])} tiêu đề Codex cũ được hoãn do nguồn đổi (source_changed)`);
    return { status, committed, reason:`Ledger COMMIT partial: ${reasons.join('; ')}.`,
      fix:'Đối chiếu số lượng GALLERY và SYNC_DEFERRED_TRANSLATIONS trong nightly-sync.out.log với revision/ảnh đã xuất bản; không ghi đè dữ liệu hoặc chạy bù.' };
  }
  if (state === 'completed' && !committed) return { status:'WARN', committed, reason:'Ledger completed nhưng thiếu dấu COMMIT hoặc hash hợp lệ.', fix:'Kiểm tra committed_at/source_hash/remote_hash và bản ghi giao dịch; chưa kết luận dữ liệu đã đồng bộ.' };
  if (syncEvidence?.reason && (state === 'failed' || state === 'partial')) {
    return { status, committed, reason:`Ledger ${state}. ${syncEvidence.reason}`, fix:syncEvidence.fix };
  }
  return { status, committed, reason:`Ledger ở trạng thái ${state}${committed ? ', có dấu COMMIT' : ', chưa đủ dấu COMMIT'}. Chưa có nguyên nhân được xác minh trong ledger.`, fix };
}

export function diagnoseSyncError(message, verify = []) {
  const issues = verify.filter(x => knownTables.has(x?.table) && safeCount(x?.missing) !== null && safeCount(x?.contentMismatch) !== null &&
    (x.missing > 0 || x.contentMismatch > 0)).slice(0, 3);
  const detail = issues.length ? ` VERIFY: ${issues.map(x => `${x.table} (thiếu ${x.missing}, lệch ${x.contentMismatch})`).join('; ')}.` : '';
  if (message === 'Data verification failed before commit' || message === 'Data verification failed: missing/mismatched remote content') {
    return { reason:`Đối chiếu dữ liệu trước COMMIT không đạt.${detail}`, fix:'Đọc bảng/count sai lệch trong nightly-sync.out.log (VERIFY), đối chiếu dữ liệu nguồn và VPS bằng truy vấn chỉ đọc; giữ ledger, không chạy lại sync.' };
  }
  const schema = /^((?:Local|VPS) transfer schema incompatible): ([a-z_]+) \(([0-9A-Z]{5})\)$/.exec(message ?? '');
  if (schema && knownTables.has(schema[2])) {
    const detail = schema[3] === '42703' ? ' (thiếu cột)' : schema[3] === '42P01' ? ' (thiếu bảng)' : '';
    return { reason:`Schema ${schema[1].startsWith('VPS') ? 'VPS' : 'local'} không tương thích: ${schema[2]}, SQLSTATE ${schema[3]}${detail}.`, fix:'Đối chiếu schema thực tế với hợp đồng sync; migration chỉ sau khi được xem xét và duyệt riêng.' };
  }
  const classified = new Map([
    ['Catalog writer is active; no reservation made', ['Đã có writer giữ khóa catalog; sync không chiếm được khóa.', 'Xác minh tiến trình/khóa đang chạy và ledger, không cưỡng ép chạy lại.']],
    ['Daily batch already claimed but not completed; manual inspection required', ['Ledger đồng bộ ngày JST đã được claim nhưng chưa completed.', 'Đối chiếu run_id, trạng thái commit và tiến trình hiện tại; không claim hoặc chạy lại.']],
    ['Unresolved daily batch; manual inspection required', ['Có batch đồng bộ ngày trước chưa kết thúc.', 'Đối chiếu ledger running/commit trước khi quyết định bước tiếp theo.']],
    ['Unresolved deploy batch; manual inspection required', ['Có batch deploy chưa kết thúc, sync bị chặn.', 'Kiểm tra catalog_deploy_ledger và tiến trình deploy; không giải phóng claim thủ công.']],
    ['Catalog ledger reservation changed; refusing commit', ['Dấu claim ledger thay đổi trước COMMIT.', 'Điều tra run_id/ledger và transaction; không lặp lại.']],
    ['Daily sync requires all three terminal job states for the same JST day', ['Barrier 3 worker chưa có trạng thái kết thúc cùng ngày JST.', 'Đối chiếu ngày và trạng thái trong mita-daily-YYYY-MM-DD.json.']],
    ['Sync ledger is missing; run reviewed migrate-vps-sync-ledger.mjs --apply separately', ['VPS thiếu catalog_sync_ledger.', 'Đối chiếu schema và đề xuất migration riêng để duyệt.']],
    ['Encrypted VPS database connection is not configured', ['Thiếu cấu hình kết nối VPS được mã hóa.', 'Kiểm tra cấu hình mã hóa và quyền đọc cục bộ; không in chuỗi kết nối.']]
  ]);
  const match = classified.get(message);
  return match ? { reason:match[0], fix:match[1] } : null;
}

// Tail only private audit-relevant files. The raw messages never reach stdout.
async function readPrivateTail(name) {
  let handle;
  try {
    handle = await open(path.join(root,'.agents','runtime',name),'r');
    const stat = await handle.stat();
    const size = Math.min(stat.size, 128 * 1024);
    const buffer = Buffer.alloc(size);
    const bytesRead = size ? (await handle.read(buffer,0,size,stat.size - size)).bytesRead : 0;
    return { text:buffer.toString('utf8',0,bytesRead), mtimeMs:stat.mtimeMs };
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

export function syncEvidenceFromLogs(day, sync, journal, stderr, stdout) {
  if (sync?.state !== 'failed' && sync?.state !== 'partial' && sync?.state !== 'unknown') return null;
  const finishedAt = Date.parse(sync.at);
  if (!Number.isFinite(finishedAt) || !journal?.text) return null;
  let startedAt = null, lastFinished = null;
  for (const line of journal.text.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.day !== day) continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at)) continue;
    if (item.event === 'sync_started') startedAt = at;
    if (item.event === 'sync_finished') lastFinished = { at, code:item.exitCode, start:startedAt };
  }
  if (!lastFinished || lastFinished.start === null || lastFinished.start > lastFinished.at ||
      Math.abs(lastFinished.at - finishedAt) > 60_000) return null;
  const inWindow = file => file?.mtimeMs >= lastFinished.start - 1000 && file.mtimeMs <= lastFinished.at + 60_000;
  const attemptLines = file => {
    if (!file?.text) return [];
    const lines = file.text.split(/\r?\n/);
    const markers = lines.flatMap((line,index) => line.startsWith('SYNC_ATTEMPT_START ')
      ? [{ index, at:Date.parse(line.slice('SYNC_ATTEMPT_START '.length)) }] : []);
    if (markers.length) {
      // New supervisor writes dated markers to both logs. Never use an earlier
      // attempt's error merely because the same append-only file was modified.
      const current = markers.filter(marker => Number.isFinite(marker.at) &&
        marker.at >= lastFinished.start - 60_000 && marker.at <= lastFinished.at + 30_000).at(-1);
      if (!current) return [];
      const next = markers.find(marker => marker.index > current.index);
      return lines.slice(current.index + 1,next?.index ?? lines.length).filter(line => line.trim());
    }
    // Historical logs from before the per-attempt marker was introduced.
    return inWindow(file) ? lines.filter(line => line.trim()) : [];
  };
  const messages = attemptLines(stderr);
  const failureIndex = messages.findLastIndex(line => line.startsWith('SYNC_FAILED '));
  // The wrapper ends a transfer error with this exact line. A prior error plus a new
  // unrelated failure must not be attributed to the new run.
  const suffix = messages.slice(failureIndex + 1);
  const trace = line => /^\s*\+/.test(line) ||
    (line.length <= 300 && line.includes('nightly-vps-sync.ps1'));
  const lastFailure = failureIndex >= 0 && suffix[0] === 'Daily sync failed; inspect remote ledger and private logs' &&
    suffix.length <= 9 && suffix.slice(1).every(trace)
    ? messages[failureIndex] : null;
  const outLines = attemptLines(stdout);
  const verifyLine = outLines.filter(line => line.startsWith('VERIFY ')).at(-1);
  let verify = [];
  if (verifyLine) {
    try { const parsed = JSON.parse(verifyLine.slice(7)); if (Array.isArray(parsed)) verify = parsed; } catch { /* Untrusted private log. */ }
  }
  const unconfirmedIndex = messages.findLastIndex(line => line === 'SYNC_ROLLBACK_UNCONFIRMED: running ledger preserved; manual inspection required');
  const unconfirmed = unconfirmedIndex >= 0 && failureIndex >= 0 && failureIndex - unconfirmedIndex <= 1 && Boolean(lastFailure);
  if (unconfirmed && lastFinished.code !== 0) return {
    exitCode:lastFinished.code, reason:'Nhật ký ghi ROLLBACK chưa được xác nhận; kết quả commit có thể chưa rõ.',
    fix:'Kiểm tra ledger VPS và trạng thái transaction bằng truy vấn chỉ đọc; tuyệt đối không chạy lại khi commit còn bất định.'
  };
  const diagnosis = lastFailure && diagnoseSyncError(lastFailure.slice('SYNC_FAILED '.length), verify);
  if (sync.state === 'partial') {
    const commitLine = outLines.filter(line => line.startsWith('SYNC_COMMIT_OK ')).at(-1);
    let marker;
    try { marker = JSON.parse(commitLine?.slice('SYNC_COMMIT_OK '.length)); } catch { /* Not trusted. */ }
    if (marker?.day === day && marker.state === 'partial' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marker.runId) &&
        safeCount(marker.galleryPartial) !== null && safeCount(marker.deferredTranslations) !== null) {
      const reasons = [];
      if (marker.galleryPartial > 0) reasons.push(`${marker.galleryPartial} gallery thiếu ảnh hoàn chỉnh`);
      if (marker.deferredTranslations > 0) reasons.push(`${marker.deferredTranslations} bản dịch Codex hoãn do nguồn đổi`);
      if (reasons.length) return { exitCode:lastFinished.code,
        reason:`Nhật ký COMMIT partial ngày ${day}: ${reasons.join('; ')}.`,
        fix:'Đối chiếu GALLERY, SYNC_DEFERRED_TRANSLATIONS và ledger VPS; không cưỡng ép cập nhật dữ liệu đã giữ.' };
    }
  }
  return { exitCode:lastFinished.code,
    ...(diagnosis ? {reason:`Nhật ký gần nhất ghi: ${diagnosis.reason}`,fix:diagnosis.fix} : {}) };
}

async function loadSyncEvidence(day, sync) {
  if (!['failed','partial','unknown'].includes(sync?.state)) return null;
  const [journal, stderr, stdout] = await Promise.all(Object.values(syncLogPaths).map(readPrivateTail));
  return syncEvidenceFromLogs(day, sync, journal, stderr, stdout);
}

// Shared replication contract comes from the guarded, import-safe sync module.
// Local worker infrastructure and the VPS daily ledger are intentionally separate.
export function contracts(target) {
  const tables = Object.fromEntries(tableSpecs.map(([name, columns]) => [name, Object.fromEntries(columns)]));
  const add = (table, columns) => { tables[table] = { ...tables[table], ...columns }; };
  add('products', { rights_status:'text', sale_status:'text', admin_hidden_at:'timestamptz' });
  add('product_images', { asin:'varchar(10)', position:'smallint', source_url:'text', source_observed_at:'timestamptz' });
  add('amazon_product_metrics', { asin:'varchar(10)', snapshot:'jsonb', written_review_count:'bigint', qualification:'text', observed_at:'timestamptz' });
  add('catalog_settings', { id:'integer', hide_local_test_only:'boolean' });
  add('pricing_policy', { id:'integer', version:'integer', fx_jpy_to_vnd:'numeric(12,4)', service_fee_percent:'numeric(6,2)', check_price_expiry:'boolean', price_expiry_days:'integer' });
  add('orders', { id:'uuid', customer_name:'text', customer_phone:'text', customer_email:'text', customer_address:'text', status:'text', payment_status:'text', payment_method:'text', payment_provider:'text', payment_reference:'text', paid_at:'timestamptz', fx_jpy_to_vnd:'numeric(12,4)', service_fee_percent:'numeric(6,2)', merchandise_vnd:'bigint', estimated_shipping_vnd:'bigint', shipping_final_vnd:'bigint', pricing_policy_version:'integer', created_at:'timestamptz', checkout_key:'uuid', checkout_fingerprint:'text', shipping_confirmation_hash:'text' });
  add('order_items', { line_id:'bigint', order_id:'uuid', asin:'varchar(10)', name:'text', quantity:'integer', price_jpy:'integer', unit_price_vnd:'bigint', observed_at:'timestamptz', quote_snapshot:'jsonb' });
  add('order_notification_outbox', { id:'bigint', order_id:'uuid', event_type:'text', recipient:'text', channel:'text', created_at:'timestamptz', acknowledged_at:'timestamptz' });
  const indexes = {
    products_pkey: ['products', true, '(asin)'],
    products_category_idx: ['products', false, '(category_slug, updated_at DESC)'],
    product_images_pkey: ['product_images', true, '(asin, position)'],
    product_details_pkey: ['product_details', true, '(asin)'],
    product_translations_pkey: ['product_translations', true, '(asin, locale)'],
    local_detail_translations_pkey: ['local_detail_translations', true, '(asin)'],
    local_detail_translation_items_pkey: ['local_detail_translation_items', true, '(asin, slot)'],
    product_title_presentations_pkey: ['product_title_presentations', true, '(asin)'],
    product_detail_queue_pkey: ['product_detail_queue', true, '(category_slug, asin)'],
    orders_pkey: ['orders', true, '(id)'],
    orders_checkout_key_idx: ['orders', true, '(checkout_key)', 'WHERE (checkout_key IS NOT NULL)'],
    order_items_pkey: ['order_items', true, '(line_id)'],
    order_items_catalog_unique_idx: ['order_items', true, '(order_id, asin)', 'WHERE (quote_snapshot IS NULL)'],
    // PostgreSQL truncates autogenerated constraint names; compare this by shape.
    '@outbox_event_unique': ['order_notification_outbox', true, '(order_id, event_type, recipient, channel)']
  };
  if (target === 'local') {
    add('worker_control_settings', { id:'integer', engine:'text', schedules:'jsonb', version:'integer' });
    add('sync_runs', { id:'bigint', started_at:'timestamptz', finished_at:'timestamptz', state:'text', discovered_count:'integer', saved_count:'integer', error_count:'integer', note:'text' });
    add('codex_name_runs', { id:'uuid', trigger:'text', jst_day:'date', state:'text', selected:'integer', translated:'integer', failed:'integer', warnings:'integer', finished_at:'timestamptz' });
    indexes.codex_name_one_scheduled_day = ['codex_name_runs', true, '(jst_day)', "WHERE (trigger = 'scheduled'::text)"];
  } else {
    add('catalog_sync_ledger', { sync_day:'date', run_id:'uuid', state:'text', jobs:'jsonb', watermark:'timestamptz', source_hash:'text', remote_hash:'text', committed_at:'timestamptz' });
    indexes.catalog_sync_ledger_pkey = ['catalog_sync_ledger', true, '(sync_day)'];
  }
  return { tables, indexes };
}
const typeName = value => value.replace(/^varchar/, 'character varying').replace(/^timestamptz$/, 'timestamp with time zone').replaceAll(', ', ',');
// PostgreSQL quotes reserved identifiers such as "position" in index DDL.
const indexDefinition = value => value.replace(/"([a-z_][a-z0-9_]*)"/gi, '$1');
export function schemaProblems(snapshot, target) {
  const problems = [], contract = contracts(target);
  for (const [table, columns] of Object.entries(contract.tables)) {
    const actual = snapshot.columns.filter(c => c.table === table);
    if (!actual.length) { problems.push(`Thiếu bảng/view public.${table}`); continue; }
    for (const [column, type] of Object.entries(columns)) {
      const found = actual.find(c => c.column === column);
      if (!found) problems.push(`Thiếu cột ${table}.${column}`);
      else if (typeName(found.type) !== typeName(type)) problems.push(`Sai kiểu ${table}.${column}: cần ${type}, hiện có ${found.type}`);
    }
  }
  for (const [name, [table, unique, keys, predicate]] of Object.entries(contract.indexes)) {
    const index = snapshot.indexes.find(i => i.table === table && (name.startsWith('@') ? i.unique === unique && indexDefinition(i.definition).includes(keys) : i.name === name));
    if (!index) problems.push(`Thiếu index ${table}.${name}`);
    else if (!index.valid || !index.ready || index.unique !== unique || !indexDefinition(index.definition).includes(keys) ||
      (predicate ? !indexDefinition(index.definition).includes(predicate) : / WHERE /.test(index.definition))) problems.push(`Index không tương thích ${table}.${name}`);
  }
  return problems;
}
const snapshotSql = `SELECT json_build_object(
  'identity', (SELECT row_to_json(x) FROM (SELECT current_database() AS database, host(inet_server_addr()) AS host, inet_server_port() AS port, current_setting('port') AS configured_port, current_user AS role, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD') AS jst_day) x),
  'columns', COALESCE((SELECT json_agg(x) FROM (SELECT c.relname AS table,a.attname AS column,format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped) x),'[]'),
  'indexes', COALESCE((SELECT json_agg(x) FROM (SELECT tab.relname AS table,idx.relname AS name,i.indisunique AS unique,i.indisvalid AS valid,i.indisready AS ready,pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace n ON n.oid=tab.relnamespace WHERE n.nspname='public') x),'[]')) AS snapshot`;

function command(executable, args, input = '', timeout = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd:root, windowsHide:true, stdio:['pipe','pipe','pipe'] });
    let stdout = '', size = 0, done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); };
    const timer = setTimeout(() => { child.kill(); finish(new AuditError('SSH hết thời gian; kiểm tra kết nối và ssh-agent.')); }, timeout);
    child.stdout.on('data', data => { size += data.length; if (size > 2e6) { child.kill(); finish(new AuditError('Kết quả SSH vượt giới hạn.')); } else stdout += data; });
    // Never echo SSH/psql stderr: SQL or credentials must not leak into reports.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new AuditError('Không chạy được OpenSSH. Kiểm tra ssh.exe trong PATH.')));
    child.on('close', code => finish(code === 0 ? null : new AuditError('SSH/psql thất bại. Kiểm tra ssh-agent, known_hosts và sudo -n postgres; không đổi host key.')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function remoteQuery(sql) {
  const output = await command('ssh.exe', ['-T','-F','NUL','-p','22','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','PreferredAuthentications=publickey','-o','IdentityFile=none','-o','IdentitiesOnly=no','-o','ClearAllForwardings=yes','-o','ConnectTimeout=8','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',
    'ubuntu@217.142.225.255', "timeout 20s sudo -n -u postgres psql -X -w -qAt -v ON_ERROR_STOP=1 -d mita"],
  `BEGIN READ ONLY;\nSET LOCAL statement_timeout='10s';\nSET LOCAL lock_timeout='2s';\nSET LOCAL search_path=public,pg_catalog;\nSELECT COALESCE(json_agg(audit_row),'[]'::json) FROM (${sql}) audit_row;\nCOMMIT;\n`);
  try { return JSON.parse(output.trim()); } catch { throw new AuditError('Kết quả SSH/psql không phải JSON hợp lệ; chưa đủ bằng chứng DB.'); }
}
async function remoteCheckout(payload) {
  // Execute the public HTTPS request ON Hermes, passing the QA body over stdin.
  // Do not bypass Caddy by calling loopback Fastify directly.
  const output = await command('ssh.exe', ['-T','-F','NUL','-p','22','-o','BatchMode=yes',
    '-o','StrictHostKeyChecking=yes','-o','PreferredAuthentications=publickey',
    '-o','IdentityFile=none','-o','IdentitiesOnly=no','-o','ClearAllForwardings=yes',
    '-o','ConnectTimeout=8','-o','ConnectionAttempts=1',
    'ubuntu@217.142.225.255',
    `timeout 20s curl --silent --show-error --max-time 16 --request POST --header 'Content-Type: application/json' --data-binary @- --write-out '\\nAUDIT_HTTP_STATUS:%{http_code}' ${origin}/api/checkout`],
  JSON.stringify(payload));
  const match = output.match(/\nAUDIT_HTTP_STATUS:(\d{3})\s*$/);
  need(match, 'VPS HTTPS không trả mã HTTP cho checkout; không tự gửi lại.');
  const body = output.slice(0, match.index);
  if (Number(match[1]) !== 200) {
    let code = 'unknown';
    try { code = JSON.parse(body)?.code || 'unknown'; } catch { /* No unsafe raw response in terminal. */ }
    throw new AuditError(`Checkout qua Hermes đến DuckDNS gặp HTTP ${match[1]} (${safeName(code)}); giữ checkoutKey, không tự gửi lại.`);
  }
  try { return JSON.parse(body); } catch { throw new AuditError('VPS HTTPS checkout trả JSON không hợp lệ; không tự gửi lại.'); }
}
async function localSnapshot() {
  need(process.env.MITA_DAILY_AUDIT_LOCAL_OWNER === 'verified', 'PostgreSQL Mita (5433) đang tắt hoặc chưa xác minh được PID, đường dẫn postgres.exe và backend/.local-db.');
  const url = new URL(process.env.MITA_LOCAL_DATABASE_URL || 'postgresql://mita_local@127.0.0.1:5433/postgres');
  need(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '5433' && url.pathname === '/postgres' && !url.search && !url.hash,
    'Database local phải là 127.0.0.1:5433/postgres; không dùng tunnel 15432.');
  const require = createRequire(path.join(root,'backend','package.json'));
  const { Client } = require('pg');
  const client = new Client({ connectionString:url.href, connectionTimeoutMillis:4000, query_timeout:12000,
    options:'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000', application_name:'mita_daily_audit_readonly' });
  client.on('error', () => {});
  try {
    await client.connect();
    const snapshot = (await client.query(snapshotSql)).rows[0].snapshot;
    need(snapshot.identity.database === 'postgres' && snapshot.identity.role === decodeURIComponent(url.username) && snapshot.identity.port === 5433 && ['127.0.0.1','::1'].includes(snapshot.identity.host), 'Sai danh tính PostgreSQL local (tên database, user, địa chỉ hoặc cổng).');
    if (!schemaProblems(snapshot,'local').length) {
      snapshot.workers = (await client.query(`SELECT json_build_object(
        'settings',(SELECT row_to_json(s) FROM (SELECT engine,schedules FROM worker_control_settings WHERE id=1) s),
        'amazon',COALESCE((SELECT json_agg(s) FROM (SELECT id::text,started_at,finished_at,state,saved_count,error_count FROM sync_runs WHERE (started_at AT TIME ZONE 'Asia/Tokyo')::date=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')::date ORDER BY id DESC LIMIT 10) s),'[]'),
        'names',COALESCE((SELECT json_agg(s) FROM (SELECT id,state,finished_at,selected,translated,failed,warnings FROM codex_name_runs WHERE trigger='scheduled' AND jst_day=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo')::date) s),'[]')) AS evidence`)).rows[0].evidence;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError('Không đọc được PostgreSQL local 127.0.0.1:5433/postgres; kiểm tra kết nối, quyền và dịch vụ.');
  } finally { await client.end().catch(() => {}); }
}
async function http(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, redirect:'error', signal:AbortSignal.timeout(15000), headers:{ 'Cache-Control':'no-cache', ...options.headers } });
    need(response.ok, `HTTP ${response.status}; kiểm tra public HTTPS/Caddy/API.`);
    let text = '';
    if (response.body) {
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          need(bytes <= 2e6, 'Phản hồi HTTP quá lớn.');
          chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString('utf8');
      } finally { await reader.cancel().catch(() => {}); }
    }
    return { response, text };
  } catch (error) {
    if (/^HTTP /.test(error.message)) throw error;
    throw new AuditError('HTTP hết thời gian, mất kết nối hoặc phản hồi không chắc chắn. Không đổi checkoutKey và không tự gửi lại.');
  }
}
async function jsonGet(route) {
  const { text } = await http(origin + route);
  try { return JSON.parse(text); } catch { throw new AuditError('Public API trả JSON không hợp lệ.'); }
}
export function validateProduct(p, category) {
  need(p && /^[A-Z0-9]{10}$/.test(p.asin) && p.categorySlug === category && p.canCheckout === true, 'Sản phẩm không đúng danh mục hoặc không đủ điều kiện checkout.');
  need(typeof p.name === 'string' && p.name.trim().length >= 3 && !/[\x00-\x1f]/.test(p.name), 'Tên sản phẩm trống hoặc không hợp lệ.');
  need(Number.isSafeInteger(p.priceVnd) && p.priceVnd > 0, 'Giá VND phải là số nguyên dương.');
  const d = p.detail;
  need(d && ['features','ingredients','usage','cautions'].every(key => Array.isArray(d[key]) && d[key].every(s => typeof s === 'string')) &&
    d.specs && typeof d.specs === 'object' && !Array.isArray(d.specs) &&
    [...d.features,...d.ingredients,...d.usage,...d.cautions,...Object.values(d.specs)].some(s => typeof s === 'string' && s.trim()), 'Thiếu nội dung chi tiết sản phẩm.');
  const images = [...new Set([p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter(Boolean))];
  need(images.length > 0 && images.length <= 5 && images.every(image => /^https:\/\/(m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-fe\.ssl-images-amazon\.com)\//.test(image)), 'Thiếu ảnh hoặc địa chỉ nguồn ảnh không hợp lệ.');
  return images;
}
export function makeRecord(day, products) {
  const payload = { checkoutKey:checkoutKey(day), items:products.map(p => ({ asin:p.asin, quantity:1 })), customer:{
    name:`QA MITA DAILY AUDIT ${day} - KHONG GIAO HANG`, phone:'0000000000', address:`QA TEST ONLY ${day} - KHONG GIAO HANG - KHONG THU TIEN` } };
  return { version:1, day, phase:'prepared', products:products.map(p => ({ asin:p.asin, category:p.categorySlug, name:p.name, priceVnd:p.priceVnd })), payload, fingerprint:fingerprint(payload) };
}
export function validateRecord(record, day) {
  need(record?.version === 1 && record.day === day && ['prepared','attempted','verified'].includes(record.phase), 'File replay hỏng hoặc sai ngày; dừng checkout, không xóa file để thử lại.');
  need(Array.isArray(record.products) && record.products.length === 2 && record.products.every((p,i) => p.category === categories[i] && /^[A-Z0-9]{10}$/.test(p.asin) && Number.isSafeInteger(p.priceVnd) && p.priceVnd > 0) && record.products[0].asin !== record.products[1].asin, 'File replay sai sản phẩm.');
  const expected = makeRecord(day, record.products.map(p => ({ ...p, categorySlug:p.category })));
  need(JSON.stringify(record.payload) === JSON.stringify(expected.payload) && record.fingerprint === expected.fingerprint, 'Payload replay đã thay đổi; dừng checkout để tránh trùng đơn.');
  return record;
}
async function saveRecord(filename, record) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2), { encoding:'utf8', flag:'wx', flush:true });
  await rename(temporary, filename);
}
const orderSql = key => `SELECT o.id,o.status,o.payment_status,o.payment_method,o.payment_provider,o.payment_reference,o.paid_at,o.checkout_fingerprint,o.merchandise_vnd,
  (SELECT COALESCE(json_agg(json_build_object('asin',i.asin,'quantity',i.quantity,'unit_price_vnd',i.unit_price_vnd,'name',i.name,'quote_snapshot',i.quote_snapshot) ORDER BY i.asin),'[]') FROM order_items i WHERE i.order_id=o.id) AS lines
  FROM orders o WHERE o.checkout_key=${literal(key)}::uuid`;
export function verifyOrder(rows, record, response) {
  need(rows.length === 1, `DB có ${rows.length} đơn cho checkoutKey; cần đúng 1 đơn. Không gửi lại.`);
  const order = rows[0];
  need(order.status === 'pending_confirmation' && order.payment_status === 'unpaid' && order.payment_method === 'manual' && !order.payment_provider && !order.payment_reference && !order.paid_at, 'Trạng thái đơn hoặc thanh toán không đúng pending_confirmation/unpaid/manual.');
  need(order.checkout_fingerprint === record.fingerprint, 'DB fingerprint khác payload QA; dừng, không gửi lại.');
  need(Array.isArray(order.lines) && order.lines.length === 2 && record.products.every(p => {
    const matching = order.lines.filter(l => l.asin === p.asin && l.quantity === 1 && l.quote_snapshot === null && typeof l.name === 'string' && l.name.trim() && Number(l.unit_price_vnd) === p.priceVnd);
    return matching.length === 1;
  }), 'DB không đúng 2 ASIN, số lượng hoặc giá QA đã chọn. Không tự sửa đơn.');
  need(Number(order.merchandise_vnd) === record.products.reduce((sum,p) => sum+p.priceVnd,0), 'Tổng tiền DB khác 2 dòng QA.');
  if (response) need(response.orderId === order.id && ['pending_confirmation','already_submitted'].includes(response.status) && response.currency === 'VND' && response.paymentStatus === 'unpaid' && response.payableNowVnd === 0, 'HTTP checkout không khớp DB; không được báo thành công.');
  return order;
}

export async function checkout({ day, readOnly, record, products, query, post, save, now = () => new Date() }) {
  const existing = await query(orderSql(checkoutKey(day)));
  if (existing.length) {
    need(record, 'Đã có đơn với key hôm nay nhưng mất file payload replay. KHÔNG POST; cần đối chiếu thủ công.');
    const order = verifyOrder(existing, validateRecord(record, day));
    return { status:'already_submitted', order };
  }
  if (readOnly) return { status:'read_only' };
  need(products?.length === 2 && products.every((p,i) => p.categorySlug === categories[i]), 'Chặn POST: chưa đủ 2 sản phẩm đã kiểm tra.');
  if (!record) { record = makeRecord(day, products); await save(record); }
  validateRecord(record, day);
  need(products.every((p,i) => p.asin === record.products[i].asin && p.priceVnd === record.products[i].priceVnd), 'Giá hoặc ASIN replay đã thay đổi trước POST; giữ payload để rà soát.');
  need(record.phase === 'prepared', 'Lần gửi trước bất định hoặc DB chưa có đơn. KHÔNG gửi lại; giữ key và payload để điều tra.');
  need(jstDay(now()) === day, 'Đã qua ngày JST; đóng audit và chạy lại, không gửi payload cũ.');
  need(jstDay(new Date(now().getTime()+30000)) === day, 'Sắp qua ngày JST; dừng và chạy audit sau 00:00 JST.');
  record.phase = 'attempted';
  await save(record); // Must persist before the single public HTTPS POST.
  let response, postError;
  try { response = await post(record.payload); } catch (error) { postError = error; }
  // Always query independently, including after HTTP timeout/malformed response.
  const rows = await query(orderSql(record.payload.checkoutKey));
  const order = verifyOrder(rows, record, response);
  if (postError) throw new AuditError('DB đã có đơn QA nhưng HTTP checkout bất định. KHÔNG gửi lại; chạy audit lần sau chỉ để đối chiếu DB và key cũ.');
  need(response, 'Thiếu phản hồi HTTP checkout.');
  record.phase = 'verified'; await save(record);
  return { status:response.status, order };
}

// Tất cả dòng trạng thái được gói ở chiều rộng dễ đọc trên cửa sổ CMD.
function createReporter() {
  const results = [];
  const entries = [];
  let sectionName = 'Khác';
  const detailDefaults = {
    reason:'Chưa đủ bằng chứng để kết luận nguyên nhân cụ thể.',
    fix:'Đối chiếu trạng thái và nhật ký liên quan trước khi thực hiện thay đổi.'
  };
  const report = (status, title, { reason, fix, details = [] } = {}) => {
    results.push(status);
    entries.push({ status, title, reason:status === 'OK' ? null : reason ?? detailDefaults.reason,
      fix:status === 'OK' ? null : fix ?? detailDefaults.fix, details, section:sectionName });
  };
  const section = title => { sectionName = title; };
  const checked = async (fn, title, fix) => {
    try { return await fn(); }
    catch (error) {
      // Không in lỗi thô: exceptions hệ thống có thể chứa credential hoặc payload.
      report('FAIL', title, {
        reason: error instanceof AuditError ? error.message : 'Thiếu bằng chứng để xác nhận; kiểm tra kết nối, quyền và dữ liệu đầu vào.',
        fix: fix ?? 'Kiểm tra log liên quan, không tự chạy migration, job hoặc gửi lại đơn QA.'
      });
      return null;
    }
  };
  const count = status => results.filter(s => s === status).length;
  const exitCode = () => count('FAIL') ? 1 : count('WARN') ? 2 : 0;
  const render = ({heading='KẾT QUẢ KIỂM TRA',qaOutcome=null,readOnly=false}={}) => {
    const maxWidth=88;
    const width=90;
    const leftWidth=22;
    const stateWidth=6;
    const infoWidth=width-leftWidth-stateWidth-9;
    const plain = text => String(text).replace(/\s+/gu,' ').trim();
    const length = value => Array.from(value).length;
    const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ');
    const fit = (value,size) => {
      const chars=Array.from(plain(clean(value)));
      return chars.length>size ? chars.slice(0,size-1).join('')+'…' : chars.join('');
    };
    const pad = (value,size) => {
      const str=fit(value,size);
      return str+' '.repeat(Math.max(0,size-length(str)));
    };
    const wrap = (value,size) => {
      const words=plain(clean(value)).split(' ');
      const lines=[];
      let line='';
      for (const word of words) {
        const chunks=Array.from(word);
        while (chunks.length>size) {
          if (line) {lines.push(line);line='';}
          lines.push(chunks.splice(0,size).join(''));
        }
        const part=chunks.join('');
        if (!part) continue;
        if (line && length(line)+1+length(part)>size) {lines.push(line);line='';}
        line+=(line?' ':'')+part;
      }
      if (line) lines.push(line);
      return lines.length ? lines : [''];
    };
    const line = '-'.repeat(width);
    const statusColor = {OK:32,WARN:33,FAIL:31};
    const colored = state => process.stdout.isTTY
      ? `\x1b[${statusColor[state]}m${pad(state,stateWidth)}\x1b[0m` : pad(state,stateWidth);
    console.log('\n'+heading);
    console.log(line);
    console.log(`| ${pad('HẠNG MỤC',leftWidth)} | ${pad('KQ',stateWidth)} | ${pad('TÓM TẮT',infoWidth)} |`);
    console.log(line);
    const sectionGroups = [
      {heading:'01 / DATA PIPELINE',match:s=>/POSTGRESQL MITA LOCAL|KẾT QUẢ JOB/.test(s),
        include:e=>!(e.title==='Đồng bộ VPS theo Supervisor.' && entries.some(other=>other.title==='Đồng bộ danh mục VPS hôm nay.'))},
      {heading:'02 / VPS & WEBSITE',match:s=>/POSTGRESQL VPS|WEBSITE HTTPS|QA CHECKOUT/.test(s)}
    ];
    const summary = entry => {
      const d=entry.details.map(clean);
      const counts = [entry.reason,...d].filter(Boolean).join(' ').match(/(?:lỗi|cảnh báo|lệch|thiếu|lưu|dịch):?\s*\d+/gi);
      if (entry.status==='OK') {
        if (/Detail 05:15/.test(entry.title)) return 'Hoàn thành';
        if (/Schema/.test(entry.title)) return 'Schema và index đạt';
        if (/Đơn QA/.test(entry.title)) return 'Đã xác minh; không tạo lại';
        if (/Sản phẩm danh mục/.test(entry.title)) {
          const asin=d.find(item=>/^ASIN:/.test(item)) ?? '';
          const price=d.find(item=>/^Giá:/.test(item)) ?? '';
          return [asin,price].filter(Boolean).join(' | ') || 'Sản phẩm và ảnh hợp lệ';
        }
        return d.find(item=>/^Đã hoàn thành|^Chi tiết:|^Database:|^Máy chủ:/.test(item)) ?? 'Đạt yêu cầu';
      }
      if (entry.title==='Đồng bộ danh mục VPS hôm nay.' || entry.title==='Đồng bộ VPS theo Supervisor.') {
        const mismatch=entry.reason?.match(/(?:product_translations|[a-z_]+) \(thiếu \d+, lệch \d+\)/u);
        if (mismatch) return `Chưa COMMIT / ${mismatch[0]}`;
      }
      if (counts?.length) return counts.slice(0,4).join(' / ');
      return entry.reason ?? 'Chưa xác minh';
    };
    const tableName = title => title
      .replace(/^Kết nối PostgreSQL Mita.*$/u,'Local PostgreSQL')
      .replace(/^Schema local.*$/u,'Schema local')
      .replace(/^Amazon 04:00.*$/u,'Amazon 04:00')
      .replace(/^Names 05:00.*$/u,'Names 05:00')
      .replace(/^Detail 05:15.*$/u,'Detail 05:15')
      .replace(/^Đồng bộ VPS theo Supervisor.*$/u,'VPS Sync (Supervisor)')
      .replace(/^Bản ghi Amazon hôm nay.*$/u,'Amazon (DB run)')
      .replace(/^Bản ghi Names Codex.*$/u,'Names (DB run)')
      .replace(/^Kết nối PostgreSQL VPS.*$/u,'VPS PostgreSQL')
      .replace(/^Schema VPS.*$/u,'Schema VPS')
      .replace(/^Đồng bộ danh mục VPS.*$/u,'VPS Sync (Ledger)')
      .replace(/^Đối chiếu job (amazon|names|detail) trong ledger VPS.*$/u,(_,name)=>`Ledger ${name}`)
      .replace(/^Sản phẩm danh mục (.+) hợp lệ.*$/u,(_,name)=>`Web ${name}`)
      .replace(/^Đơn QA.*$/u,'QA Checkout');
    let rowNumber=0;
    for (const group of sectionGroups) {
      const groupEntries=entries.filter(entry=>group.match(entry.section) && (!group.include || group.include(entry)));
      if (!groupEntries.length) continue;
      console.log(group.heading);
      for (const entry of groupEntries) {
        rowNumber++;
        const info=summary(entry);
        const pieces=wrap(info,infoWidth);
        for (let n=0;n<pieces.length;n++) console.log(`| ${pad(n===0?tableName(entry.title):'',leftWidth)} | ${n===0?colored(entry.status):' '.repeat(stateWidth)} | ${pad(pieces[n],infoWidth)} |`);
      }
      console.log(line);
    }
    const remaining=entries.filter(entry=>!sectionGroups.some(group=>group.match(entry.section)));
    if (remaining.length) {
      console.log('03 / KHÁC');
      for (const entry of remaining) {
        rowNumber++;
        const pieces=wrap(summary(entry),infoWidth);
        for(let i=0;i<pieces.length;i++) console.log(`| ${pad(i? '':tableName(entry.title),leftWidth)} | ${i?' '.repeat(stateWidth):colored(entry.status)} | ${pad(pieces[i],infoWidth)} |`);
      }
      console.log(line);
    }
    const warnings=entries.filter(entry=>entry.status!=='OK');
    if (warnings.length) {
      console.log('\nCHI TIẾT CẦN XỬ LÝ');
      // The table counts all independent checks; diagnostic details can be
      // consolidated when Supervisor and VPS ledger describe the same sync run.
      const ledgerSync=warnings.find(entry=>entry.title==='Đồng bộ danh mục VPS hôm nay.');
      const displayed=new Set();
      for (const entry of warnings) {
        if (ledgerSync && entry.title==='Đồng bộ VPS theo Supervisor.' &&
            entry.reason?.includes('Đối chiếu dữ liệu trước COMMIT không đạt') &&
            ledgerSync.reason?.includes('Đối chiếu dữ liệu trước COMMIT không đạt')) continue;
        const key=`${entry.reason}|${entry.fix}`;
        if (displayed.has(key)) continue;
        displayed.add(key);
        const header=`[${entry.status}] ${tableName(entry.title)}`;
        console.log(header);
        for(const [label,value] of [['Lỗi',entry.reason],['Xử lý',entry.fix]]) {
          const prefix=`  ${label}: `;
          const lines=wrap(clean(value),maxWidth-length(prefix));
          lines.forEach((item,index)=>console.log((index?' '.repeat(length(prefix)):prefix)+item));
        }
      }
    }
    console.log('\nTỔNG KẾT: '+`${count('OK')} OK | ${count('WARN')} WARN | ${count('FAIL')} FAIL`);
    if (qaOutcome) {
      console.log('QA: '+qaOutcome);
    }
    console.log(count('FAIL')?'KẾT LUẬN: CÓ LỖI CẦN XỬ LÝ.':count('WARN')?'KẾT LUẬN: CÓ CẢNH BÁO.':'KẾT LUẬN: TẤT CẢ ĐỀU ĐẠT.');
    console.log('An toàn: Không chạy bù job/sync; không đổi checkoutKey hoặc replay QA.');
    if (readOnly) console.log('CHẾ ĐỘ CHỈ ĐỌC: không POST checkout.');
    return rowNumber;
  };
  return { report, section, checked, count, exitCode, render, entries };
}

async function checkLocal(day, view, readLocal = localSnapshot) {
  const { report, section, checked } = view;
  section('1. POSTGRESQL MITA LOCAL (5433) / SCHEMA');
  let localSchemaDrift = false, workerEvidence;
  await checked(async () => {
    const snapshot = await readLocal();
    workerEvidence = snapshot.workers;
    report('OK', 'Kết nối PostgreSQL Mita (5433) thành công.', {
      details: [`Database: ${snapshot.identity.host}:${snapshot.identity.port}/${snapshot.identity.database}`]
    });
    const errors = schemaProblems(snapshot, 'local');
    localSchemaDrift = errors.length > 0;
    for (const problem of errors) report('FAIL', 'Schema local không khớp code.', {
      reason: problem, fix:'Đối chiếu bảng/cột/index trong code và DB; chỉ migration sau khi được duyệt riêng.'
    });
    if (!localSchemaDrift) report('OK', 'Schema local và các index theo hợp đồng đã đạt.');
  }, 'PostgreSQL Mita (5433) chưa hoạt động hoặc chưa thể kiểm tra.', 'Kiểm tra PID, backend/.local-db và cổng 5433. Nếu cụm thực sự dừng, có tùy chọn khởi động sau audit.');
  return { localSchemaDrift, workerEvidence };
}

async function checkWorkers(day, view, workerEvidence, readDaily = readFile, readSyncEvidence = loadSyncEvidence) {
  const { report, section, checked } = view;
  section('2. KẾT QUẢ JOB HÔM NAY (JST)');
  let status, syncEvidence;
  await checked(async () => {
    let contents;
    try { contents = await readDaily(path.join(root, '.agents', 'runtime', `mita-daily-${day}.json`), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new AuditError(`Chưa có file kết quả 3 worker ngày ${day} JST từ Supervisor.`);
      throw error;
    }
    try { status = JSON.parse(contents); }
    catch { throw new AuditError(`File kết quả ${day} không phải JSON hợp lệ.`); }
    need(status?.day === day, 'File kết quả không thuộc ngày JST hiện tại.');
    syncEvidence = await readSyncEvidence(day, status.sync);
    for (const worker of ['amazon', 'names', 'detail']) {
      const job = status.jobs?.[worker];
      const complete = job?.day === day && job.state === 'completed';
      const clean = complete && [job.failed,job.warnings].every(value => value == null || safeCount(value) === 0);
      const label = { amazon:'Amazon 04:00', names:'Names 05:00', detail:'Detail 05:15' }[worker];
      const diagnosis = clean ? null : diagnoseJob(job, day);
      report(clean ? 'OK' : ['failed','unknown'].includes(job?.state) ? 'FAIL' : 'WARN',
        `${label}: ${clean ? 'đã hoàn thành' : 'chưa xác nhận hoàn thành'}.`, {
          details:[`Trạng thái Supervisor: ${safeState(job?.state)}`],
          ...(diagnosis ?? {})
        });
    }
    const syncState = safeState(status.sync?.state);
    const syncClean = syncState === 'completed';
    report(syncClean ? 'OK' : ['failed','unknown'].includes(syncState) ? 'FAIL' : 'WARN', 'Đồng bộ VPS theo Supervisor.', {
      ...(!syncClean ? {
        reason:syncEvidence?.reason ?? `Supervisor ghi nhận sync ${syncState}; chưa xác minh nguyên nhân chi tiết từ nhật ký.`,
        fix:syncEvidence?.fix ?? 'Kiểm tra ledger VPS và .agents/runtime/nightly-sync.err.log; không tự chạy lại sync.'
      } : {}),
      details:[`Trạng thái local: ${syncState}; mã thoát log: ${Number.isInteger(syncEvidence?.exitCode) ? syncEvidence.exitCode : 'chưa có'}.`]
    });
  }, 'Chưa xác minh được kết quả job trong ngày.', 'Kiểm tra file daily của Supervisor và nhật ký mita-supervisor.jsonl; không tự chạy bù job.');
  if (workerEvidence) {
    const amazonRun = workerEvidence.amazon?.find(row => row.id === String(status?.jobs?.amazon?.runId));
    const amazonClean = amazonRun?.state === 'success' && amazonRun.finished_at && amazonRun.error_count === 0;
    report(amazonClean ? 'OK' : 'WARN',
      'Bản ghi Amazon hôm nay trong PostgreSQL local.', {
        ...(!amazonClean ? { reason:amazonRun ? `Run Amazon ${safeState(amazonRun.state)}; lỗi: ${safeCount(amazonRun.error_count) ?? 'chưa có số liệu'}.` : 'Không tìm thấy run Amazon khớp ID với file Supervisor hôm nay.',
          fix:'Đối chiếu sync_runs theo runId và file log Amazon trong .agents/runtime; không chạy bù.' } : {}),
        details:[`Trạng thái: ${safeState(amazonRun?.state)}; lưu: ${safeCount(amazonRun?.saved_count) ?? '?'}; lỗi: ${safeCount(amazonRun?.error_count) ?? '?'}.`]
      });
    if (workerEvidence.settings?.engine === 'codex') {
      const runs = workerEvidence.names ?? [];
      const nameRun = runs.length === 1 ? runs[0] : null;
      const nameClean = nameRun?.state === 'completed' && nameRun.finished_at && nameRun.failed === 0 && nameRun.warnings === 0;
      report(nameClean ? 'OK' : 'WARN',
        'Bản ghi Names Codex theo lịch trong PostgreSQL local.', {
          ...(!nameClean ? { reason:nameRun ? `Run Names ${safeState(nameRun.state)}; lỗi: ${safeCount(nameRun.failed) ?? '?'}, cảnh báo: ${safeCount(nameRun.warnings) ?? '?'}.` : `Không có đúng một run Names scheduled hôm nay (đếm được ${runs.length}).`,
            fix:'Đối chiếu codex_name_runs theo ngày JST với file names.out.log và names.err.log; không chạy bù.' } : {}),
          details:[`Trạng thái: ${safeState(nameRun?.state)}; dịch: ${safeCount(nameRun?.translated) ?? '?'}; lỗi: ${safeCount(nameRun?.failed) ?? '?'}; cảnh báo: ${safeCount(nameRun?.warnings) ?? '?'}.`]
        });
    }
  } else {
    report('WARN', 'Chưa đọc được bản ghi worker từ PostgreSQL local.', {
      reason:'Snapshot PostgreSQL local chưa cung cấp bảng kết quả worker (DB chưa xác minh hoặc schema lệch).',
      fix:'Xác minh đúng PID/cổng 5433 và schema local; chạy lại phần local-recheck sau khi có quyền.',
      details:['Không suy diễn rằng job đã chạy chỉ từ trạng thái dịch vụ.']
    });
  }
  return { status, syncEvidence };
}

async function localRecheck({ readLocal = localSnapshot, readDaily = readFile } = {}) {
  const day = jstDay(), view = createReporter();
  console.log(`MITA JAPAN — KIỂM TRA LẠI RIÊNG DATABASE 5433 | ${day} JST`);
  const local = await checkLocal(day, view, readLocal);
  await checkWorkers(day, view, local.workerEvidence, readDaily);
  view.render({heading:`MITA JAPAN — KIỂM TRA LẠI 5433 | ${day} JST`,readOnly:true});
  console.log('Không kết nối VPS, HTTP, checkout hay worker; chỉ đọc dữ liệu local.');
  return view.exitCode();
}

async function run(readOnly) {
  const day = jstDay(), view = createReporter();
  const { report, section, checked } = view;
  let checkoutOutcome = 'CHƯA XÁC MINH';
  console.log(`MITA JAPAN — KIỂM TRA HẰNG NGÀY | ${day} JST`);
  console.log(readOnly ? 'CHẾ ĐỘ CHỈ ĐỌC: không POST, không tạo đơn.' : 'CHẾ ĐỘ QA THẬT: tối đa 1 đơn/ngày JST, 2 sản phẩm; KHÔNG giao hàng/thu tiền.');
  console.log('Mã thoát: 0=Đạt, 1=Lỗi, 2=Cảnh báo. Không tự khởi động DB, worker hoặc chạy migration.');
  await mkdir(runtime, { recursive:true });
  const { localSchemaDrift, workerEvidence } = await checkLocal(day, view);
  const workers = await checkWorkers(day, view, workerEvidence);
  section('3. POSTGRESQL VPS / SCHEMA / ĐỒNG BỘ');
  let remoteGood = false;
  await checked(async () => {
    const snapshot = (await remoteQuery(snapshotSql))[0].snapshot;
    need(snapshot.identity.database === 'mita' && snapshot.identity.role === 'postgres', 'Danh tính database VPS không đúng mita/postgres.');
    need(snapshot.identity.jst_day === day, 'Ngày JST trên Windows khác VPS; chặn checkout và kiểm tra đồng hồ hệ thống.');
    report('OK', 'Kết nối PostgreSQL VPS mita thành công.', {
      details:[`Máy chủ: ubuntu@217.142.225.255; DB: ${snapshot.identity.host ?? 'Unix socket'}:${snapshot.identity.port ?? snapshot.identity.configured_port}; chỉ đọc.`]
    });
    const errors = schemaProblems(snapshot,'vps');
    errors.forEach(e => report('FAIL', 'Schema VPS không khớp code.', {
      reason:e, fix:'Đối chiếu contract riêng cho VPS; không tự chạy migration.'
    }));
    remoteGood = errors.length === 0;
    if (remoteGood) report('OK', 'Schema VPS catalog, checkout, ledger và index đạt yêu cầu.');
  }, 'Không kiểm tra được PostgreSQL VPS.', 'Kiểm tra SSH, quyền đọc DB và kết nối Hermes; không thay đổi dịch vụ.');
  if (remoteGood) await checked(async () => {
    const rows = await remoteQuery(`SELECT state,jobs,note,committed_at,source_hash,remote_hash FROM catalog_sync_ledger WHERE sync_day=${literal(day)}::date`);
    need(rows.length === 1, 'VPS chưa có bản ghi đồng bộ (daily sync ledger) hôm nay.');
    const row = rows[0];
    const diagnosis = diagnoseLedger(row, day, workers.syncEvidence);
    report(diagnosis.status,
      'Đồng bộ danh mục VPS hôm nay.', {
        ...diagnosis,
        details:[`Trạng thái ledger: ${safeState(row.state)}; có dấu COMMIT/hash: ${diagnosis.committed}. Ledger không tự chứng minh dữ liệu đúng.`]
      });
    for (const name of ['amazon','names','detail']) {
      const job = row.jobs?.[name];
      const jobDiagnosis = diagnoseJob(job, day);
      const clean = !jobDiagnosis;
      report(clean ? 'OK' : ['failed','unknown'].includes(job?.state) ? 'FAIL' : 'WARN',
        `Đối chiếu job ${name} trong ledger VPS.`, {
          ...(!clean ? {reason:`Ledger VPS: ${jobDiagnosis.reason}`,fix:'Đối chiếu trạng thái worker trong mita-daily-' + day + '.json với ledger jobs; không tự đồng bộ lại.'} : {}),
          details:[`Trạng thái: ${safeState(job?.state)}; ngày: ${job?.day === day ? 'hôm nay' : 'khác/thiếu'}.`]
        });
    }
  }, 'Chưa xác nhận được đồng bộ VPS hôm nay.', 'Kiểm tra daily sync ledger và Supervisor; không tự đồng bộ hoặc chạy bù.');
  section('4. WEBSITE HTTPS — TRANG 1 MỖI DANH MỤC');
  const filename = path.join(runtime, `checkout-${day}.json`);
  let record, replayGood = true;
  await checked(async () => {
    try { record = validateRecord(JSON.parse(await readFile(filename,'utf8')), day); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        replayGood = false;
        if (error instanceof SyntaxError) throw new AuditError('File replay QA không phải JSON hợp lệ; phải dừng checkout.');
        throw error;
      }
    }
  }, 'Không xác minh được file replay QA.', 'Giữ nguyên file checkout hiện có để điều tra, không xóa hoặc thay key.');
  const products = [];
  for (const category of categories) await checked(async () => {
    const listing = await jsonGet(`/api/catalog?category=${category}&page=1&limit=12&sort=reviews`);
    need(Array.isArray(listing.items) && listing.page === 1 && listing.items.length <= 12, 'API catalog không trả đúng trang 1 (giới hạn 12 sản phẩm).');
    const eligible = listing.items.filter(p => p.canCheckout === true && p.categorySlug === category && /^[A-Z0-9]{10}$/.test(p.asin));
    need(eligible.length, `Trang 1 danh mục ${category} không có sản phẩm đủ điều kiện checkout.`);
    // Replays retain the original ASIN even if rankings changed since submission.
    const chosen = record?.products.find(p => p.category === category);
    const asin = chosen?.asin ?? eligible[randomInt(eligible.length)].asin;
    if (chosen && !eligible.some(p => p.asin === asin)) report('WARN', 'Mẫu QA cũ không còn ở trang 1; không tự đổi sản phẩm.', {
      reason:'ASIN trong replay không xuất hiện ở tập sản phẩm checkout được trên trang đầu hiện tại.',
      fix:'Giữ nguyên ASIN/replay và xác minh sản phẩm qua API chi tiết; không đổi mẫu đã ghi.',
      details:[`ASIN đã ghi trong replay: ${asin}`]
    });
    const product = await jsonGet(`/api/catalog/products/${asin}`);
    need(product.asin === asin, 'API chi tiết trả ASIN khác với danh sách.');
    const images = validateProduct(product, category);
    for (const image of images) {
      const { response } = await http(image, { method:'HEAD' });
      need(/^image\//i.test(response.headers.get('content-type') ?? ''), 'URL ảnh không trả về content-type hình ảnh.');
    }
    products.push(product);
    report('OK', `Sản phẩm danh mục ${category} hợp lệ.`, {
      details:[`Tên: ${safeName(product.name)}`, `ASIN: ${asin}`, `Giá: ${product.priceVnd.toLocaleString('vi-VN')} VND`, `Chi tiết: có dữ liệu; ảnh: ${images.length} ảnh đã kiểm tra HTTP.`]
    });
  }, `Không xác minh được sản phẩm danh mục ${category}.`, 'Kiểm tra catalog trang 1, API chi tiết, giá VND và đường dẫn ảnh HTTPS.');
  section('5. QA CHECKOUT / ĐỐI CHIẾU VPS DB ĐỘC LẬP');
  await checked(async () => {
    need(remoteGood && replayGood, 'Chặn checkout vì schema VPS hoặc file replay chưa được xác minh.');
    // Known schema drift fails closed. A powered-off local DB is reported FAIL,
    // but is not a dependency of the independently verified public VPS checkout.
    // Existing QA orders can still be verified without another write.
    if (!readOnly && localSchemaDrift) {
      const rows = await remoteQuery(orderSql(checkoutKey(day)));
      need(rows.length && record, 'Chặn POST vì schema local lệch; không có bằng chứng đơn QA đã được tạo.');
      verifyOrder(rows, record);
      checkoutOutcome = `ĐÃ CÓ ĐƠN QA, KHÔNG TẠO LẠI | ${rows[0].id}`;
      report('OK', 'Đơn QA hôm nay đã tồn tại, không POST thêm.', {
        details:['DB xác minh 1 đơn / 2 dòng; pending_confirmation / unpaid.']
      });
      return;
    }
    const result = await checkout({ day, readOnly, record, products, query:remoteQuery,
      save:value => saveRecord(filename,value), post:async payload => {
        const clock = await remoteQuery("SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD') AS day");
        need(clock[0]?.day === day, 'Ngày JST VPS đã thay đổi; KHÔNG POST payload ngày cũ.');
        return remoteCheckout(payload);
      } });
    checkoutOutcome = result.status === 'read_only' ? 'CHỈ ĐỌC — CHƯA TẠO ĐƠN' :
      `${result.status === 'already_submitted' ? 'ĐÃ CÓ ĐƠN QA, KHÔNG TẠO LẠI' : 'ĐẶT HÀNG QA THÀNH CÔNG'} | ${result.order.id}`;
    report(result.status === 'read_only' ? 'WARN' : 'OK',
      result.status === 'read_only' ? 'Chế độ chỉ đọc: chưa thử tạo đơn QA.' :
        result.status === 'already_submitted' ? 'Đơn QA đã có, không tạo lại.' : 'Đặt hàng QA thành công và đã xác minh DB.', {
        ...(result.status === 'read_only' ? {reason:'Đã chọn chế độ --read-only; checkout QA không được thực thi.',fix:'Chỉ dùng chế độ QA thông thường khi đã xác nhận an toàn; không chạy lại checkout với key mới.'} : {}),
        details: result.status === 'read_only' ? ['Không gọi POST checkout.'] :
          [`Mã đơn: ${result.order.id}`, 'Hai sản phẩm; pending_confirmation / unpaid / manual.']
      });
  }, 'Không xác minh được checkout QA.', 'Giữ nguyên checkoutKey và replay; kiểm tra DB VPS, tuyệt đối không gửi lại bằng key khác.');
  view.render({heading:`MITA JAPAN — DAILY AUDIT | ${day} JST`,qaOutcome:checkoutOutcome,readOnly});
  console.log('Lệch schema cần duyệt migration riêng. Payload QA không hiển thị dữ liệu khách hàng.');
  return view.exitCode();
}

async function selfTest() {
  const { default:assert } = await import('node:assert/strict');
  const day = '2026-11-08';
  const goodHash = 'a'.repeat(64);
  const ledgerRow = {state:'failed', note:'Transfer rolled back before COMMIT', source_hash:goodHash, remote_hash:null, committed_at:null};
  assert.match(diagnoseLedger(ledgerRow,day).reason, /ROLLBACK/);
  assert.match(diagnoseLedger(ledgerRow,day,{reason:'VERIFY: product_translations (thiếu 0, lệch 15)',fix:'Đối chiếu VERIFY.'}).reason,/lệch 15/);
  assert.match(diagnoseLedger({...ledgerRow,note:'private-password-value'},day).reason, /Chưa có nguyên nhân/);
  assert(!JSON.stringify(diagnoseLedger({...ledgerRow,note:'private-password-value'},day)).includes('private-password-value'));
  const partialLedger = diagnoseLedger({...ledgerRow,state:'partial',note:'Partial gallery preserved; verify identities',
    committed_at:'2026-11-08T00:00:00Z',remote_hash:goodHash},day);
  assert.equal(partialLedger.status,'WARN');
  assert.match(partialLedger.reason,/gallery/);
  const combined = diagnoseLedger({...ledgerRow,state:'partial',note:'Partial galleries preserved: 4; Deferred stale Codex titles: 2 (source_changed)',
    committed_at:'2026-11-08T00:00:00Z',remote_hash:goodHash},day);
  assert.match(combined.reason,/4 gallery/);
  assert.match(combined.reason,/2 tiêu đề/);
  assert.match(diagnoseLedger({...ledgerRow,state:'completed'},day).reason,/thiếu dấu COMMIT/);
  assert.equal(diagnoseLedger({...ledgerRow,state:'completed',committed_at:'2026-11-08',remote_hash:goodHash},day).status,'OK');
  assert.match(diagnoseJob({day,state:'partial',failed:6,warnings:77},day).reason,/lỗi: 6, cảnh báo: 77/);
  assert.match(diagnoseJob({day,state:'failed',reason:'secret-token'},day).reason,/failed/);
  assert.match(diagnoseJob({day,state:'completed',warnings:'secret'},day).reason,/không hợp lệ/);
  assert(!JSON.stringify(diagnoseJob({day,state:'failed',reason:'secret-token'},day)).includes('secret-token'));
  assert.match(diagnoseJob({day:'2026-11-07',state:'completed'},day).reason,/không có bằng chứng/);
  assert.match(diagnoseJob(null,day).reason,/chưa ghi nhận/);
  assert.equal(diagnoseJob({day,state:'completed',failed:0,warnings:0},day),null);
  assert.match(diagnoseSyncError('VPS transfer schema incompatible: product_translations (42703)').reason,/thiếu cột/);
  assert.equal(diagnoseSyncError('password=secret; customer_data'),null);
  const verify = [{table:'product_translations',missing:0,contentMismatch:15,sample:'secret customer info'}];
  assert.match(diagnoseSyncError('Data verification failed before commit',verify).reason,/product_translations \(thiếu 0, lệch 15\)/);
  assert(!JSON.stringify(diagnoseSyncError('Data verification failed before commit',verify)).includes('secret customer info'));
  const sync = {state:'failed',at:'2026-11-08T01:05:00.100Z'};
  const journal = {text:[
    {event:'sync_started',day,at:'2026-11-08T01:00:00Z'},
    {event:'sync_finished',day,at:'2026-11-08T01:05:00Z',exitCode:1}
  ].map(JSON.stringify).join('\n')};
  const stderr = {text:'SYNC_FAILED Data verification failed before commit\nDaily sync failed; inspect remote ledger and private logs\n',mtimeMs:Date.parse('2026-11-08T01:05:00Z')};
  const stdout = {text:'VERIFY '+JSON.stringify(verify)+'\n',mtimeMs:stderr.mtimeMs};
  const evidence = syncEvidenceFromLogs(day,sync,journal,stderr,stdout);
  assert.equal(evidence.exitCode,1);
  assert.match(evidence.reason,/product_translations.*lệch 15/);
  assert(!JSON.stringify(evidence).includes('secret customer info'));
  assert.equal(syncEvidenceFromLogs(day,sync,journal,{...stderr,mtimeMs:Date.parse('2026-11-07T01:05:00Z')},stdout).reason,undefined);
  assert.equal(syncEvidenceFromLogs(day,{...sync,at:'2026-11-08T03:05:00Z'},journal,stderr,stdout),null);
  assert.match(syncEvidenceFromLogs(day,sync,journal,
    {text:'SYNC_ROLLBACK_UNCONFIRMED: running ledger preserved; manual inspection required\n'+stderr.text,mtimeMs:stderr.mtimeMs},stdout).reason,/ROLLBACK chưa được xác nhận/);
  assert.equal(syncEvidenceFromLogs(day,sync,journal,{text:'SYNC_FAILED password=secret customer=private',mtimeMs:stderr.mtimeMs},stdout).reason,undefined);
  assert.equal(syncEvidenceFromLogs(day,sync,journal,null,null).reason,undefined); // Missing private logs cannot invent a cause.
  assert.match(syncEvidenceFromLogs(day,sync,journal,{text:stderr.text+'C:\\audit\\nightly-vps-sync.ps1:61\n    + stack detail\n \n',mtimeMs:stderr.mtimeMs},stdout).reason,/lệch 15/);
  assert.equal(syncEvidenceFromLogs(day,sync,journal,{text:stderr.text+'Unexpected unrelated failure',mtimeMs:stderr.mtimeMs},stdout).reason,undefined);
  const priorMarker = 'SYNC_ATTEMPT_START 2026-11-07T01:00:00.000Z\n';
  const currentMarker = 'SYNC_ATTEMPT_START 2026-11-08T01:00:00.000Z\n';
  const markerError = {text:priorMarker+stderr.text+currentMarker+stderr.text,mtimeMs:stderr.mtimeMs};
  const markerOut = {text:priorMarker+stdout.text+currentMarker+stdout.text,mtimeMs:stderr.mtimeMs};
  assert.match(syncEvidenceFromLogs(day,sync,journal,markerError,markerOut).reason,/lệch 15/);
  assert.equal(syncEvidenceFromLogs(day,sync,journal,{...markerError,text:priorMarker+stderr.text+currentMarker},markerOut).reason,undefined);
  assert.equal(syncEvidenceFromLogs(day,sync,journal,{...markerError,text:priorMarker+stderr.text},{...markerOut,text:priorMarker+stdout.text}).reason,undefined);
  const committedPartial = {text:currentMarker+'SYNC_COMMIT_OK '+JSON.stringify({day,runId:'12345678-1234-4234-8234-123456789abc',
    state:'partial',galleryPartial:4,deferredTranslations:2,customer:'do not print'})+'\n',mtimeMs:stderr.mtimeMs};
  const partialSync = syncEvidenceFromLogs(day,{...sync,state:'partial'},journal,{text:currentMarker,mtimeMs:stderr.mtimeMs},committedPartial);
  assert.match(partialSync.reason,/4 gallery/);
  assert.match(partialSync.reason,/2 bản dịch/);
  assert(!JSON.stringify(partialSync).includes('do not print'));
  const captured = [], savedLog = console.log;
  try {
    console.log = (...args) => captured.push(args.join(' '));
    await createReporter().checked(async () => { throw Error('password=secret customer=private'); },
      'Truy vấn ngoài sync không thành công.', 'Xem log nội bộ.');
  } finally { console.log = savedLog; }
  const layout = createReporter();
  layout.section('1. POSTGRESQL MITA LOCAL (5433) / SCHEMA');
  layout.report('OK','Schema local và các index theo hợp đồng đã đạt.');
  layout.section('2. KẾT QUẢ JOB HÔM NAY (JST)');
  layout.report('WARN','Amazon 04:00: chưa xác nhận hoàn thành.',{
    reason:'Run Amazon partial; lỗi: 10.',fix:'Đối chiếu nhật ký Amazon.'});
  layout.report('WARN','Names 05:00: chưa xác nhận hoàn thành.',{
    reason:'Job partial; lỗi: 6, cảnh báo: 77.',fix:'Đối chiếu nhật ký Names.'});
  layout.report('OK','Detail 05:15: đã hoàn thành.');
  layout.report('FAIL','Đồng bộ VPS theo Supervisor.',{
    reason:'Nhật ký: Đối chiếu dữ liệu trước COMMIT không đạt. product_translations lệch 15.',fix:'Xem VERIFY.'});
  layout.section('3. POSTGRESQL VPS / SCHEMA / ĐỒNG BỘ');
  layout.report('FAIL','Đồng bộ danh mục VPS hôm nay.',{
    reason:'Ledger rollback. Đối chiếu dữ liệu trước COMMIT không đạt. product_translations lệch 15.',fix:'Xem VERIFY.'});
  layout.section('4. WEBSITE HTTPS — TRANG 1 MỖI DANH MỤC');
  layout.report('OK','Sản phẩm danh mục thuc-pham-cho-be hợp lệ.',{
    details:['ASIN: B00JWK5ILK','Giá: 660000 VND']});
  layout.section('5. QA CHECKOUT / ĐỐI CHIẾU VPS DB ĐỘC LẬP');
  layout.report('OK','Đơn QA đã có, không tạo lại.',{details:['Mã đơn: sample-fixture']});
  const rendered=[], restored=console.log;
  try { console.log=(...args)=>rendered.push(args.join(' '));
    assert.equal(layout.render({heading:'KIỂM TRA BẢNG'}),7);
  } finally { console.log=restored; }
  assert(rendered.some(line=>line.includes('01 / DATA PIPELINE')));
  assert(rendered.some(line=>line.includes('02 / VPS & WEBSITE')));
  assert(rendered.some(line=>line.includes('VPS Sync (Ledger)')));
  assert(rendered.some(line=>line.includes('product_translations')));
  assert(rendered.join(' ').includes('lệch 15'));
  assert(rendered.some(line=>line.includes('Xử lý: Xem VERIFY.')));
  assert(rendered.some(line=>line.includes('3 OK | 2 WARN | 2 FAIL'))===false);
  assert(rendered.some(line=>line.includes('4 OK | 2 WARN | 2 FAIL')));
  assert.equal(rendered.filter(line=>line.includes('[FAIL] VPS Sync (Supervisor)')).length,0,
    'không lặp nguyên nhân sync khi đã có ledger');
  assert(rendered.every(line=>Array.from(line.replace(/\x1b\[[0-9;]*m/g,'')).length<=92));
  assert(!captured.join('\n').includes('password=secret'));
  const product = (asin,categorySlug) => ({ asin, categorySlug, name:'San pham QA', priceVnd:120000, canCheckout:true,
    imageUrl:'https://m.media-amazon.com/images/I/test.jpg', detail:{ features:['Chi tiet'], ingredients:[], usage:[], cautions:[], specs:{} } });
  const products = [product('B000000001',categories[0]),product('B000000002',categories[1])];
  assert.equal(jstDay(new Date('2026-11-07T15:00:00Z')),day);
  assert.equal(jstDay(new Date('2026-11-07T14:59:59Z')),'2026-11-07');
  assert.equal(checkoutKey(day),checkoutKey(day));
  // Pin the namespace: deleting runtime files must never change today's key.
  assert.equal(checkoutKey(day), '7e53a4b1-23f6-57e9-9576-16945bf80055');
  assert.notEqual(checkoutKey(day),checkoutKey('2026-11-09'));
  const record = makeRecord(day,products);
  validateRecord(record,day); products.forEach((p,i) => validateProduct(p,categories[i]));
  assert.throws(() => validateProduct({...products[0],priceVnd:0},categories[0]));
  assert.throws(() => validateProduct({...products[0],detail:null},categories[0]));
  assert.throws(() => validateRecord({...record,payload:{...record.payload,checkoutKey:checkoutKey('2026-11-09')}},day));
  for (const target of ['local','vps']) {
    const contract = contracts(target);
    const snapshot = { columns:Object.entries(contract.tables).flatMap(([table,columns]) => Object.entries(columns).map(([column,type]) => ({table,column,type:typeName(type)}))),
      indexes:Object.entries(contract.indexes).map(([name,[table,unique,keys,predicate]]) => ({name,table,unique,valid:true,ready:true,definition:`CREATE INDEX ${keys}${predicate ? ' '+predicate : ''}`})) };
    assert.deepEqual(schemaProblems(snapshot,target),[]);
    snapshot.indexes.find(i => i.name === 'product_images_pkey').definition = 'CREATE UNIQUE INDEX product_images_pkey ON public.product_images USING btree (asin, "position")';
    assert.deepEqual(schemaProblems(snapshot,target),[]); // PostgreSQL quotes the reserved identifier.
    snapshot.columns = snapshot.columns.filter(c => !(c.table==='orders' && c.column==='checkout_key'));
    snapshot.indexes.find(i => i.name==='orders_checkout_key_idx').valid = false;
    assert(schemaProblems(snapshot,target).some(p => p.includes('orders.checkout_key')));
    assert(schemaProblems(snapshot,target).some(p => p.includes('orders_checkout_key_idx')));
  }
  const order = { id:'test-order', status:'pending_confirmation', payment_status:'unpaid', payment_method:'manual', checkout_fingerprint:record.fingerprint, merchandise_vnd:240000,
    lines:products.map(p => ({asin:p.asin,quantity:1,unit_price_vnd:p.priceVnd,name:p.name,quote_snapshot:null})) };
  verifyOrder([order],record);
  assert.throws(() => verifyOrder([],record));
  assert.throws(() => verifyOrder([order,order],record));
  assert.throws(() => verifyOrder([{...order,lines:[order.lines[0],order.lines[0]]}],record));
  assert.throws(() => verifyOrder([{...order,payment_status:'paid'}],record));
  const response = { orderId:order.id,status:'pending_confirmation',currency:'VND',paymentStatus:'unpaid',payableNowVnd:0 };
  let posts=0, stored, queries=0;
  const dependencies = { day,products,readOnly:false,record:null,now:()=>new Date('2026-11-08T01:00:00Z'),
    save:async r => { stored=structuredClone(r); }, query:async () => ++queries===1?[]:[order], post:async () => { assert.equal(stored.phase,'attempted'); posts++; return response; } };
  assert.equal((await checkout(dependencies)).status,'pending_confirmation'); assert.equal(posts,1); assert.equal(stored.phase,'verified');
  assert.equal((await checkout({...dependencies,record:stored,query:async()=>[order],post:async()=>assert.fail('Replay POST')})).status,'already_submitted');
  await assert.rejects(checkout({...dependencies,record:{...record,phase:'attempted'},query:async()=>[],post:async()=>assert.fail('Uncertain resend')}));
  await assert.rejects(checkout({...dependencies,query:async()=>[order],post:async()=>assert.fail('Missing file resend')}));
  assert.equal((await checkout({...dependencies,readOnly:true,query:async()=>[],post:async()=>assert.fail('Read-only POST')})).status,'read_only');
  queries=0;
  await assert.rejects(checkout({...dependencies,post:async()=>{posts++;throw Error('timeout');}}),/bất định/);
  assert.equal(queries,2); // Independent DB verification still ran after timeout.
  queries=0;
  await assert.rejects(checkout({...dependencies,save:async()=>{throw Error('disk');},post:async()=>assert.fail('Unsaved POST')}),/disk/);
  await assert.rejects(checkout({...dependencies,query:async()=>[],now:()=>new Date('2026-11-08T15:00:00Z'),post:async()=>assert.fail('JST rollover POST')}),/qua ngày/);
  await assert.rejects(checkout({...dependencies,record,query:async()=>[],products:[{...products[0],priceVnd:1},products[1]],post:async()=>assert.fail('Changed price POST')}),/thay đổi/);
  queries=0;
  await assert.rejects(checkout({...dependencies,post:async()=>({...response,orderId:'wrong-id'})}),/khớp DB/);
  assert.equal((await checkout({...dependencies,record,products:[],query:async()=>[order],post:async()=>assert.fail('Catalog change replay POST')})).status,'already_submitted');
  // Kiểm tra lại 5433 chỉ nhận dữ liệu local giả lập, không có dependency SSH/HTTP/checkout.
  const localContract = contracts('local');
  const localFixture = {
    identity:{ host:'127.0.0.1', port:5433, database:'postgres' },
    columns:Object.entries(localContract.tables).flatMap(([table, columns]) =>
      Object.entries(columns).map(([column, type]) => ({ table, column, type:typeName(type) }))),
    indexes:Object.entries(localContract.indexes).map(([name, [table, unique, keys, predicate]]) =>
      ({ name, table, unique, valid:true, ready:true, definition:`CREATE INDEX ${keys}${predicate ? ' '+predicate : ''}` })),
    workers:{ settings:{ engine:'codex' }, amazon:[], names:[] }
  };
  const today = jstDay();
  const statusFixture = JSON.stringify({ day:today, jobs:Object.fromEntries(
    ['amazon', 'names', 'detail'].map(name => [name, {day:today, state:'pending'}])),
    sync:{ state:'pending' } });
  const output = [], originalLog = console.log;
  try {
    console.log = (...parts) => output.push(parts.join(' '));
    assert.equal(await localRecheck({
      readLocal:async () => structuredClone(localFixture),
      readDaily:async () => statusFixture
    }), 2); // Thiếu bằng chứng job => WARN, dù DB schema hợp lệ.
    const noFile = new Error('Không có file'); noFile.code = 'ENOENT';
    assert.equal(await localRecheck({
      readLocal:async () => structuredClone(localFixture),
      readDaily:async () => { throw noFile; }
    }), 1); // Job chưa chạy => FAIL, không biến thành OK sau khi DB khởi động.
    assert(output.some(line => line.includes('KIỂM TRA LẠI 5433')));
    assert(output.some(line => line.includes('Chưa có file kết quả 3 worker')));
    assert(output.every(line => Array.from(line.replace(/\x1b\[[0-9;]*m/g,'')).length <= 100));
  } finally { console.log = originalLog; }
  console.log('[OK] Tự kiểm thử fixture: JST/key, schema/index, sản phẩm, replay, một POST giả lập, timeout/đối chiếu DB, lỗi lưu đĩa.');
  console.log('       Chẩn đoán ledger/job/sync: xác minh VERIFY số lượng, rollback, schema, log stale và không rò thông tin riêng tư.');
  console.log('       Đã thử chế độ kiểm tra lại 5433 với fixture và job thiếu; không gọi HTTP, SSH, DB thật hoặc khởi động dịch vụ.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    need(args.length <= 1 && args.every(a => ['--self-test','--read-only','--local-recheck'].includes(a)), 'Chỉ hỗ trợ --self-test, --read-only hoặc --local-recheck.');
    need(Number(process.versions.node.split('.')[0]) >= 22, 'Cần Node.js 22 trở lên.');
    if (args[0] === '--self-test') await selfTest();
    else {
      need(process.env.MITA_DAILY_AUDIT_MUTEX === 'held', 'Hãy chạy qua mita-audit.bat hoặc PowerShell wrapper để giữ mutex.');
      if (args[0] === '--local-recheck') {
        need(process.env.MITA_DAILY_AUDIT_LOCAL_OWNER === 'verified', 'Chưa xác minh PostgreSQL Mita (5433) đúng PID/đường dẫn.');
        process.exitCode = await localRecheck();
      } else process.exitCode = await run(args[0] === '--read-only');
    }
  } catch (error) {
    if (args[0] === '--self-test') console.error(error);
    else {
      console.error('[FAIL] Chương trình audit không thể hoàn tất.');
      console.error('       Nguyên nhân: tham số, mutex, Node.js 22 hoặc quyền xác minh database chưa đạt.');
      console.error('       Cách xử lý: dùng mita-audit.bat; kiểm tra Node.js và quyền chạy.');
      console.error('       Không tạo checkoutKey khác hoặc tự gửi lại đơn QA.');
    }
    process.exitCode = 1;
  }
}
