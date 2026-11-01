# Local-only PowerShell 5.1 parser, source contracts and inert function mocks.
# Never executes a helper entrypoint, supervisor, network/DB probe or sync.
$ErrorActionPreference='Stop'
function Assert-Sync($condition,[string]$message) { if (!$condition) { throw $message } }
function Assert-Rejected([scriptblock]$operation,[string]$message) {
    $rejected=$false
    try { & $operation | Out-Null } catch { $rejected=$true }
    Assert-Sync $rejected $message
}
$path=Join-Path $PSScriptRoot 'mita-sync-control.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
Assert-Sync ($errors.Count -eq 0) 'Helper parser errors'
$bytes=[IO.File]::ReadAllBytes($path)
Assert-Sync ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'UTF-8 BOM required for PS5.1'
$source=[IO.File]::ReadAllText($path)
Assert-Sync ($source -notmatch '(?im)^\s*(Start-Process|Stop-Process|Start-Service|Stop-Service|Restart-Service|Invoke-Expression|Remove-Item|Set-Content|Add-Content)\b') 'Helper must only use coordinator IPC and identity reads'
foreach ($marker in @('GetOwnerSid','StartedAt','CommandLine','mita-sync-v1')) {
    Assert-Sync ($source.Contains($marker)) "Missing helper contract: $marker"
}
foreach ($name in @('Assert-SyncRequest','Assert-SyncReply','Get-SyncCoordinator')) {
    $definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    Assert-Sync ($null -ne $definition) "Missing function $name"
    . ([scriptblock]::Create($definition.Extent.Text))
}
$Action='Status'; $Confirmed=$false; $ForceRerunConfirmed=$false; $SessionId=$null
Assert-SyncRequest
$Action='SyncNow'
Assert-Rejected { Assert-SyncRequest } 'Unconfirmed sync accepted'
$Confirmed=$true; $SessionId='desktop-a'; $CookieHeader='mita_admin='+('a'*64); $CsrfToken='b'*64
Assert-SyncRequest
$CookieHeader='owner'
Assert-Rejected { Assert-SyncRequest } 'Role string treated as authorization'
$CookieHeader='mita_admin='+('a'*64); $ForceRerunConfirmed=$true
Assert-Rejected { Assert-SyncRequest } 'Force replay accepted'
$ForceRerunConfirmed=$false

$root='C:\mock-mita'; $supervisorPath=Join-Path $root 'scripts/mita-supervisor.mjs'; $recordPath='mock-record'
$started=[datetime]'2026-11-01T00:00:00Z'
$record=[pscustomobject]@{ Root=$root; Script='mita-supervisor.mjs'; Id=123; StartedAt=$started.ToUniversalTime().ToString('o') }
$script:processName='node'; $script:listenerPid=123; $script:ownerReturn=0; $script:startTime=$started
function Test-Path { param($LiteralPath,$PathType) return $true }
function Get-Content { param($LiteralPath,[switch]$Raw,$Encoding) return ($record | ConvertTo-Json) }
function Get-Process { param($Id,$ErrorAction) return [pscustomobject]@{ ProcessName=$script:processName; StartTime=$script:startTime } }
function Get-CimInstance { param($Filter,$ErrorAction) return [pscustomobject]@{ CommandLine=('node.exe "'+$supervisorPath+'"'); ExecutablePath='C:\node\node.exe' } }
function Invoke-CimMethod { param($InputObject,$MethodName,$ErrorAction) return [pscustomobject]@{ReturnValue=$script:ownerReturn; Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} }
function Get-NetTCPConnection { param($State,$ErrorAction) return [pscustomobject]@{LocalPort=19978; LocalAddress='127.0.0.1'; OwningProcess=$script:listenerPid} }
$null=Get-SyncCoordinator
$script:startTime=$started.AddSeconds(1)
Assert-Rejected { Get-SyncCoordinator } 'Reused supervisor PID accepted'
$script:startTime=$started; $script:listenerPid=999
Assert-Rejected { Get-SyncCoordinator } 'Foreign listener accepted'
$script:listenerPid=123; $script:ownerReturn=2
Assert-Rejected { Get-SyncCoordinator } 'Unknown Windows owner accepted'
$script:ownerReturn=0
$run='11111111-1111-4111-8111-111111111111'
$nightlyPath=Join-Path $PSScriptRoot 'nightly-vps-sync.ps1'
$reply=[pscustomobject]@{ok=$true;protocol='mita-sync-v1';root=$root;pid=123;supervisorRunId=$run;state='accepted';owner=[pscustomobject]@{
    supervisorRunId=$run;supervisorPid=123;runId=$run;pid=456;sessionId='desktop-a';script=(Join-Path $PSScriptRoot 'nightly-vps-sync.ps1') }}
Assert-SyncReply $reply $record
$reply.owner.sessionId='desktop-b'
Assert-Rejected { Assert-SyncReply $reply $record } 'Different session run adopted'
$reply.owner.sessionId='desktop-a'; $reply.owner.pid=0
Assert-Rejected { Assert-SyncReply $reply $record } 'Missing child PID accepted'
$reply.protocol='legacy'
Assert-Rejected { Assert-SyncReply $reply $record } 'Legacy banner-only supervisor accepted'

