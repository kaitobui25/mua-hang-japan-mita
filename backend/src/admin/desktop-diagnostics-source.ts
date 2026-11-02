import { execFile } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { MAX_PRODUCTS, parseEvidence, type Evidence } from './desktop-diagnostics-model.js';

export const MAX_BYTES = 32 * 1024 * 1024;
// Fixed, reviewed statements only. Neither HTTP input nor environment can supply SQL.
export const snapshotSql = `WITH image_rows AS (
  SELECT asin,jsonb_agg(jsonb_build_object('url',source_url,'observedAt',source_observed_at) ORDER BY position) images
  FROM product_images GROUP BY asin
), product_rows AS (
  SELECT p.asin,p.name AS "originalName",p.brand,p.image_url AS "coverUrl",
    CASE WHEN t.status IN ('success','warning') THEN t.name END AS "fullVietnameseName",
    CASE WHEN t.status IN ('success','warning') AND pt.source_name=p.name AND pt.translated_name=t.name
      THEN pt.short_name END AS "shortVietnameseName",
    pt.omitted_facts AS "omittedFacts",
    coalesce(i.images,'[]'::jsonb) images,p.source_adapter AS "sourceAdapter",
    p.last_seen_at AS "sourceObservedAt",p.updated_at AS "updatedAt",
    to_jsonb(p)->>'admin_hidden_at' AS "hiddenAt",
    t.translated_at AS "translatedAt",pt.updated_at AS "shortTitleUpdatedAt",
    t.status AS "translationStatus",t.name_only AS "nameOnly"
  FROM products p LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
  LEFT JOIN product_title_presentations pt ON pt.asin=p.asin
  LEFT JOIN image_rows i ON i.asin=p.asin
  ORDER BY p.asin LIMIT ${MAX_PRODUCTS + 1}
), tables AS (
  SELECT c.relname AS name,
    (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT count(*)::int FROM pg_index i WHERE i.indrelid=c.oid) AS indexes
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
)
SELECT jsonb_build_object('capturedAt',transaction_timestamp(),'database',current_database(),
  'serverAddress',inet_server_addr(),'serverPort',inet_server_port(),
  'tables',coalesce((SELECT jsonb_agg(t ORDER BY name) FROM tables t),'[]'::jsonb),
  'products',coalesce((SELECT jsonb_agg(p ORDER BY asin) FROM product_rows p),'[]'::jsonb),
  'catalog',jsonb_build_object('products',(SELECT count(*) FROM products),
    'translations',(SELECT count(*) FROM product_translations WHERE locale='vi'),
    'images',(SELECT count(*) FROM product_images),'details',(SELECT count(*) FROM product_details))) AS evidence`;

// Older VPS snapshots may not have the optional title-presentation table.
// Keep catalog and schema inspection available without treating missing short
// title support as an empty product catalog.
export const snapshotSqlWithoutTitles = snapshotSql
  .replace(`CASE WHEN t.status IN ('success','warning') AND pt.source_name=p.name AND pt.translated_name=t.name
      THEN pt.short_name END`, 'NULL::text')
  .replace('pt.omitted_facts AS "omittedFacts"', 'NULL::jsonb AS "omittedFacts"')
  .replace('pt.updated_at AS "shortTitleUpdatedAt"', 'NULL::timestamptz AS "shortTitleUpdatedAt"')
  .replace('LEFT JOIN product_title_presentations pt ON pt.asin=p.asin', '');

