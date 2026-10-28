import pg from 'pg';
import { readFile } from 'node:fs/promises';

// Only the catalog and its translations are replicated. Admin, orders, pricing
// policy, catalog visibility and run/identity sequences belong to the VPS.
const mode = process.argv[2];
if (!['--dry-run', '--apply', '--verify'].includes(mode) || process.argv.length !== 3)
  throw Error('Usage: node scripts/sync-catalog-vps.mjs --dry-run|--apply|--verify');

const localUrl = process.env.MITA_LOCAL_DATABASE_URL || 'postgresql://mita_local@127.0.0.1:5433/postgres';
const remoteUrl = process.env.MITA_VPS_DATABASE_URL;
if (!remoteUrl) throw Error('Encrypted VPS database connection is not configured');
const local = new URL(localUrl), remote = new URL(remoteUrl);
if (local.hostname !== '127.0.0.1' || local.port !== '5433' || local.pathname !== '/postgres' ||
    remote.hostname !== '127.0.0.1' || remote.port !== '15432' || remote.pathname !== '/mita')
  throw Error('Only approved local PostgreSQL and SSH-forwarded VPS Mita database are allowed');

const from = new pg.Client({ connectionString: localUrl, connectionTimeoutMillis: 12000 });
const to = new pg.Client({ connectionString: remoteUrl, connectionTimeoutMillis: 12000 });
const tableSpecs = [
  ['categories', [['slug','text'],['name','text'],['amazon_seed_url','text'],['shipping_estimate_vnd','integer']], 'ON CONFLICT (slug) DO NOTHING'],
  ['products', [
    ['asin','varchar(10)'],['category_slug','text'],['name','text'],['brand','text'],['image_url','text'],
    ['source_url','text'],['source_adapter','text'],['rights_status','text'],['variant_group_basis','text'],
    ['variant_group_id','text'],['price_jpy','integer'],['price_observed_at','timestamptz'],
    ['availability','text'],['sale_status','text'],['first_seen_at','timestamptz'],
    ['last_seen_at','timestamptz'],['updated_at','timestamptz'],['admin_hidden_at','timestamptz']
  ], `ON CONFLICT (asin) DO UPDATE SET
      category_slug=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.category_slug ELSE products.category_slug END,
      name=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.name ELSE products.name END,
      brand=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.brand ELSE products.brand END,
      image_url=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN COALESCE(EXCLUDED.image_url,products.image_url) ELSE products.image_url END,
      source_url=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.source_url ELSE products.source_url END,
      source_adapter=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.source_adapter ELSE products.source_adapter END,
      variant_group_basis=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.variant_group_basis ELSE products.variant_group_basis END,
      variant_group_id=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.variant_group_id ELSE products.variant_group_id END,
      price_jpy=CASE WHEN EXCLUDED.price_observed_at>products.price_observed_at OR products.price_observed_at IS NULL THEN COALESCE(EXCLUDED.price_jpy,products.price_jpy) ELSE products.price_jpy END,
      price_observed_at=GREATEST(EXCLUDED.price_observed_at,products.price_observed_at),
      availability=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.availability ELSE products.availability END,
      last_seen_at=GREATEST(EXCLUDED.last_seen_at,products.last_seen_at),
      updated_at=GREATEST(EXCLUDED.updated_at,products.updated_at)
      -- Deliberately DO NOT overwrite remote rights_status, admin_hidden_at or sale_status.`],
  ['product_images', [['asin','varchar(10)'],['position','smallint'],['source_url','text'],['source_observed_at','timestamptz']],
    `ON CONFLICT (asin,position) DO UPDATE SET source_url=EXCLUDED.source_url,
     source_observed_at=EXCLUDED.source_observed_at
     WHERE EXCLUDED.source_observed_at>product_images.source_observed_at`],
  ['product_details', [
    ['asin','varchar(10)'],['features','jsonb'],['ingredients','jsonb'],['usage','jsonb'],['specs','jsonb'],
    ['cautions','jsonb'],['variant_attributes','jsonb'],['child_asins','jsonb'],
    ['source_observed_at','timestamptz'],['provenance','jsonb']
  ], `ON CONFLICT (asin) DO UPDATE SET features=EXCLUDED.features,ingredients=EXCLUDED.ingredients,
      usage=EXCLUDED.usage,specs=EXCLUDED.specs,cautions=EXCLUDED.cautions,
      variant_attributes=EXCLUDED.variant_attributes,child_asins=EXCLUDED.child_asins,
      source_observed_at=EXCLUDED.source_observed_at,provenance=EXCLUDED.provenance
      WHERE EXCLUDED.source_observed_at>product_details.source_observed_at`],
  ['product_translations', [
    ['asin','varchar(10)'],['locale','text'],['name','text'],['detail','jsonb'],['source_hash','text'],
    ['model','text'],['status','text'],['translated_at','timestamptz'],['detail_attempted_at','timestamptz'],
    ['updated_at','timestamptz'],['name_only','boolean'],['name_attempts','integer'],
    ['name_source','jsonb'],['name_issues','jsonb'],['detail_approved','boolean']
  ], `ON CONFLICT (asin,locale) DO UPDATE SET
      name=EXCLUDED.name,detail=COALESCE(product_translations.detail,EXCLUDED.detail),
      source_hash=EXCLUDED.source_hash,model=EXCLUDED.model,
      status=EXCLUDED.status,translated_at=EXCLUDED.translated_at,
      detail_attempted_at=COALESCE(product_translations.detail_attempted_at,EXCLUDED.detail_attempted_at),
      updated_at=EXCLUDED.updated_at,name_only=EXCLUDED.name_only,
      name_attempts=GREATEST(product_translations.name_attempts,EXCLUDED.name_attempts),
      name_source=COALESCE(product_translations.name_source,EXCLUDED.name_source),
      name_issues=EXCLUDED.name_issues,detail_approved=(product_translations.detail_approved OR EXCLUDED.detail_approved)
      WHERE NOT (product_translations.status='success' AND product_translations.name IS NOT NULL)
        AND EXCLUDED.updated_at>product_translations.updated_at`],
  ['local_detail_translations', [['asin','varchar(10)'],['snapshot','jsonb'],['created_at','timestamptz']],
    'ON CONFLICT (asin) DO NOTHING'],
  ['local_detail_translation_items', [
    ['asin','varchar(10)'],['slot','text'],['source','text'],['translated','text'],['model','text'],
    ['attempts','integer'],['retry_after','timestamptz'],['error_code','text'],['updated_at','timestamptz'],
    ['warning','boolean'],['issues','jsonb']
  ], `ON CONFLICT (asin,slot) DO UPDATE SET translated=EXCLUDED.translated,
      model=EXCLUDED.model,attempts=GREATEST(local_detail_translation_items.attempts,EXCLUDED.attempts),
      retry_after=EXCLUDED.retry_after,error_code=EXCLUDED.error_code,
      updated_at=EXCLUDED.updated_at,warning=EXCLUDED.warning,issues=EXCLUDED.issues
      WHERE (local_detail_translation_items.translated IS NULL OR local_detail_translation_items.warning)
        AND EXCLUDED.updated_at>local_detail_translation_items.updated_at
        AND local_detail_translation_items.source=EXCLUDED.source`],
  ['price_observations', [['asin','varchar(10)'],['price_jpy','integer'],['observed_at','timestamptz'],['source_adapter','text']],
    `ON CONFLICT (asin,observed_at) DO NOTHING`],
  ['product_detail_queue', [
    ['category_slug','text'],['asin','varchar(10)'],['parent_asin','varchar(10)'],['provenance','jsonb'],
    ['state','text'],['last_attempt_at','timestamptz'],['last_success_at','timestamptz'],['enqueued_at','timestamptz']
  ], `ON CONFLICT (category_slug,asin) DO NOTHING`]
];

