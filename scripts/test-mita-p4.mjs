import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelLifecycle, IDLE_MS } from './llama-on-demand.mjs';
import { canRestart, jstClock } from './mita-supervisor.mjs';
import { imageIdentity, hasExplicitSmallSize, selectGallery } from '../backend/scripts/gallery-snapshot-policy.mjs';
import { readFileSync } from 'node:fs';

const utc=jst=>new Date(jst+'+09:00');
const image=(name,time='2026-10-29T04:00:00Z',position=1)=>({
  source_url:`https://m.media-amazon.com/images/I/${name}._AC_SL1500_.jpg`,
  source_observed_at:time,position
});

test('llama coalesces concurrent startup and never stops active inference',async()=>{
  let clock=0,starts=0,stops=0;
  const lifecycle=createModelLifecycle({
    clock:()=>clock,
    start:async()=>{starts++;return {id:starts};},
    probe:async()=>true,stop:async()=>{stops++;}
  });
  await Promise.all([lifecycle.enter(),lifecycle.enter()]);
  assert.equal(starts,1);
  clock=IDLE_MS+1;
  assert.equal(await lifecycle.tick(),false);
  lifecycle.leave();
  assert.equal(await lifecycle.tick(),false);
  lifecycle.leave();
  clock+=IDLE_MS-1;
  assert.equal(await lifecycle.tick(),false);
  clock++;
  assert.equal(await lifecycle.tick(),true);
  assert.equal(stops,1);
  await lifecycle.enter();
  assert.equal(starts,2);
  lifecycle.leave();
  await lifecycle.close();
  assert.equal(stops,2);
});

test('llama failing to start frees active request lease',async()=>{
  const lifecycle=createModelLifecycle({
    start:async()=>{throw Error('model_not_ready');},
    probe:async()=>false,stop:async()=>{}
  });
  await assert.rejects(lifecycle.enter(),/model_not_ready/);
  assert.equal(lifecycle.snapshot().active,0);
});

test('restart deferred across each JST scheduled dispatch, with no missed catch-up',()=>{
  for(const due of ['2026-10-29T04:00:00','2026-10-29T05:00:00','2026-10-29T05:15:00']){
    const key=due.includes('T04')?'amazon':due.includes('T05:00')?'names':'detail';
    const at=utc(due);
    assert.equal(canRestart(key,new Date(at.getTime()-60000)),false);
    assert.equal(canRestart(key,new Date(at.getTime()+60000)),false);
    assert.equal(canRestart(key,new Date(at.getTime()+7*60000)),true);
    assert.equal(canRestart(key,new Date(at.getTime()-4*60000)),false);
    assert.equal(canRestart(key,new Date(at.getTime()-11*60000)),true);
    assert.equal(canRestart(key,new Date(at.getTime()+7*60000),true),false);
    assert.equal(jstClock(at).day,'2026-10-29');
  }
});

test('gallery keeps good snapshot on 5-to-1 partial and accepts 1-to-5 upgrade',()=>{
  const old=Array.from({length:5},(_,i)=>image('OLD'+i,'2026-10-28T04:00:00Z',i+1));
  const partial=[image('NEW','2026-10-29T04:00:00Z')];
  const preserved=selectGallery(partial,old);
  assert.equal(preserved.kind,'partial');
  assert.equal(preserved.rows.length,5);
  assert.deepEqual(preserved.rows,old);
  const fresh=Array.from({length:5},(_,i)=>image('NEW'+i,'2026-10-30T04:00:00Z',i+1));
  assert.deepEqual(selectGallery(fresh,[old[0]]),{kind:'replaced',rows:fresh});
  assert.equal(selectGallery(old,fresh).kind,'stale');
  assert.equal(selectGallery([...fresh].reverse(),fresh).kind,'stale');
  assert.equal(imageIdentity('https://m.media-amazon.com/images/I/SAME._AC_SX38_.jpg'),
    imageIdentity('https://m.media-amazon.com/images/I/SAME._AC_SL1500_.jpg'));
  assert.equal(hasExplicitSmallSize('https://m.media-amazon.com/images/I/SAME._AC_SX38_.jpg'),true);
  assert.equal(hasExplicitSmallSize('https://m.media-amazon.com/images/I/SAME._AC_SR1200,120_.jpg'),true);
  const tiny=[{...image('OLD0','2026-10-30T04:00:00Z'),source_url:'https://m.media-amazon.com/images/I/OLD0._AC_SX38_.jpg'}];
  assert.deepEqual(selectGallery(tiny,[old[0]]).rows,[old[0]]);
});