const logQueries = [
  { id: 'catalog_issues', table: 'sync_errors', columns: ['id','created_at'], sql: `SELECT coalesce(jsonb_agg(e ORDER BY e.timestamp DESC),'[]'::jsonb) AS events FROM
  (SELECT created_at AS timestamp,'catalog_issue' AS code FROM sync_errors
   WHERE created_at>=transaction_timestamp()-interval '7 days' AND created_at<=transaction_timestamp()
   ORDER BY created_at DESC,id DESC LIMIT 1001) e` },
  { id: 'catalog_runs', table: 'sync_runs', columns: ['id','started_at','finished_at','state'], sql: `SELECT coalesce(jsonb_agg(e ORDER BY e.timestamp DESC),'[]'::jsonb) AS events FROM
    (SELECT coalesce(finished_at,started_at) AS timestamp,
      CASE state WHEN 'running' THEN 'catalog_running' WHEN 'success' THEN 'catalog_success'
        WHEN 'failed' THEN 'catalog_failed' ELSE 'catalog_status' END AS code FROM sync_runs
      WHERE coalesce(finished_at,started_at) BETWEEN transaction_timestamp()-interval '7 days' AND transaction_timestamp()
      ORDER BY coalesce(finished_at,started_at) DESC,id DESC LIMIT 1001) e` },
  { id: 'translation_runs', table: 'codex_name_runs', columns: ['id','started_at','finished_at','state'], sql: `SELECT coalesce(jsonb_agg(e ORDER BY e.timestamp DESC),'[]'::jsonb) AS events FROM
    (SELECT coalesce(finished_at,started_at) AS timestamp,
      CASE state WHEN 'running' THEN 'translation_running' WHEN 'completed' THEN 'translation_completed'
        WHEN 'failed' THEN 'translation_failed' ELSE 'translation_status' END AS code FROM codex_name_runs
      WHERE coalesce(finished_at,started_at) BETWEEN transaction_timestamp()-interval '7 days' AND transaction_timestamp()
      ORDER BY coalesce(finished_at,started_at) DESC,id DESC LIMIT 1001) e` },
  { id: 'vps_sync_ledger', table: 'catalog_sync_ledger', columns: ['sync_day','started_at','committed_at','state'], sql: `SELECT coalesce(jsonb_agg(e ORDER BY e.timestamp DESC),'[]'::jsonb) AS events FROM
    (SELECT coalesce(committed_at,started_at) AS timestamp,
      CASE state WHEN 'running' THEN 'vps_sync_running' WHEN 'completed' THEN 'vps_sync_completed'
        WHEN 'partial' THEN 'vps_sync_partial' ELSE 'vps_sync_failed' END AS code FROM catalog_sync_ledger
      WHERE coalesce(committed_at,started_at) BETWEEN transaction_timestamp()-interval '7 days' AND transaction_timestamp()
      ORDER BY coalesce(committed_at,started_at) DESC,sync_day DESC LIMIT 1001) e` }
] as const;
const titleColumns = ['asin','source_name','translated_name','short_name','omitted_facts','updated_at'];
const supportsColumns = (table: string, columns: readonly string[]) =>
  `SELECT count(*)=${columns.length} AS available FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name IN (${columns.map(column => `'${column}'`).join(',')})`;
const beginSql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='12s'; SET LOCAL search_path=public,pg_catalog;";

function combine(value: unknown, groups: unknown[], source: 'pc' | 'vps') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_evidence');
  if (groups.length !== logQueries.length || groups.some(group => group !== null && !Array.isArray(group))) throw new Error('invalid_events');
  const sources = groups.map((group, index) => ({ id: logQueries[index].id,
    status: group === null ? 'missing' : 'available', truncated: Array.isArray(group) && group.length > 1000 }));
  const allEvents = groups.flatMap(group => Array.isArray(group) ? group.slice(0, 1000) : []);
  allEvents.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return parseEvidence({ ...value, logs: { status: sources.some(row => row.status === 'available') ? 'available' : 'missing',
    sources, truncated: sources.some(row => row.truncated) || allEvents.length > 3000,
    events: allEvents.slice(0, 3000) } }, source);
}

export function isPcDatabase(url: string) {
  try {
    const target = new URL(url);
    return ['postgres:', 'postgresql:'].includes(target.protocol) &&
      target.hostname === '127.0.0.1' && target.port === '5433' && !target.search && !target.hash;
  } catch { return false; }
}

