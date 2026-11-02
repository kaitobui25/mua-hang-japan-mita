import pg from 'pg';

// Separate migration; catalog sync itself never creates/changes table schema.
const mode=process.argv[2];
if(process.argv.length!==3 || !['--dry-run','--apply'].includes(mode))
  throw Error('Usage: node scripts/migrate-vps-title-revisions.mjs --dry-run|--apply');
const url=process.env.MITA_VPS_DATABASE_URL;
if(!url)throw Error('Missing encrypted VPS database connection');
const endpoint=new URL(url);
if(!['postgres:','postgresql:'].includes(endpoint.protocol) || endpoint.hostname!=='127.0.0.1' ||
   endpoint.port!=='15432' || endpoint.pathname!=='/mita' || endpoint.search || endpoint.hash)
  throw Error('Title revision migration requires the approved SSH-forwarded Mita database');
const db=new pg.Client({connectionString:url,connectionTimeoutMillis:12000});
try{
  await db.connect();
  const identity=(await db.query('SELECT current_database() AS db')).rows[0]?.db;
  if(identity!=='mita')throw Error('Unexpected target database');
  const columns=['name_revision','name_generation','name_model'];
  if(mode==='--dry-run'){
    const found=(await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='product_translations' AND column_name=ANY($1::text[])`,[columns])).rows;
    console.log(JSON.stringify({state:'dry_run',database:identity,present:found.map(row=>row.column_name),required:columns}));
  }else{
    await db.query('BEGIN');
    try{
      await db.query(`ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_revision bigint;
        ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_generation uuid;
        ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_model text`);
      await db.query('COMMIT');
      console.log('VPS_TITLE_REVISION_MIGRATION_OK');
    }catch(error){await db.query('ROLLBACK');throw error;}
  }
}finally{await db.end();}
