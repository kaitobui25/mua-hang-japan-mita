import { pathToFileURL } from 'node:url';

// Explicit additive migration only. Catalog sync never runs this DDL.
export const deployLedgerSql = `CREATE TABLE IF NOT EXISTS catalog_deploy_ledger (
  run_id uuid PRIMARY KEY,
  sync_day date NOT NULL,
  state text NOT NULL CHECK (state IN ('running','completed','partial','failed')),
  watermark timestamptz,
  source_hash text,
  remote_hash text,
  started_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  verified_at timestamptz,
  note text
)`;

export async function migrateDeployLedger(client, mode) {
  if (!['--dry-run','--apply'].includes(mode)) throw Error('Invalid migration mode');
  const identity=(await client.query('SELECT current_database() AS db')).rows[0];
  if (identity.db!=='mita') throw Error('Unexpected target database');
  if (mode==='--dry-run') {
    const found=await client.query("SELECT to_regclass('public.catalog_deploy_ledger')::text AS ledger");
    return {state:'dry_run',ledger:found.rows[0].ledger};
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(deployLedgerSql);
    await client.query('COMMIT');
    return {state:'DEPLOY_LEDGER_MIGRATION_OK'};
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const mode=process.argv[2];
  if (process.argv.length!==3 || !['--dry-run','--apply'].includes(mode))
    throw Error('Usage: node scripts/migrate-vps-deploy-ledger.mjs --dry-run|--apply');
  const url=process.env.MITA_VPS_DATABASE_URL;
  if (!url) throw Error('Missing encrypted VPS database connection');
  const endpoint=new URL(url);
  if (!['postgres:','postgresql:'].includes(endpoint.protocol) ||
      endpoint.hostname!=='127.0.0.1' || endpoint.port!=='15432' ||
      endpoint.pathname!=='/mita' || endpoint.search || endpoint.hash)
    throw Error('Ledger migration requires the approved SSH-forwarded Mita database');
  const {default:pg}=await import('pg');
  const client=new pg.Client({connectionString:url,connectionTimeoutMillis:12000});
  try {
    await client.connect();
    console.log(JSON.stringify(await migrateDeployLedger(client,mode)));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