export async function readPcEvidence(): Promise<Evidence> {
  // A worker configured for the VPS tunnel must never be labelled PC.
  if (!isPcDatabase(config.databaseUrl)) throw new Error('pc_target_not_local');
  const client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 4000,
    query_timeout: 10000, application_name: 'mita_desktop_readonly' });
  // Bound the entire multi-query refresh, including optional event streams.
  const deadline = setTimeout(() => { void client.end().catch(() => {}); }, 15000);
  client.on('error', () => { /* Failures are represented by source status only. */ });
  try {
    await client.connect();
    await client.query(beginSql);
    const hasTitles = await client.query(supportsColumns('product_title_presentations', titleColumns));
    const result = await client.query(hasTitles.rows[0].available ? snapshotSql : snapshotSqlWithoutTitles);
    if (Buffer.byteLength(JSON.stringify(result.rows[0].evidence)) > MAX_BYTES) throw new Error('evidence_limit');
    const groups: unknown[] = [];
    for (const query of logQueries) {
      const exists = await client.query(supportsColumns(query.table, query.columns));
      if (!exists.rows[0].available) { groups.push(null); continue; }
      // Optional historical tables may predate event columns. Keep the source
      // catalog readable, marking just the unsupported event stream missing.
      await client.query('SAVEPOINT optional_log');
      try {
        groups.push((await client.query(query.sql)).rows[0].events);
        await client.query('RELEASE SAVEPOINT optional_log');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT optional_log');
        await client.query('RELEASE SAVEPOINT optional_log');
        groups.push(null);
      }
    }
    const evidence = combine(result.rows[0].evidence, groups, 'pc');
    await client.query('ROLLBACK');
    return evidence;
  } finally { clearTimeout(deadline); await client.end(); }
}

/** Windows-only on-demand transport uses the existing approved sync host/key.
 * No tunnels, SSH config aliases, remote paths, URLs, or user-supplied arguments.
 * The existing order relay cannot serve catalog/schema evidence.
 */
export function sshInvocation(platform = process.platform, environment: NodeJS.ProcessEnv = process.env) {
  // Only a user-initiated diagnostics refresh invokes SSH, never a timer/job.
  // Explicit 0 disables remote inspection for restricted operator setups.
  if (platform !== 'win32' || environment.MITA_DESKTOP_DIAGNOSTICS_SSH === '0') return null;
  const profile = environment.USERPROFILE;
  const windows = environment.SystemRoot;
  if (!profile || !windows) throw new Error('ssh_environment_missing');
  return { executable: join(windows, 'System32', 'OpenSSH', 'ssh.exe'), args: [
    '-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'ClearAllForwardings=yes', '-o', 'RequestTTY=no',
    '-o', 'ConnectTimeout=4', '-o', 'ConnectionAttempts=1',
    '-i', join(profile, '.ssh', 'oracle_20260624'), 'ubuntu@217.142.225.255',
    "sudo -n -u postgres env PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=1000' psql -X -w -qAt -p 5432 -v ON_ERROR_STOP=1 -d mita"
  ] };
}

export function parseSshOutput(stdout: string) {
  if (Buffer.byteLength(stdout) > MAX_BYTES) throw new Error('evidence_limit');
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 + logQueries.length) throw new Error('invalid_ssh_output');
  return combine(JSON.parse(lines[0]), lines.slice(1).map(line => JSON.parse(line)), 'vps');
}

export async function readVpsEvidence(): Promise<Evidence | null> {
  const invocation = sshInvocation();
  if (!invocation) return null;
  const script = `${beginSql}\n${supportsColumns('product_title_presentations', titleColumns).replace('AS available','AS titles_available')} \\gset\n` +
    `\\if :titles_available\n${snapshotSql};\n\\else\n${snapshotSqlWithoutTitles};\n\\endif\n` + logQueries.map(query =>
    `${supportsColumns(query.table, query.columns)} \\gset\n` +
    `\\if :available\n${query.sql};\n\\else\nSELECT 'null';\n\\endif\n`).join('') + 'ROLLBACK;\n';
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(invocation.executable, invocation.args, {
      timeout: 15000, maxBuffer: MAX_BYTES, windowsHide: true, encoding: 'utf8', shell: false
    }, (error, stdout) => error ? reject(new Error('vps_unavailable')) : resolve(stdout));
    child.stdin?.on('error', () => { /* Callback reports failed transport. */ });
    child.stdin?.end(script);
  });
  const evidence = parseSshOutput(stdout);
  // sudo/peer-authenticated psql normally uses a Unix socket: inet_* is NULL.
  const localSocket = evidence.serverAddress === null && evidence.serverPort === null;
  const localTcp = ['127.0.0.1', '::1'].includes(evidence.serverAddress ?? '') && evidence.serverPort === 5432;
  if (evidence.database !== 'mita' || !localSocket && !localTcp) throw new Error('vps_target_mismatch');
  return evidence;
}
