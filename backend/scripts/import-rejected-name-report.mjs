import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { nameHash } from '../src/translation/jobs.ts';
import { assertTranslation } from '../src/translation/openrouter.ts';
import { assessTranslation, logTranslationEvent } from '../src/translation/warnings.ts';

// One-time recovery from the owner's earlier read-only 157-title diagnosis.
// The original rejected provider responses were never stored; these are NEW
// OpenRouter translations. Verify full source identity and the failed DB state.
const [mode, file] = process.argv.slice(2);
if (!['--dry-run','--apply'].includes(mode) || !file || process.argv.length!==4)
  throw Error('Usage: node --import tsx scripts/import-rejected-name-report.mjs --dry-run|--apply <report.txt>');
const content = await readFile(file,'utf8');
if(!/157 tên sản phẩm/i.test(content) || !content.includes('được DỊCH LẠI'))
  throw Error('The provided report is not the 157-title retranslation diagnosis');
// Rejected entries have extra diagnostic lines between the reason and Model.
const regex=/^\[(\d+)\/157\] [^|\r\n]+ \| ([A-Z0-9]{10})\r?\nTên gốc: ([^\r\n]+)\r?\nThương hiệu: [^\r\n]+\r?\nBản dịch MỚI: ([\s\S]+?)\r?\nLý do \/ kết quả: ([^\r\n]+)\r?\n(?:[^\r\n]*\r?\n)*?Model: ([^\r\n]+)/gm;
const records=[...content.matchAll(regex)].map(m=>({index:Number(m[1]),asin:m[2],original:m[3],name:m[4].replace(/\r?\n/g,' ').trim(),note:m[5],model:m[6]}));
if(records.length!==157 || new Set(records.map(r=>r.asin)).size!==157 || records.some((r,i)=>r.index!==i+1))
  throw Error(`Report malformed: ${records.length} complete entries`);
const sourceUrl=process.env.MITA_LOCAL_DATABASE_URL || 'postgresql://mita_local@127.0.0.1:5433/postgres';
const url=new URL(sourceUrl);
if(url.hostname!=='127.0.0.1'||url.port!=='5433'||url.pathname!=='/postgres') throw Error('Local database only');
const db=new pg.Client({connectionString:sourceUrl});
let locked=false;
try {
  await db.connect(); await db.query('BEGIN'); locked=true;
  const {rows}=await db.query(`SELECT p.asin,p.name,p.brand,t.status,t.name AS translated_name,t.name_attempts
    FROM products p JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'
    WHERE p.asin=ANY($1::varchar(10)[]) ORDER BY p.asin FOR UPDATE OF p`,[records.map(r=>r.asin)]);
  if(rows.length!==157) throw Error(`Expected 157 matching DB rows; got ${rows.length}`);
  const byAsin=new Map(rows.map(r=>[r.asin,r]));
  const update=[];
  for(const candidate of records){
    // A diagnostic heading like "[Sản phẩm bộ]" is prose, not a JSON array.
    // Normalize only this known natural-language prefix for the structural guard.
    candidate.name=candidate.name.replace(/^\[Sản phẩm bộ\]\s*/u,'Sản phẩm bộ ');
    const current=byAsin.get(candidate.asin);
    if(current.name!==candidate.original) throw Error(`Original source changed: ${candidate.asin}`);
    if(current.status==='success' && current.translated_name) continue;
    if(current.status!=='failed' || current.translated_name) throw Error(`Unsafe existing status: ${candidate.asin}`);
    let result;
    try {
      result=assessTranslation(current.name,candidate.name,(_src,value)=>{
        assertTranslation({name:current.name,brand:current.brand,features:[],ingredients:[],usage:[],cautions:[],specs:{}},
          {name:value,features:[],ingredients:[],usage:[],cautions:[],specs:{}});
      },600);
    } catch(error) { throw Error(`Invalid report candidate ${candidate.asin}: ${error.message}`); }
    update.push({...candidate,issues:result.issues,source:{name:current.name,brand:current.brand}});
  }
  console.log(JSON.stringify({retranslated:records.length,importable:update.length,
    clean:update.filter(r=>!r.issues.length).length,warning:update.filter(r=>r.issues.length).length}));
  if(mode==='--apply'){
    for(const row of update){
      const state=row.issues.length?'warning':'success';
      const result=await db.query(`UPDATE product_translations SET name=$2,source_hash=$3,
        model=$4,status=$5,translated_at=now(),updated_at=now(),name_only=true,
        name_attempts=GREATEST(name_attempts,1),name_source=$6,name_issues=$7
        WHERE asin=$1 AND locale='vi' AND status='failed' AND name IS NULL RETURNING asin`,
      [row.asin,row.name,nameHash(row.source),row.model,state,JSON.stringify(row.source),JSON.stringify(row.issues)]);
      if(result.rowCount!==1) throw Error(`Concurrent change: ${row.asin}`);
    }
    await db.query('COMMIT'); locked=false;
    for(const row of update.filter(r=>r.issues.length)){
      await logTranslationEvent({asin:row.asin,locale:'vi',field:'name',engine:'openrouter',
        model:row.model,attempt:1,original:row.original,candidate:row.name,issues:row.issues,result:'warning'});
    }
    console.log('REPORT_IMPORT_COMMITTED');
  } else console.log('REPORT_IMPORT_DRY_RUN');
}catch(e){console.error('IMPORT_FAILED '+e.message);process.exitCode=1;}
finally{if(locked) await db.query('ROLLBACK').catch(()=>{});await db.end();}
