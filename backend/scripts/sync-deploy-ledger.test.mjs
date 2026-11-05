import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveTransfer, main} from './sync-catalog-vps.mjs';
import {migrateDeployLedger, deployLedgerSql} from './migrate-vps-deploy-ledger.mjs';

const request={deploy:true,day:'2026-11-06',runId:'00000000-0000-4000-8000-000000000001',
  watermark:'2026-11-06T00:00:00Z',sourceHash:'hash',jobs:{mode:'manual'}};

function ledgerClient({locked=true,deployLedger=true,nightlyLedger=true,deployState,nightlyState,nightlyDay=request.day}={}) {
  const calls=[], deployRows=[], nightlyRows=nightlyState?[{state:nightlyState,sync_day:nightlyDay}]:[];
  return {calls,deployRows,nightlyRows,query:async (sql,params)=>{
    calls.push({sql,params});
    if (sql.includes('pg_try_advisory_lock')) return {rows:[{locked}]};
    if (sql.includes('to_regclass')) return {rows:[{nightly:nightlyLedger?'catalog_sync_ledger':null,deploy:deployLedger?'catalog_deploy_ledger':null}]};
    if (sql.startsWith('SELECT run_id FROM catalog_deploy_ledger')) {
      assert.match(sql,/WHERE state='running' LIMIT 1$/);
      return {rows:deployState==='running'?[{run_id:'pending'}]:[]};
    }
    if (sql.startsWith('SELECT run_id FROM catalog_sync_ledger')) {
      assert.match(sql,/WHERE state='running' LIMIT 1$/);
      return {rows:nightlyRows.filter(row=>row.state==='running')};
    }
    if (sql.startsWith('INSERT INTO catalog_deploy_ledger')) {
      deployRows.push({runId:params[0],state:'running'}); return {rowCount:1};
    }
    if (sql.startsWith('INSERT INTO catalog_sync_ledger')) {
      if (nightlyRows.some(row=>row.sync_day===params[0])) return {rowCount:0};
      nightlyRows.push({state:'running',sync_day:params[0]}); return {rowCount:1};
    }
    if (sql.startsWith('SELECT state FROM catalog_sync_ledger')) return {rows:nightlyRows.filter(row=>row.sync_day===params[0])};
    throw Error('Unexpected mock query: '+sql);
  }};
}

test('One-Click permits repeated same-day runs after completed or partial nightly commits', async()=>{
  for (const nightlyState of ['completed','partial']) {
    const client=ledgerClient({nightlyState});
    for (const runId of [request.runId,'00000000-0000-4000-8000-000000000002'])
      assert.equal(await reserveTransfer(client,{...request,runId}),true);
    assert.equal(client.deployRows.length,2);
    assert.deepEqual(client.nightlyRows,[{state:nightlyState,sync_day:request.day}]);
    assert.equal(client.calls.some(({sql})=>sql.startsWith('INSERT INTO catalog_sync_ledger')),false);
  }
});

test('One-Click permits a new attempt after an old failed nightly day',async()=>{
  const client=ledgerClient({nightlyState:'failed',nightlyDay:'2026-11-05'});
  assert.equal(await reserveTransfer(client,request),true);
  assert.equal(client.deployRows.length,1);
  assert.deepEqual(client.nightlyRows,[{state:'failed',sync_day:'2026-11-05'}]);
  assert.equal(client.calls.some(({sql})=>/^(UPDATE|DELETE)/.test(sql)),false);
});

test('One-Click permits a new attempt after a previous failed deploy',async()=>{
  const client=ledgerClient({deployState:'failed',nightlyState:'failed'});
  assert.equal(await reserveTransfer(client,request),true);
  assert.equal(client.deployRows.length,1);
  assert.equal(client.calls.some(({sql})=>/^(UPDATE|DELETE)/.test(sql)),false);
});

test('nightly remains once per day and never replays partial, failed or running', async()=>{
  for (const nightlyState of ['completed','partial','failed','running']) {
    const client=ledgerClient({nightlyState});
    if (nightlyState==='completed') assert.equal(await reserveTransfer(client,{...request,deploy:false}),false);
    else await assert.rejects(reserveTransfer(client,{...request,deploy:false}),/manual inspection/);
    assert.deepEqual(client.nightlyRows,[{state:nightlyState,sync_day:request.day}]);
  }
  assert.equal(await reserveTransfer(ledgerClient({deployLedger:false}),{...request,deploy:false}),true);
});

