import test from 'node:test';
import assert from 'node:assert/strict';
import {applyWorkerWindows, canRunReviewSync, windows, unresolvedManualRequests} from './mita-supervisor.mjs';

test('Supervisor applies only correctly ordered JST schedules',()=>{
  const previous={...windows};
  try{
    applyWorkerWindows({amazon:'03:30',names:'04:15',detail:'05:20'});
    assert.deepEqual({...windows},{amazon:210,names:255,detail:320});
    assert.equal(canRunReviewSync(new Date('2026-11-02T18:00:00Z')),true);
    assert.equal(canRunReviewSync(new Date('2026-11-02T19:30:00Z')),false);
    for(const value of [
      {amazon:'05:00',names:'04:00',detail:'06:00'},
      {amazon:'05:00',names:'05:10',detail:'06:00'},
      {amazon:'05:00',names:'06:00',detail:'bad'},
      {amazon:'05:00',names:'06:00',detail:'07:00',sync:'08:00'}
    ]) assert.throws(()=>applyWorkerWindows(value));
    assert.deepEqual({...windows},{amazon:210,names:255,detail:320});
  }finally{Object.assign(windows,previous);}
});

test('Manual journal refuses unknown or unfinished dispatch after Supervisor restart',()=>{
  const requested=JSON.stringify({event:'requested',runId:'a'});
  const exited=JSON.stringify({event:'exited',runId:'a',exitCode:0});
  const failed=JSON.stringify({event:'dispatch_failed',runId:'a'});
  assert.deepEqual([...unresolvedManualRequests(requested+'\n')],['a']);
  assert.equal(unresolvedManualRequests(requested+'\n'+exited+'\n').size,0);
  assert.equal(unresolvedManualRequests(requested+'\n'+failed+'\n').size,0);
  assert.throws(()=>unresolvedManualRequests(requested+'\n{bad json\n'),/inspection required/);
});
