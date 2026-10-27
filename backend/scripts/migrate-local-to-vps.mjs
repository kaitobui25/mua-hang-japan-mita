import pg from 'pg';

// One-time direct database transfer; does not create a dump or a backup.
// The source is never modified and sessions/pg-boss queues are deliberately
// excluded. Stop the old local worker before --apply to freeze writes.
const mode = process.argv[2] ?? '--dry-run';
if (!['--dry-run', '--apply'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/migrate-local-to-vps.mjs [--dry-run|--apply]');
}

const sourceUrl = process.env.MITA_LOCAL_DATABASE_URL ?? 'postgresql://mita_local@127.0.0.1:5433/postgres';
const targetUrl = process.env.MITA_VPS_DATABASE_URL;
if (!targetUrl) throw new Error('Missing MITA_VPS_DATABASE_URL');
const source = new URL(sourceUrl);
const target = new URL(targetUrl);
if (source.hostname !== '127.0.0.1' || source.port !== '5433' ||
    target.hostname !== '127.0.0.1' || target.port !== '15432' || target.pathname !== '/mita') {
  throw new Error('Only the local PostgreSQL source and authenticated SSH-forwarded Mita target are permitted');
}

const tables = [
  'categories', 'products', 'sync_runs', 'sync_errors', 'price_observations',
  'orders', 'order_items', 'admin_accounts', 'admin_audit_events',
  'catalog_import_requests'
];
const sequenceTables = ['sync_runs', 'sync_errors', 'price_observations', 'admin_audit_events'];
const from = new pg.Client({ connectionString: sourceUrl, connectionTimeoutMillis: 10000 });
const to = new pg.Client({ connectionString: targetUrl, connectionTimeoutMillis: 10000 });
let fromTx = false;
let toTx = false;
try {
  await from.connect();
  await to.connect();
  const [srcVersion, dstVersion] = await Promise.all([
    from.query('SHOW server_version_num'), to.query('SHOW server_version_num')
  ]);
  if (Number(srcVersion.rows[0].server_version_num) < 160000 ||
      Number(dstVersion.rows[0].server_version_num) < 160000 ||
      Number(dstVersion.rows[0].server_version_num) >= 170000) {
    throw new Error('Expected PostgreSQL >=16 local and PostgreSQL 16 on Hermes');
  }

  await from.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  fromTx = true;
  const records = new Map();
  for (const table of tables) {
    const result = await from.query(`SELECT * FROM "${table}"`);
    records.set(table, result.rows);
    const remote = await to.query(`SELECT count(*)::int AS count FROM "${table}"`);
    console.log(`${table}: local=${result.rowCount}, VPS=${remote.rows[0].count}`);
    if (mode === '--apply' && !['categories'].includes(table) && remote.rows[0].count > 0) {
      throw new Error(`Refusing to merge into existing VPS ${table}; migration is initial-only`);
    }
  }
  if (mode === '--dry-run') {
    console.log('DRY RUN: connections/schema confirmed; no database content changed.');
  } else {
    await to.query('BEGIN');
    toTx = true;
    for (const table of tables) {
      const rows = records.get(table);
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error(`Unexpected columns in ${table}`);
      const keys = columns.map(column => `"${column}"`).join(',');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
      const query = `INSERT INTO "${table}" (${keys}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      for (const row of rows) await to.query(query, columns.map(column => row[column]));
    }
    const policy = await from.query('SELECT version, fx_jpy_to_vnd, service_fee_percent, updated_at FROM pricing_policy WHERE id=1');
    if (policy.rowCount === 1) {
      const p = policy.rows[0];
      await to.query(`UPDATE pricing_policy SET version=$1,fx_jpy_to_vnd=$2,service_fee_percent=$3,updated_at=$4 WHERE id=1`,
        [p.version, p.fx_jpy_to_vnd, p.service_fee_percent, p.updated_at]);
    }
    for (const table of sequenceTables) {
      await to.query(`SELECT setval(pg_get_serial_sequence('public.${table}', 'id'),
        GREATEST(COALESCE((SELECT max(id) FROM "${table}"), 0), 1),
        EXISTS(SELECT 1 FROM "${table}"))`);
    }
    for (const table of tables) {
      const result = await to.query(`SELECT count(*)::int AS count FROM "${table}"`);
      if (result.rows[0].count !== records.get(table).length) {
        throw new Error(`Post-migration row count mismatch: ${table}`);
      }
    }
    await to.query('COMMIT');
    toTx = false;
    console.log('Migration committed: all selected table row counts agree. No backup was created.');
  }
} catch {
  if (toTx) await to.query('ROLLBACK').catch(() => {});
  console.error('Migration aborted without changing the source. Target transaction rolled back if active.');
  process.exitCode = 1;
} finally {
  if (fromTx) await from.query('ROLLBACK').catch(() => {});
  await Promise.allSettled([from.end(), to.end()]);
}