# Imports are side-effect free: do not call runSupervisor/main or any adapter.
$js=@'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertManualSyncReady,assertOwnerSession,assertSyncInventory,acquireSyncLease} from './scripts/mita-supervisor.mjs';
const day='2026-11-01';
const snapshot=()=>({day,sync:{state:'pending'},jobs:Object.fromEntries(['amazon','names','detail'].map(name=>[name,{day,state:'completed'}]))});
assertManualSyncReady(snapshot(),day);
for(const state of ['completed','partial','running','failed','unknown','deferred','skipped',undefined]){
  const s=snapshot();s.sync.state=state;assert.throws(()=>assertManualSyncReady(s,day));
}
for(const name of ['amazon','names','detail']){
  for(const state of ['running','unknown',undefined]){const s=snapshot();s.jobs[name].state=state;assert.throws(()=>assertManualSyncReady(s,day));}
  const s=snapshot();s.jobs[name].day='2026-10-31';assert.throws(()=>assertManualSyncReady(s,day));
  for(const state of ['completed','partial','failed','skipped']){const s=snapshot();s.jobs[name].state=state;assertManualSyncReady(s,day);}
}
const skipped=snapshot();Object.values(skipped.jobs).forEach(job=>job.state='skipped');assert.throws(()=>assertManualSyncReady(skipped,day));
const csrf='b'.repeat(64),session={role:'owner',csrfToken:csrf,expiresAt:'2099-01-01T00:00:00Z'};
assertOwnerSession(session,csrf);
for(const bad of [{...session,role:'staff'},{...session,csrfToken:'c'.repeat(64)},{...session,expiresAt:'2000-01-01'},{...session,expiresAt:'garbage'},null])assert.throws(()=>assertOwnerSession(bad,csrf));
const process=(CommandLine,ProcessId=1,Name='node.exe')=>({CommandLine,ProcessId,Name});
const inventory=processes=>({processes,tunnels:[]});
assertSyncInventory(inventory([process('node src/worker.ts daily')]),[1]);
assert.throws(()=>assertSyncInventory(inventory([process('node src/worker.ts daily')]),[]));
assert.throws(()=>assertSyncInventory({processes:[],tunnels:[{}]},[]));
for(const command of ['powershell nightly-vps-sync.ps1','node sync-catalog-vps.mjs --apply','powershell sync-mita-reviews.ps1','powershell start-vps-worker.ps1',''])assert.throws(()=>assertSyncInventory(inventory([process(command)]),[]));
assert.throws(()=>assertSyncInventory(inventory([process('ssh -L 15432:localhost:5432',1,'ssh.exe')]),[]));
assert.throws(()=>assertSyncInventory(null,[]));
const mockClient=failAt=>{
  const calls=[];let attempts=0;const handlers={};
  return {calls,handlers,on:(event,handler)=>{handlers[event]=handler;},connect:async()=>{},end:async()=>calls.push('end'),query:async(sql,args)=>{
    calls.push([sql,args]);return {rows:[{ok:sql.includes('pg_try')?++attempts!==failAt:true}]};
  }};
};
const client=mockClient(0),lease=await acquireSyncLease(client);
assert.equal(client.calls.filter(call=>Array.isArray(call)&&call[0].includes('pg_try')).length,3);
assert.equal(client.calls.some(call=>Array.isArray(call)&&call[0].includes('unlock')),false,'leases must remain held during transfer');
client.handlers.error();assert.equal(lease.lost,true);
await lease.release();assert.equal(client.calls.filter(call=>Array.isArray(call)&&call[0].includes('unlock')).length,3);
for(const failAt of [1,2,3]){
  const busy=mockClient(failAt);await assert.rejects(acquireSyncLease(busy),/Worker lock is busy/);
  assert.equal(busy.calls.filter(call=>Array.isArray(call)&&call[0].includes('unlock')).length,failAt-1);
  assert.equal(busy.calls.at(-1),'end');
}
const supervisor=readFileSync('scripts/mita-supervisor.mjs','utf8');
for(const marker of ['acquireSyncLease()','await syncInventory','await authorizeSync(manual.cookie,manual.csrf)','lease.release()','forceRerunSupported:false','canStop:false','syncDispatching','supervisorRunId','reserveTunnel(randomUUID())','openSync(TUNNEL_LEASE','releaseTunnel()'])assert.ok(supervisor.includes(marker),marker);
const transfer=readFileSync('backend/scripts/sync-catalog-vps.mjs','utf8');
assert.ok(transfer.includes('ON CONFLICT(sync_day) DO NOTHING'));
assert.ok(!/DELETE FROM catalog_sync_ledger|ON CONFLICT\(sync_day\) DO UPDATE/i.test(transfer));
console.log('PASS: inert coordinator policy, authorization, inventory and ledger contracts.');
'@
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $js | & node.exe --input-type=module
    Assert-Sync ($LASTEXITCODE -eq 0) 'Coordinator policy tests failed'
} finally { Pop-Location }
Write-Output 'PASS: PS5.1 parse, confirmation, identity and session mocks. No live sync, DB, SSH or service actions.'