// Only an explicit schema from this repository, never uploaded arbitrary SQL.
async function applySchema() {
  await to.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  await to.query(await readFile(new URL('../src/db/admin.sql', import.meta.url), 'utf8'));
  await to.query(await readFile(new URL('../src/db/remove-needs-human.sql', import.meta.url), 'utf8'));
}

function insertSql(name, columns, conflict) {
  const names = columns.map(([column])=>`"${column}"`).join(',');
  const defs = columns.map(([column,type])=>`"${column}" ${type}`).join(',');
  return `INSERT INTO "${name}" (${names}) SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS input(${defs}) ${conflict}`;
}

async function counts() {
  const data = {};
  for (const [name] of tableSpecs) {
    const l = await from.query(`SELECT count(*)::integer AS n FROM "${name}"`);
    const remoteExists = await to.query('SELECT to_regclass($1)::text AS value', [`public.${name}`]);
    const r = remoteExists.rows[0].value ? await to.query(`SELECT count(*)::integer AS n FROM "${name}"`) : {rows:[{n:0}]};
    data[name]={local:l.rows[0].n, vps:r.rows[0].n};
  }
  return data;
}

let localTx=false, remoteTx=false;
try {
  await from.connect(); await to.connect();
  const [srcDb, dstDb, versions] = await Promise.all([
    from.query('SELECT current_database() AS db, current_user AS role'),
    to.query('SELECT current_database() AS db, current_user AS role'),
    to.query('SHOW server_version_num')
  ]);
  if (srcDb.rows[0].db!=='postgres' || dstDb.rows[0].db!=='mita' || Number(versions.rows[0].server_version_num)<160000)
    throw Error('Database identity/version mismatch; no changes made');
  await from.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); localTx=true;
  console.log('BEFORE '+JSON.stringify(await counts()));
  if (mode==='--dry-run') {
    console.log('DRY_RUN_OK: catalogs are readable; remote writes have NOT been attempted');
  } else if (mode==='--verify') {
    const diff=[];
    for (const [name] of tableSpecs) {
      const cols=name==='price_observations' ? 'asin,observed_at' : name==='product_detail_queue' ? 'category_slug,asin' :
        name==='local_detail_translation_items' ? 'asin,slot' : name==='product_images' ? 'asin,position' :
        name==='product_translations' ? 'asin,locale' : name==='categories' ? 'slug' : 'asin';
      const sourceKeys=(await from.query(`SELECT ${cols} FROM "${name}"`)).rows;
      const targetRows=(await to.query(`SELECT ${cols} FROM "${name}"`)).rows;
      const canonical=row=>JSON.stringify(Object.values(row).map(v=>v instanceof Date ? v.toISOString():v));
      const known=new Set(targetRows.map(canonical));
      const missing=sourceKeys.filter(r=>!known.has(canonical(r))).length;
      diff.push({table:name,local:sourceKeys.length,vps:targetRows.length,missing});
    }
    console.log('VERIFY '+JSON.stringify(diff));
    if(diff.some(row=>row.missing)) throw Error('Data verification failed: missing remote rows');
    const names=(await from.query("SELECT count(*)::int AS n FROM product_translations WHERE locale='vi' AND status='success' AND name IS NOT NULL")).rows[0].n;
    const remoteNames=(await to.query("SELECT count(*)::int AS n FROM product_translations WHERE locale='vi' AND status IN ('success','warning') AND name IS NOT NULL")).rows[0].n;
    const details=(await to.query('SELECT count(*)::int AS n FROM local_detail_translation_items WHERE translated IS NOT NULL')).rows[0].n;
    const expectedDetails=(await from.query('SELECT count(*)::int AS n FROM local_detail_translation_items WHERE translated IS NOT NULL')).rows[0].n;
    console.log(`VERIFIED_TRANSLATIONS local_success_titles=${names} remote_published_titles=${remoteNames} remote_atomic_details=${details}`);
    if(remoteNames<names || details<expectedDetails) throw Error('Remote translation coverage less than local');
    const publicCards = await to.query(`SELECT count(DISTINCT CASE
        WHEN variant_group_basis IS NOT NULL AND variant_group_id IS NOT NULL THEN
          'group:' || category_slug || ':' || variant_group_basis || ':' || variant_group_id
        ELSE 'asin:' || asin END)::integer AS total
      FROM products WHERE admin_hidden_at IS NULL AND (rights_status='verified'
      OR (rights_status='local_test_only' AND EXISTS (SELECT 1 FROM catalog_settings
        WHERE id=1 AND NOT hide_local_test_only)))`);
    console.log(`PUBLIC_EXPECTED_TOTAL=${publicCards.rows[0].total}`);
    console.log('VERIFY_OK');
  } else {
    await to.query('BEGIN'); remoteTx=true;
    await to.query('SELECT pg_advisory_xact_lock(70400421)');
    await applySchema();
    for (const [name,columns,conflict] of tableSpecs) {
      const selection= name==='price_observations'
        ? `SELECT asin,price_jpy,observed_at,source_adapter FROM price_observations`
        : `SELECT ${columns.map(([col])=>`"${col}"`).join(',')} FROM "${name}"`;
      const rows=(await from.query(selection)).rows;
      const statement=insertSql(name,columns,conflict);
      let changed=0;
      for (let i=0;i<rows.length;i+=80) {
        const batch=rows.slice(i,i+80);
        const written=await to.query(statement,[JSON.stringify(batch)]);
        changed+=written.rowCount || 0;
      }
      console.log(`TRANSFER ${name} source=${rows.length} inserted_or_updated=${changed}`);
    }
    // All rows and schema are committed atomically. No prior data is removed.
    await to.query('COMMIT');remoteTx=false;
    console.log('SYNC_COMMIT_OK');
    console.log('AFTER '+JSON.stringify(await counts()));
  }
} catch(error) {
  if(remoteTx) await to.query('ROLLBACK').catch(()=>{});
  console.error('SYNC_FAILED '+(error instanceof Error ? error.message:'unknown'));
  process.exitCode=1;
} finally {
  if(localTx) await from.query('ROLLBACK').catch(()=>{});
  await Promise.allSettled([from.end(),to.end()]);
}