test('gallery preserves stale rows but accepts a newly observed appended image',()=>{
  const oldAt='2026-10-28T04:00:00Z';
  const newAt='2026-10-29T04:00:00Z';
  const previous=[image('A',oldAt,1),image('B',oldAt,2)];
  assert.deepEqual(selectGallery([...previous],previous),{kind:'stale',rows:previous});
  const mixed=[previous[0],image('C',newAt,2)];
  const selected=selectGallery(mixed,previous);
  assert.equal(selected.kind,'partial');
  assert.deepEqual(selected.rows,[...previous,mixed[1]]);
  // Mixed timestamps cannot replace a complete gallery, even at 5 URLs.
  const complete=Array.from({length:5},(_,i)=>image('KEEP'+i,oldAt,i+1));
  const carryingOld=[complete[0],...Array.from({length:4},(_,i)=>image('NEW'+i,newAt,i+2))];
  assert.deepEqual(selectGallery(carryingOld,complete).rows,complete);
  // A better URL with the same image identity upgrades a verified tiny old one.
  const low={...image('SAME',oldAt),source_url:'https://m.media-amazon.com/images/I/SAME._AC_SX38_.jpg'};
  const high=image('SAME',newAt);
  assert.deepEqual(selectGallery([low,high],[low]).rows,[high]);
});

test('daily sync contains no DDL and is limited to catalog transfer',()=>{
  const code=readFileSync(new URL('../backend/scripts/sync-catalog-vps.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|SCHEMA|ROLE)\b/i);
  assert.doesNotMatch(code,/applySchema\s*\(/);
  assert.match(code,/catalog_sync_ledger/);
  assert.match(code,/SYNC_ALREADY_COMPLETED/);
  assert.match(code,/DELETE FROM product_images WHERE asin=\$1/);
  // A queued/untranslated Windows item cannot erase an already usable VPS
  // warning candidate on a later daily transfer.
  assert.match(code,/EXCLUDED\.translated IS NOT NULL OR local_detail_translation_items\.translated IS NULL/);
});

test('stop-local is cooperative and cannot terminate descendants or unverified legacy processes',()=>{
  const source=readFileSync(new URL('./stop-local.ps1',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:Stop-Process|Stop-Children|taskkill(?:\.exe)?|ParentProcessId)\b/i);
  assert.match(source,/Get-OwnedProcess\s+'mita-supervisor'/);
  assert.match(source,/Get-OwnedProcess\s+'llama-gateway'/);
  assert.match(source,/\$record\.Root\s+-ne\s+\$root/);
  assert.match(source,/\$record\.Script\s+-ne\s+\$expectedScript/);
  assert.match(source,/\$actual\.StartTime\.ToUniversalTime\(\)/);
  assert.match(source,/\$win\.ExecutablePath\s+-notmatch/);
  assert.match(source,/\$win\.CommandLine\s+-notmatch\s+\$scriptArgPattern/);
  assert.match(source,/\$PSCmdlet\.ShouldProcess/);
  assert.match(source,/mita-supervisor\.stop/);
  assert.match(source,/llama-gateway\.stop/);
  assert.match(source,/\$legacyRecords\.Count\s+-gt\s+0/);
  assert.match(source,/pg_ctl\.exe.*-m smart/);
});