test('nightly can claim a new day after a failed prior day',async()=>{
  const client=ledgerClient({nightlyState:'failed',nightlyDay:'2026-11-05',deployState:'failed'});
  assert.equal(await reserveTransfer(client,{...request,deploy:false}),true);
  assert.deepEqual(client.nightlyRows,[{state:'failed',sync_day:'2026-11-05'},
    {state:'running',sync_day:request.day}]);
});

test('concurrent writer, missing migration and unresolved runs fail before reservation', async()=>{
  for (const config of [{locked:false},{deployLedger:false},{nightlyLedger:false},
    {deployState:'running'},{nightlyState:'running'},{nightlyState:'running',nightlyDay:'2026-11-05'}]) {
    const client=ledgerClient(config);
    await assert.rejects(reserveTransfer(client,request));
    assert.equal(client.calls.some(({sql})=>sql.startsWith('INSERT')),false);
    assert.match(client.calls[0].sql,/pg_try_advisory_lock/);
  }
});

test('new migration is additive, idempotent SQL; dry-run is strictly read-only',async()=>{
  const calls=[];
  const client={query:async sql=>{
    calls.push(sql);
    if (sql.includes('current_database')) return {rows:[{db:'mita'}]};
    if (sql.includes('to_regclass')) return {rows:[{ledger:null}]};
    return {rows:[]};
  }};
  assert.deepEqual(await migrateDeployLedger(client,'--dry-run'),{state:'dry_run',ledger:null});
  assert.ok(calls.every(sql=>sql.startsWith('SELECT')));
  calls.length=0;
  await migrateDeployLedger(client,'--apply');
  await migrateDeployLedger(client,'--apply');
  assert.equal(calls.filter(sql=>sql===deployLedgerSql).length,2);
  assert.match(deployLedgerSql,/CREATE TABLE IF NOT EXISTS catalog_deploy_ledger/);
  assert.doesNotMatch(deployLedgerSql,/UNIQUE|DROP|ALTER|DELETE|catalog_sync_ledger/i);
});

test('migration refuses wrong identity and rolls back DDL errors',async()=>{
  const calls=[];
  await assert.rejects(migrateDeployLedger({query:async sql=>{
    calls.push(sql); return {rows:[{db:'postgres'}]};
  }},'--apply'),/Unexpected target/);
  assert.equal(calls.length,1);
  await assert.rejects(migrateDeployLedger({query:async sql=>{
    calls.push(sql);
    if (sql.includes('current_database')) return {rows:[{db:'mita'}]};
    if (sql===deployLedgerSql) throw Error('mock DDL failure');
    return {rows:[]};
  }},'--apply'),/mock DDL failure/);
  assert.equal(calls.at(-1),'ROLLBACK');
});

