import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

// Explicitly reviewed, fixed-scope schema migration; never run the full local
// db:migrate bundle or arbitrary future SQL against production.
const APPROVED_SQL_SHA256='6799e8d1612e5e19388e4552c48849171ac5e11b59dbd542da2f0eb0c7612194';
const mode=process.argv[2];
if(process.argv.length!==3 || !['--dry-run','--apply'].includes(mode))
  throw Error('Usage: node scripts/migrate-vps-amazon-quotes.mjs --dry-run|--apply');
const url=process.env.MITA_VPS_DATABASE_URL;
if(!url)throw Error('Missing approved VPS database connection');
const endpoint=new URL(url);
if(!['postgres:','postgresql:'].includes(endpoint.protocol) || endpoint.hostname!=='127.0.0.1' ||
   endpoint.port!=='15432' || endpoint.pathname!=='/mita' || endpoint.search || endpoint.hash)
  throw Error('Checkout migration requires approved SSH-forwarded Mita database');

const sqlBytes=await readFile(new URL('../src/db/amazon-quotes.sql',import.meta.url));
if(createHash('sha256').update(sqlBytes).digest('hex')!==APPROVED_SQL_SHA256)
  throw Error('Checkout migration SQL changed; review and update the approved checksum before applying');

async function inspect(client){
  const tables=['amazon_quote_settings','amazon_quotes','amazon_quote_rate_limits'];
  const fields={
    orders:['checkout_key','checkout_fingerprint','shipping_proposed_vnd','shipping_confirmation_hash','shipping_confirmed_at'],
    order_items:['line_id','quote_snapshot']
  };
  const indexes=['amazon_quotes_expiry_idx','order_items_catalog_unique_idx',
    'order_items_quote_unique_idx','orders_checkout_key_idx'];
  // One pg.Client permits only one active query; run probes sequentially.
  const existingTables=await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name=ANY($1::text[])`,[tables]);
  const columns=await client.query(`SELECT table_name,column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`,[['orders','order_items']]);
  const existingIndexes=await client.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname='public' AND indexname=ANY($1::text[])`,[indexes]);
  const pk=await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.order_items'::regclass AND contype='p'`);
  const existingTableNames=new Set(existingTables.rows.map(row=>row.table_name));
  const columnNames=new Set(columns.rows.map(row=>row.table_name+'.'+row.column_name));
  const existingIndexNames=new Set(existingIndexes.rows.map(row=>row.indexname));
  const missing=[
    ...tables.filter(name=>!existingTableNames.has(name)).map(name=>'table:'+name),
    ...Object.entries(fields).flatMap(([table,names])=>names.filter(name=>
      !columnNames.has(table+'.'+name)).map(name=>'column:'+table+'.'+name)),
    ...indexes.filter(name=>!existingIndexNames.has(name)).map(name=>'index:'+name)
  ];
  if(pk.rows.length!==1 || pk.rows[0].definition!=='PRIMARY KEY (line_id)')
    missing.push('constraint:order_items_pkey(line_id)');
  if(columns.rows.find(row=>row.table_name==='orders' && row.column_name==='estimated_shipping_vnd')?.is_nullable!=='YES')
    missing.push('nullable:orders.estimated_shipping_vnd');
  if(existingTableNames.has('amazon_quote_settings')){
    const setting=await client.query('SELECT 1 FROM public.amazon_quote_settings WHERE id=1');
    if(setting.rowCount!==1)missing.push('setting:amazon_quote_settings.id=1');
  }
  return missing;
}

const db=new pg.Client({connectionString:url,connectionTimeoutMillis:12000});
try{
  await db.connect();
  const database=(await db.query('SELECT current_database() AS name')).rows[0]?.name;
  if(database!=='mita')throw Error('Unexpected target database');
  const missing=await inspect(db);
  if(mode==='--dry-run'){
    console.log(JSON.stringify({state:'dry_run',database,ready:missing.length===0,missing}));
  }else if(missing.length===0){
    console.log('VPS_AMAZON_CHECKOUT_SCHEMA_OK (already compatible)');
  }else{
    await db.query('BEGIN');
    try{
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='60s'");
      await db.query('SELECT pg_advisory_xact_lock(70400200)');
      await db.query(sqlBytes.toString('utf8'));
      const remaining=await inspect(db);
      if(remaining.length)throw Error('Checkout schema remains incomplete after migration: '+remaining.join(','));
      await db.query('COMMIT');
      console.log('VPS_AMAZON_CHECKOUT_SCHEMA_OK');
    }catch(error){
      await db.query('ROLLBACK');
      throw error;
    }
  }
}finally{
  await db.end();
}
