import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { selectGallery } from './gallery-snapshot-policy.mjs';

// Only the catalog and its translations are replicated. Admin, orders, pricing
// policy, catalog visibility and run/identity sequences belong to the VPS.
// Preserve published title metadata as a unit. A warned candidate may improve,
// but a failed/pending retry must never revoke usable remote text.
const keepTitle = `(product_translations.name IS NOT NULL AND
  (product_translations.status='success' OR
    (product_translations.status='warning' AND
      (EXCLUDED.status NOT IN ('success','warning') OR EXCLUDED.name IS NULL))))`;
const keepDetail = `(product_translations.detail IS NOT NULL AND
  (product_translations.detail_approved OR
    (product_translations.status='success' AND NOT product_translations.name_only)))`;
export const tableSpecs = [
  ['categories', [['slug','text'],['name','text'],['amazon_seed_url','text'],['shipping_estimate_vnd','integer']], 'ON CONFLICT (slug) DO NOTHING'],
  ['products', [
    ['asin','varchar(10)'],['category_slug','text'],['name','text'],['brand','text'],['image_url','text'],
    ['source_url','text'],['source_adapter','text'],['variant_group_basis','text'],
    ['variant_group_id','text'],['price_jpy','integer'],['price_observed_at','timestamptz'],
    ['availability','text'],['first_seen_at','timestamptz'],
    ['last_seen_at','timestamptz'],['updated_at','timestamptz']
  ], `ON CONFLICT (asin) DO UPDATE SET
      category_slug=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.category_slug ELSE products.category_slug END,
      name=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.name ELSE products.name END,
      brand=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at AND NULLIF(EXCLUDED.brand,'') IS NOT NULL THEN EXCLUDED.brand ELSE products.brand END,
      image_url=products.image_url,
      source_url=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.source_url ELSE products.source_url END,
      source_adapter=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN EXCLUDED.source_adapter ELSE products.source_adapter END,
      variant_group_basis=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN COALESCE(EXCLUDED.variant_group_basis,products.variant_group_basis) ELSE products.variant_group_basis END,
      variant_group_id=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at THEN COALESCE(EXCLUDED.variant_group_id,products.variant_group_id) ELSE products.variant_group_id END,
      price_jpy=CASE WHEN EXCLUDED.price_jpy IS NOT NULL AND EXCLUDED.price_observed_at IS NOT NULL AND (EXCLUDED.price_observed_at>products.price_observed_at OR products.price_observed_at IS NULL) THEN COALESCE(EXCLUDED.price_jpy,products.price_jpy) ELSE products.price_jpy END,
      price_observed_at=CASE WHEN EXCLUDED.price_jpy IS NOT NULL THEN GREATEST(EXCLUDED.price_observed_at,products.price_observed_at) ELSE products.price_observed_at END,
      availability=CASE WHEN EXCLUDED.last_seen_at>products.last_seen_at AND EXCLUDED.availability IS NOT NULL AND EXCLUDED.availability<>'unknown' THEN EXCLUDED.availability ELSE products.availability END,
      last_seen_at=GREATEST(EXCLUDED.last_seen_at,products.last_seen_at),
      updated_at=GREATEST(EXCLUDED.updated_at,products.updated_at)
      -- Deliberately DO NOT overwrite remote rights_status, admin_hidden_at or sale_status.`],
  ['product_details', [
    ['asin','varchar(10)'],['features','jsonb'],['ingredients','jsonb'],['usage','jsonb'],['specs','jsonb'],
    ['cautions','jsonb'],['variant_attributes','jsonb'],['child_asins','jsonb'],
    ['source_observed_at','timestamptz'],['provenance','jsonb']
  ], `ON CONFLICT (asin) DO UPDATE SET
      features=CASE WHEN EXCLUDED.features='[]'::jsonb THEN product_details.features ELSE EXCLUDED.features END,
      ingredients=CASE WHEN EXCLUDED.ingredients='[]'::jsonb THEN product_details.ingredients ELSE EXCLUDED.ingredients END,
      usage=CASE WHEN EXCLUDED.usage='[]'::jsonb THEN product_details.usage ELSE EXCLUDED.usage END,
      specs=CASE WHEN EXCLUDED.specs='{}'::jsonb THEN product_details.specs ELSE EXCLUDED.specs END,
      cautions=CASE WHEN EXCLUDED.cautions='[]'::jsonb THEN product_details.cautions ELSE EXCLUDED.cautions END,
      variant_attributes=CASE WHEN EXCLUDED.variant_attributes='{}'::jsonb THEN product_details.variant_attributes ELSE EXCLUDED.variant_attributes END,
      child_asins=CASE WHEN EXCLUDED.child_asins='[]'::jsonb THEN product_details.child_asins ELSE EXCLUDED.child_asins END,
      source_observed_at=EXCLUDED.source_observed_at,
      provenance=product_details.provenance || EXCLUDED.provenance || jsonb_build_object(
        'fieldObservedAt',COALESCE(product_details.provenance->'fieldObservedAt','{}'::jsonb)
          || COALESCE(EXCLUDED.provenance->'fieldObservedAt','{}'::jsonb))
      WHERE EXCLUDED.source_observed_at>product_details.source_observed_at`],
  ['product_translations', [
    ['asin','varchar(10)'],['locale','text'],['name','text'],['detail','jsonb'],['source_hash','text'],
    ['model','text'],['status','text'],['translated_at','timestamptz'],['detail_attempted_at','timestamptz'],
    ['updated_at','timestamptz'],['name_only','boolean'],['name_attempts','integer'],
    ['name_source','jsonb'],['name_issues','jsonb'],['detail_approved','boolean']
  ], `ON CONFLICT (asin,locale) DO UPDATE SET
      ${['name','model','status','translated_at','name_source','name_issues'].map(field =>
        `${field}=CASE WHEN ${keepTitle} THEN product_translations.${field} ELSE EXCLUDED.${field} END`).join(',\n      ')},
      detail=CASE WHEN ${keepDetail} THEN product_translations.detail ELSE EXCLUDED.detail END,
      name_only=CASE WHEN ${keepDetail} THEN product_translations.name_only ELSE EXCLUDED.name_only END,
      detail_approved=CASE WHEN ${keepDetail} THEN product_translations.detail_approved ELSE EXCLUDED.detail_approved END,
      source_hash=CASE WHEN ${keepDetail} THEN product_translations.source_hash
        WHEN EXCLUDED.detail IS NOT NULL THEN EXCLUDED.source_hash
        WHEN ${keepTitle} THEN product_translations.source_hash ELSE EXCLUDED.source_hash END,
      detail_attempted_at=GREATEST(product_translations.detail_attempted_at,EXCLUDED.detail_attempted_at),
      updated_at=GREATEST(product_translations.updated_at,EXCLUDED.updated_at),
      name_attempts=GREATEST(product_translations.name_attempts,EXCLUDED.name_attempts)
      WHERE EXCLUDED.updated_at>product_translations.updated_at`],
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
        AND (EXCLUDED.translated IS NOT NULL OR local_detail_translation_items.translated IS NULL)
        AND local_detail_translation_items.source=EXCLUDED.source`],
  ['price_observations', [['asin','varchar(10)'],['price_jpy','integer'],['observed_at','timestamptz'],['source_adapter','text']],
    `ON CONFLICT (asin,observed_at) DO NOTHING`],
  ['product_detail_queue', [
    ['category_slug','text'],['asin','varchar(10)'],['parent_asin','varchar(10)'],['provenance','jsonb'],
    ['state','text'],['last_attempt_at','timestamptz'],['last_success_at','timestamptz'],['enqueued_at','timestamptz']
  ], `ON CONFLICT (category_slug,asin) DO NOTHING`]
];

// Daily data transfer must not execute DDL, migration or privileged table writes.
// Ledger DDL is applied explicitly by migrate-vps-sync-ledger.mjs.
const transferNames = [...tableSpecs.map(([name]) => name), 'product_images'];
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  }
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const dayJst = now => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0,10);
const jobNames = ['amazon','names','detail'];
function parseBarrier() {
  if (process.env.MITA_SYNC_JOBS === undefined) return { mode: 'manual' };
  let jobs;
  try { jobs=JSON.parse(process.env.MITA_SYNC_JOBS); } catch { throw Error('Invalid MITA_SYNC_JOBS JSON'); }
  for (const job of jobNames) {
    if (!['completed','skipped','partial','failed'].includes(jobs?.[job]?.state) ||
      jobs[job]?.day !== dayJst(new Date())) {
      throw Error('Daily sync requires all three terminal job states for the same JST day');
    }
  }
  return jobs;
}

// Slots are positional within an immutable snapshot. Refuse the entire batch
// before claiming the daily ledger if the two source generations disagree.
export async function assertCompatibleSnapshots(source, target) {
  const rows = (await target.query('SELECT asin,snapshot FROM local_detail_translations')).rows;
  const known = new Map(rows.map(row => [row.asin, row.snapshot]));
  for (const row of source.local_detail_translations) {
    if (known.has(row.asin) && digest(known.get(row.asin)) !== digest(row.snapshot)) {
      throw Error(`Frozen detail snapshot differs for ${row.asin}; manual reconciliation required`);
    }
  }
}

export function insertSql(name, columns, conflict) {
  const names = columns.map(([column])=>`"${column}"`).join(',');
  const defs = columns.map(([column,type])=>`"${column}" ${type}`).join(',');
  return `INSERT INTO "${name}" (${names}) SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS input(${defs}) WHERE true ${conflict}`;
}

// Coverage is per identity: unrelated remote rows cannot mask a missing title
// or slot. Timestamp ordering does not excuse loss of published text.
export function translationCoverageMissing(table, incoming, current) {
  if (table === 'product_translations') {
    const published = row => ['success','warning'].includes(row.status) && Boolean(row.name);
    return (published(incoming) && !published(current)) ||
      (Boolean(incoming.detail_approved) && incoming.detail != null &&
        !(current.detail != null && !current.name_only &&
          (current.detail_approved || current.status === 'success')));
  }
  return table === 'local_detail_translation_items' && incoming.translated != null && current.translated == null;
}

export function galleryNeedsSync(incoming, current) {
  const ordered = rows => [...rows].sort((a,b) => a.position-b.position);
  const selected = selectGallery(ordered(incoming), ordered(current));
  const content = rows => rows.map(row => [row.source_url, row.source_observed_at]);
  return digest(content(selected.rows)) !== digest(content(ordered(current)));
}

const keyColumns = {
  categories:['slug'],products:['asin'],product_images:['asin','position'],
  product_details:['asin'],product_translations:['asin','locale'],
  local_detail_translations:['asin'],local_detail_translation_items:['asin','slot'],
  price_observations:['asin','observed_at'],product_detail_queue:['category_slug','asin']
};
const rowKey = (name,row) => digest(keyColumns[name].map(column=>row[column]));
export async function verifyContents(source, targetClient) {
  const report=[];
  let mismatched=0;
  for (const name of transferNames) {
    const target=(await targetClient.query(`SELECT * FROM "${name}"`)).rows;
    const known=new Map(target.map(row=>[rowKey(name,row),row]));
    const missing=[],incorrect=[];
    if (name === 'product_images') {
      const asins = new Set(source[name].map(row => row.asin));
      for (const asin of asins) {
        if (galleryNeedsSync(source[name].filter(row => row.asin === asin),
          target.filter(row => row.asin === asin))) incorrect.push(asin);
      }
      mismatched += incorrect.length;
      report.push({table:name,local:source[name].length,vps:target.length,
        missing:0,contentMismatch:incorrect.length,sample:incorrect[0] ?? null});
      continue;
    }
    const significant = name==='product_details'
      ? ['features','ingredients','usage','specs','cautions','variant_attributes','child_asins','provenance']
      : name==='local_detail_translation_items'
        ? ['translated','source']
        : name==='local_detail_translations' ? ['snapshot']
        : [];
    for (const row of source[name]) {
      const remote=known.get(rowKey(name,row));
      if (!remote) { missing.push(rowKey(name,row)); continue; }
      if (translationCoverageMissing(name, row, remote)) incorrect.push(rowKey(name,row));
      // Remote newer data is valid. A newer local detail/source snapshot must
      // have arrived unchanged; immutable source snapshots are never replaced.
      if (significant.length &&
          (name==='local_detail_translations' || !row.updated_at || new Date(row.updated_at)>=new Date(remote.updated_at)) &&
          (name!=='product_details' || new Date(row.source_observed_at)>=new Date(remote.source_observed_at))) {
        if (significant.some(field=>digest(row[field])!==digest(remote[field]) &&
          !(name==='local_detail_translation_items' && field==='translated' && remote.translated && !remote.warning))) {
          incorrect.push(rowKey(name,row));
        }
      }
    }
    mismatched+=missing.length+incorrect.length;
    report.push({table:name,local:source[name].length,vps:target.length,missing:missing.length,
      contentMismatch:incorrect.length,sample:missing[0]??incorrect[0]??null});
  }
  return {report,mismatched};
}

export async function main() {
  const { default: pg } = await import('pg');
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
  async function syncGallery(source) {
    const current=(await to.query('SELECT asin,position,source_url,source_observed_at FROM product_images ORDER BY asin,position')).rows;
    const groups = rows => {
      const map=new Map();
      for (const row of rows) {
        if (!map.has(row.asin)) map.set(row.asin,[]);
        map.get(row.asin).push(row);
      }
      return map;
    };
    const incoming = groups(source), remote = groups(current);
    let replaced=0, preserved=0, partial=0, stale=0;
    for (const [asin, rows] of incoming) {
      const previous=remote.get(asin) ?? [];
      const selected=selectGallery(rows,previous);
      if(selected.kind==='stale'||selected.kind==='unchanged'){stale++;continue;}
      const next=selected.rows;
      if(selected.kind==='partial'){partial++;preserved++;}
      else replaced++;
      await to.query('DELETE FROM product_images WHERE asin=$1', [asin]);
      for (const [index,row] of next.slice(0,5).entries()) {
        await to.query('INSERT INTO product_images(asin,position,source_url,source_observed_at) VALUES($1,$2,$3,$4)',
          [asin,index+1,row.source_url,row.source_observed_at]);
      }
      if(next.length) await to.query('UPDATE products SET image_url=$2 WHERE asin=$1', [asin,next[0].source_url]);
    }
    console.log('GALLERY '+JSON.stringify({sourceAsins:incoming.size,replaced,preserved,partial,stale}));
    return {sourceAsins:incoming.size,replaced,preserved,partial,stale};
  }

  async function counts() {
    const data = {};
    for (const name of transferNames) {
      const l = await from.query(`SELECT count(*)::integer AS n FROM "${name}"`);
      const remoteExists = await to.query('SELECT to_regclass($1)::text AS value', [`public.${name}`]);
      const r = remoteExists.rows[0].value ? await to.query(`SELECT count(*)::integer AS n FROM "${name}"`) : {rows:[{n:0}]};
      data[name]={local:l.rows[0].n, vps:r.rows[0].n};
    }
    return data;
  }

  async function snapshotFrom() {
    const all={};
    for (const [name,cols] of tableSpecs) {
      all[name]=(await from.query(`SELECT ${cols.map(([col])=>'"'+col+'"').join(',')} FROM "${name}"`)).rows;
    }
    all.product_images=(await from.query('SELECT asin,position,source_url,source_observed_at FROM product_images ORDER BY asin,position')).rows;
    return all;
  }
  let localTx=false, remoteTx=false, openedLedger=false, ledgerDay;
  try {
    await from.connect(); await to.connect();
    const srcDb = await from.query('SELECT current_database() AS db, current_user AS role');
    const dstDb = await to.query('SELECT current_database() AS db, current_user AS role');
    const versions = await to.query('SHOW server_version_num');
    if (srcDb.rows[0].db!=='postgres' || dstDb.rows[0].db!=='mita' || Number(versions.rows[0].server_version_num)<160000)
      throw Error('Database identity/version mismatch; no changes made');
    await from.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); localTx=true;
    const watermark=(await from.query('SELECT transaction_timestamp() AS watermark')).rows[0].watermark;
    console.log('BEFORE '+JSON.stringify(await counts()));
    if (mode==='--dry-run') {
      await assertCompatibleSnapshots(await snapshotFrom(), to);
      console.log('DRY_RUN_OK: catalogs are readable; remote writes have NOT been attempted');
    } else if (mode==='--verify') {
      const source=await snapshotFrom();
      await assertCompatibleSnapshots(source, to);
      const {report,mismatched}=await verifyContents(source, to);
      console.log('VERIFY '+JSON.stringify(report));
      if (mismatched) throw Error('Data verification failed: missing/mismatched remote content');
      const names=(await from.query("SELECT count(*)::int AS n FROM product_translations WHERE locale='vi' AND status='success' AND name IS NOT NULL")).rows[0].n;
      const remoteNames=(await to.query("SELECT count(*)::int AS n FROM product_translations WHERE locale='vi' AND status IN ('success','warning') AND name IS NOT NULL")).rows[0].n;
      const details=(await to.query('SELECT count(*)::int AS n FROM local_detail_translation_items WHERE translated IS NOT NULL')).rows[0].n;
      console.log(`VERIFIED_TRANSLATIONS local_success_titles=${names} remote_published_titles=${remoteNames} remote_atomic_details=${details}`);

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
      const exists=(await to.query("SELECT to_regclass('public.catalog_sync_ledger')::text AS table_name")).rows[0].table_name;
      if (!exists) throw Error('Sync ledger is missing; run reviewed migrate-vps-sync-ledger.mjs --apply separately');
      ledgerDay=dayJst(new Date());
      const jobs=parseBarrier();
      const source=await snapshotFrom();
      await assertCompatibleSnapshots(source, to);
      const sourceHash=digest(transferNames.map(name=>[name,
        source[name].map(row=>[rowKey(name,row),digest(row)]).sort(([a],[b])=>a.localeCompare(b))]));
      const runId=randomUUID();
      // Commit the attempt reservation before any data writes. A crash or
      // disconnect leaves a durable running marker, blocking same-day replay.
      const claim=await to.query(`INSERT INTO catalog_sync_ledger(sync_day,run_id,state,jobs,watermark,source_hash)
        VALUES($1,$2,'running',$3,$4,$5) ON CONFLICT(sync_day) DO NOTHING
        RETURNING run_id`,[ledgerDay,runId,JSON.stringify(jobs),watermark,sourceHash]);
      if (!claim.rowCount) {
        const existing=(await to.query('SELECT state FROM catalog_sync_ledger WHERE sync_day=$1', [ledgerDay])).rows[0];
        if (existing?.state==='completed') {
          console.log('SYNC_ALREADY_COMPLETED '+ledgerDay+'; no replay or data writes');
          return; // The wrapper still runs --verify; no second batch is launched.
        }
        throw Error('Daily batch already claimed but not completed; manual inspection required');
      }
      openedLedger=true;
      await to.query('BEGIN'); remoteTx=true;
      await to.query('SELECT pg_advisory_xact_lock(70400421)');
      await assertCompatibleSnapshots(source, to);
      for (const [name,columns,conflict] of tableSpecs) {
        const rows=source[name];
        const statement=insertSql(name,columns,conflict);
        let changed=0;
        for (let i=0;i<rows.length;i+=80) {
          const batch=rows.slice(i,i+80);
          const written=await to.query(statement,[JSON.stringify(batch)]);
          changed+=written.rowCount || 0;
        }
        console.log(`TRANSFER ${name} source=${rows.length} inserted_or_updated=${changed}`);
      }
      const gallery=await syncGallery(source.product_images);
      const verification=await verifyContents(source, to);
      console.log('VERIFY '+JSON.stringify(verification.report));
      if (verification.mismatched) throw Error('Data verification failed before commit');
      const remoteHashes=[];
      for (const name of transferNames) {
        const columns= name==='product_images'
          ? ['asin','position','source_url','source_observed_at']
          : tableSpecs.find(([table])=>table===name)[1].map(([field])=>field);
        const rows=(await to.query(`SELECT ${columns.map(col=>'"'+col+'"').join(',')} FROM "${name}"`)).rows;
        remoteHashes.push([name,rows.map(row=>[rowKey(name,row),digest(row)]).sort(([a],[b])=>a.localeCompare(b))]);
      }
      const remoteHash=digest(remoteHashes);
      // The remote COMMIT and the marker are one transaction. Disconnect after
      // COMMIT can safely be diagnosed by inspecting the marker.
      const finalState=gallery.partial?'partial':'completed';
      await to.query(`UPDATE catalog_sync_ledger SET state=$2,remote_hash=$3,committed_at=now(),
        note=$4 WHERE sync_day=$1 AND run_id=$5`,
        [ledgerDay,finalState,remoteHash,gallery.partial?'Partial gallery preserved; verify identities':'',runId]);
      await to.query('COMMIT');remoteTx=false;
      console.log('SYNC_COMMIT_OK '+JSON.stringify({day:ledgerDay,runId,state:finalState,watermark,sourceHash,remoteHash}));
      console.log('AFTER '+JSON.stringify(await counts()));
    }
  } catch(error) {
    if(remoteTx) await to.query('ROLLBACK').catch(()=>{});
    if(openedLedger) {
      await to.query(`UPDATE catalog_sync_ledger SET state='failed',note='Transfer failed; manual inspection required'
        WHERE sync_day=$1 AND state='running'`,[ledgerDay]).catch(()=>{});
    }
    console.error('SYNC_FAILED '+(error instanceof Error ? error.message:'unknown'));
    process.exitCode=1;
  } finally {
    if(localTx) await from.query('ROLLBACK').catch(()=>{});
    await Promise.allSettled([from.end(),to.end()]);
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
