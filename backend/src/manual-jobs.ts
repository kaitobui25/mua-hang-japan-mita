/** Owner-triggered PC command line entrypoint. No scheduler, VPS sync or import. */
import { randomUUID } from 'node:crypto';
import { db } from './db/pool.js';
import { config } from './config.js';
import { syncCatalog } from './ingestion/sync.js';
import { runManualAmazonScan, type ManualAmazonMode } from './ingestion/manual-scan.js';
import { translatePendingDetails } from './translation/detail-jobs.js';
import { localEndpoint } from './translation/local.js';
import { readWorkerSettingsOrLegacy } from './workers/settings.js';
import { applyLocalCodexVerification } from './translation/codex-provider.js';
import { translateCodexNames } from './translation/codex-jobs.js';
import { translatePendingNames } from './translation/jobs.js';
import { compactPendingTitles } from './translation/compact-title.js';
import { logTranslationEvent, type TranslationWarningEvent } from './translation/warnings.js';

const [job, mode, rawLimit, ...extra] = process.argv.slice(2);
const uuid = randomUUID();
const resultMarker = 'MITA_WORKER_RESULT ';
const emit = (result: object) => console.log(resultMarker + JSON.stringify(result));

async function assertLocalDatabase() {
  const url = new URL(config.databaseUrl);
  if (process.env.MITA_VPS_WORKER === '1' || url.hostname !== '127.0.0.1' || url.port !== '5433' ||
      url.pathname !== '/postgres' || url.search || url.hash || !['postgres:','postgresql:'].includes(url.protocol))
    throw Error('manual_pc_local_database_required');
  const actual = await db.query<{ name:string; port:number }>('SELECT current_database() AS name,inet_server_port() AS port');
  if (actual.rows[0]?.name !== 'postgres' || actual.rows[0]?.port !== 5433)
    throw Error('manual_pc_database_identity_mismatch');
}

