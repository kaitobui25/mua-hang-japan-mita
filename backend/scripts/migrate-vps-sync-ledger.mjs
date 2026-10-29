import pg from 'pg';

// Explicit, separately reviewed migration. Daily sync never executes DDL.
if (process.argv.length !== 3 || !['--dry-run', '--apply'].includes(process.argv[2])) {
  throw Error('Usage: node scripts/migrate-vps-sync-ledger.mjs --dry-run|--apply');
}
const url = process.env.MITA_VPS_DATABASE_URL;
if (!url) throw Error('Missing encrypted VPS database connection');
const endpoint = new URL(url);
if (!['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
    endpoint.hostname !== '127.0.0.1' || endpoint.port !== '15432' ||
    endpoint.pathname !== '/mita' || endpoint.search || endpoint.hash) {
  throw Error('Ledger migration requires the approved SSH-forwarded Mita database');
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 12000 });
try {
  await client.connect();
  const identity = (await client.query('SELECT current_database() AS db')).rows[0];
  if (identity.db !== 'mita') throw Error('Unexpected target database');
  if (process.argv[2] === '--dry-run') {
    const found = await client.query("SELECT to_regclass('public.catalog_sync_ledger')::text AS ledger");
    console.log(JSON.stringify({ state: 'dry_run', ledger: found.rows[0].ledger }));
  } else {
    await client.query('BEGIN');
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS catalog_sync_ledger (
        sync_day date PRIMARY KEY,
        run_id uuid NOT NULL UNIQUE,
        state text NOT NULL CHECK (state IN ('running','completed','partial','failed')),
        jobs jsonb NOT NULL DEFAULT '{}',
        watermark timestamptz,
        source_hash text,
        remote_hash text,
        started_at timestamptz NOT NULL DEFAULT now(),
        committed_at timestamptz,
        verified_at timestamptz,
        note text
      )`);
      await client.query('COMMIT');
      console.log('LEDGER_MIGRATION_OK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