// Exercise the real orchestration using empty in-memory catalogs. This never
// imports pg, reads credentials or opens a connection to any database.
test('orchestration commits ledger with catalog and preserves uncertain COMMIT marker',async()=>{
  const saved={argv:process.argv,env:process.env,exitCode:process.exitCode,log:console.log,error:console.error};
  try {
    process.argv=['node','sync-catalog-vps.mjs','--deploy-apply'];
    process.env={MITA_LOCAL_DATABASE_URL:'postgresql://mock@127.0.0.1:5433/postgres',
      MITA_VPS_DATABASE_URL:'postgresql://mock@127.0.0.1:15432/mita',MITA_SYNC_JOBS:'invalid nightly barrier'};
    console.log=()=>{};
    for (const failure of [null,'partial','schema','verify','commit','marker','marker-many',
      'rollback','failed-marker','failed-marker-query']) {
      process.exitCode=0;
      const calls=[], errors=[];
      console.error=message=>errors.push(message);
      const image=(id,position,stamp)=>({asin:'A',position,source_url:`https://m.media-amazon.com/images/I/${id}.jpg`,source_observed_at:stamp});
      const sourceImages=failure==='partial'?[image('fresh',1,'2026-11-06')]:[];
      let remoteImages=failure==='partial'?[image('old1',1,'2026-11-05'),image('old2',2,'2026-11-05')]:[];
      class Client {
        constructor({connectionString}) {this.remote=connectionString.endsWith('/mita');}
        async connect() {}
        async end() {calls.push({sql:'END',remote:this.remote});}
        async query(sql,params) {
          calls.push({sql,params,remote:this.remote});
          if (failure==='schema' && sql.includes('LIMIT 0')) throw Object.assign(Error('mock schema missing'),{code:'42P01'});
          if (sql.includes('current_database')) return {rows:[{db:this.remote?'mita':'postgres'}]};
          if (sql==='SHOW server_version_num') return {rows:[{server_version_num:'160000'}]};
          if (sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
          if (sql.includes("AS nightly")) return {rows:[{nightly:'catalog_sync_ledger',deploy:'catalog_deploy_ledger'}]};
          if (sql.includes('to_regclass')) return {rows:[{value:'exists'}]};
          if (sql.includes('count(*)')) return {rows:[{n:0}]};
          if (sql.includes('AS watermark')) return {rows:[{watermark:request.watermark}]};
          if (sql.startsWith('DELETE FROM product_images')) remoteImages=[];
          if (sql.startsWith('INSERT INTO product_images')) remoteImages.push({asin:params[0],position:params[1],source_url:params[2],source_observed_at:params[3]});
          if (!sql.includes('LIMIT 0') && (sql.startsWith('SELECT asin,position,source_url,source_observed_at FROM product_images') || sql==='SELECT * FROM "product_images"' || sql.startsWith('SELECT "asin","position","source_url","source_observed_at" FROM "product_images"')))
            return {rows:this.remote?remoteImages:sourceImages};
          if (sql==='COMMIT' && failure==='commit') throw Error('mock lost response');
          if (sql==='SELECT asin,name FROM products' && ['verify','rollback','failed-marker','failed-marker-query'].includes(failure)) throw Error('mock verification failed');
          if (sql==='ROLLBACK' && this.remote && failure==='rollback') throw Error('mock rollback failed');
          if (['marker','marker-many'].includes(failure) && sql.startsWith('UPDATE catalog_deploy_ledger SET state=$2')) return {rowCount:failure==='marker'?0:2,rows:[]};
          if (sql.includes("SET state='failed'")) {
            if (failure==='failed-marker') return {rowCount:0,rows:[]};
            if (failure==='failed-marker-query') throw Error('mock failure marker failed');
          }
          return {rows:[],rowCount:1};
        }
      }
      await main({Client});
      assert.equal(process.exitCode,failure && failure!=='partial'?1:0);
      const remote=calls.filter(call=>call.remote);
      const reservation=remote.findIndex(({sql})=>sql.startsWith('INSERT INTO catalog_deploy_ledger'));
      if (failure==='schema') {
        assert.equal(reservation,-1);
        assert.equal(remote.some(({sql})=>sql==='BEGIN'),false);
        continue;
      }
      const begin=remote.findIndex(({sql})=>sql==='BEGIN');
      assert.ok(reservation>=0 && reservation<begin);
      assert.equal(remote.some(({sql})=>sql.startsWith('INSERT INTO catalog_sync_ledger')),false);
      const marker=remote.findIndex(({sql})=>sql.startsWith('UPDATE catalog_deploy_ledger SET state=$2'));
      const commit=remote.findIndex(({sql})=>sql==='COMMIT');
      const failed=remote.find(({sql})=>sql.includes("SET state='failed'"));
      if (['verify','marker','marker-many','failed-marker','failed-marker-query'].includes(failure)) {
        assert.ok(failed);
        assert.equal(commit,-1);
        assert.ok(remote.findIndex(({sql})=>sql==='ROLLBACK')<remote.indexOf(failed));
        assert.deepEqual(failed.params,[remote[reservation].params[0]]);
        assert.match(failed.sql,/WHERE run_id=\$1 AND state='running'/);
        if (failure.startsWith('failed-marker')) assert.ok(errors.some(message=>message.startsWith('SYNC_LEDGER_UNRESOLVED:')));
      } else if (failure==='rollback') {
        assert.equal(commit,-1);
        assert.equal(failed,undefined);
        assert.ok(errors.some(message=>message.startsWith('SYNC_ROLLBACK_UNCONFIRMED:')));
      } else {
        assert.ok(marker>begin && commit>marker);
        assert.equal(failed,undefined);
        assert.equal(remote[marker].params[1],failure==='partial'?'partial':'completed');
        assert.equal(remote[marker].params[0],remote[reservation].params[0]);
        assert.match(remote[marker].sql,/WHERE run_id=\$1 AND state='running'/);
      }
      assert.equal(remote.at(-1).sql,'END');
    }
  } finally {
    process.argv=saved.argv;process.env=saved.env;process.exitCode=saved.exitCode;
    console.log=saved.log;console.error=saved.error;
  }
});