async function run() {
  if (extra.length || !['amazon','names','detail'].includes(job) ||
      (job==='amazon' && !['images','price','presence','full'].includes(mode)) ||
      (job!=='amazon' && mode!=='once') ||
      !((job==='amazon' && mode==='full' && rawLimit==='0') ||
        (/^[1-9][0-9]{0,2}$/.test(rawLimit ?? '') && Number(rawLimit)<=300))) throw Error('invalid_manual_job_options');
  const limit=Number(rawLimit);
  await assertLocalDatabase();

  if (job==='amazon' && mode!=='full') {
    const outcome=await runManualAmazonScan({mode:mode as ManualAmazonMode,limit});
    emit({runId:uuid,trigger:'manual',...outcome});
    if (outcome.state!=='completed' && outcome.state!=='partial') process.exitCode=2;
    return;
  }
  if (job==='amazon') {
    // Limit 0 runs the *same* discovery/backfill budget as the 04:00 daily job
    // (up to 200 per category). It never invokes VPS catalog sync.
    const outcome=await syncCatalog({...(limit ? {totalLimit:limit} : {}),manualExclusive:true});
    if (!('id' in outcome) || typeof outcome.id!=='number' ||
        !('attempted' in outcome) || typeof outcome.attempted!=='number' || typeof outcome.saved!=='number') {
      emit({version:1,worker:'amazon',mode:'full',runId:uuid,state:outcome.state,
        selected:null,attempted:null,succeeded:null,failed:null,updated:null,deferred:null,
        failures:[{asin:null,code:String(outcome.state),detail:'The source/worker preflight prevented a run'}]});
      process.exitCode=2;
      return;
    }
    const rows=await db.query<{asin:string|null;state:string;message:string;category_slug:string|null}>(
      'SELECT asin,state,message,category_slug FROM sync_errors WHERE sync_run_id=$1 ORDER BY id',[outcome.id]);
    emit({version:1,worker:'amazon',mode:'full',runId:uuid,syncRunId:outcome.id,
      state:outcome.state,selected:limit || null,attempted:outcome.attempted,succeeded:outcome.saved,
      failed:Math.max(0,outcome.attempted-outcome.saved),updated:outcome.updatedProducts,
      newProducts:outcome.newProducts,categoryBreakdown:outcome.categoryBreakdown,
      discovered:outcome.discovered,sourceErrors:outcome.errors,
      warnings:outcome.warnings,deferred:outcome.deferred,
      failures:rows.rows.map(row=>({asin:row.asin,code:row.state,detail:row.message.slice(0,160),category:row.category_slug}))});
    if (outcome.state!=='success' && outcome.state!=='partial') process.exitCode=2;
    return;
  }
  if (job==='names') {
    const settings=await readWorkerSettingsOrLegacy();
    if (settings.engine==='codex') {
      applyLocalCodexVerification();
      const outcome=await translateCodexNames({runId:uuid,trigger:'manual',maxProducts:limit});
      const failures=await db.query<{asin:string;outcome:string;issues:string[]}>(
        "SELECT asin,outcome,issues FROM codex_name_run_items WHERE run_id=$1 AND outcome IN ('failed','source_changed') ORDER BY asin LIMIT 300",[uuid]);
      emit({...outcome,failures:failures.rows.map(row=>({asin:row.asin,code:row.outcome,
        detail:Array.isArray(row.issues)?row.issues.join(', ').slice(0,160):'Unknown reason'}))});
      if (outcome.state==='deferred') process.exitCode=2;
      return;
    }
    if (settings.engine!=='openrouter') throw Error('unknown_name_engine');
    const lastIssues=new Map<string,{asin:string;code:string;detail:string}>();
    const outcome=await translatePendingNames({maxProducts:limit,log:async (event:TranslationWarningEvent) => {
      await logTranslationEvent(event); // Preserve the existing private audit trail.
      if (event.result==='failed' || event.published===false) {
        lastIssues.set(event.asin,{asin:event.asin,code:event.issues[0]??'provider_or_validation_failed',
          detail:event.issues.join(', ').slice(0,160)});
      } else if (event.result==='success' || event.result==='warning') lastIssues.delete(event.asin);
    }});
    let compact:{saved:number;deferred:number}|null=null;
    let presentationIssue:string|null=null;
    try { compact=await compactPendingTitles({maxProducts:limit,allowedAsins:outcome.selectedAsins}); }
    catch { presentationIssue='Short title step deferred; see private logs'; }
    const failures:Array<{asin:string|null;code:string;detail:string}>=[...lastIssues.values()];
    if (outcome.failed>failures.length) failures.push({asin:null,code:'failure_details_unavailable',
      detail:`${outcome.failed-failures.length} failed attempts have no precise per-ASIN reason`});
    const pausedReason=outcome.paused ? !process.env.OPENROUTER_API_KEY ? 'openrouter_key_not_configured'
      : 'quota_provider_or_worker_unavailable_check_private_log' : null;
    emit({version:1,worker:'names',engine:'openrouter',runId:uuid,
      state:outcome.paused?'partial':outcome.failed?'partial':'completed',
      selected:outcome.selectedAsins?.length ?? null,translated:outcome.translated,failed:outcome.failed,
      skipped:outcome.skipped,paused:outcome.paused,reason:pausedReason,
      shortTitles:compact,shortTitleReason:presentationIssue,failures});
    if (outcome.paused) process.exitCode=2;
    return;
  }
  localEndpoint();
  const successAsins=new Set<string>(),failedAsins=new Set<string>();
  const failures:{asin:string;slot:string;code:string}[]=[];
  const outcome=await translatePendingDetails({limit,manualExclusive:true,onItemResult(item) {
    if (item.outcome==='translated') successAsins.add(item.asin);
    else { failedAsins.add(item.asin);failures.push({asin:item.asin,slot:item.slot,code:item.reason??'unknown'}); }
  }});
  emit({version:1,worker:'detail',engine:'gguf',runId:uuid,
    state:outcome.paused?'partial':outcome.failed?'partial':'completed',limitProducts:limit,translatedSlots:outcome.translated,
    failedSlots:outcome.failed,skippedSlots:outcome.skipped,productsWithTranslatedSlots:successAsins.size,
    productsWithFailedSlots:failedAsins.size,paused:outcome.paused,failures});
  if (outcome.paused) process.exitCode=2;
}

try { await run(); }
catch (error) {
  const permitted=['invalid_manual_job_options','manual_pc_local_database_required','manual_pc_database_identity_mismatch',
    'invalid_name_translation_engine','unknown_name_engine','codex_requires_local_database'];
  const reason=error instanceof Error && permitted.includes(error.message) ? error.message : 'manual_job_outcome_unresolved';
  emit({version:1,runId:uuid,worker:job??null,mode:mode??null,state:'unresolved',
    succeeded:null,failed:null,reason,failures:[{asin:null,code:reason,detail:reason}]});
  process.exitCode=1;
} finally { await db.end(); }
