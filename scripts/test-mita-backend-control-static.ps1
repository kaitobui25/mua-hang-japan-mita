# Safe checks only: never execute the helper, a process job, a DB command or npm.
$ErrorActionPreference='Stop'
function Assert-Backend($condition,[string]$message) { if (!$condition) { throw $message } }
$path=Join-Path $PSScriptRoot 'mita-backend-control.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
Assert-Backend ($errors.Count -eq 0) 'PowerShell parser errors'
$bytes=[IO.File]::ReadAllBytes($path)
Assert-Backend ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'Helper requires UTF-8 BOM for PowerShell 5.1'
$source=[IO.File]::ReadAllText($path)
Assert-Backend ($source -notmatch '(?im)^\s*(Stop-Process|Stop-Service|Restart-Service|Invoke-Expression|Start-Job)\b') 'Forbidden control command'
Assert-Backend ($source -notmatch '(?i)db:migrate|initdb\.exe|start-local\.ps1[''"\s]*\)') 'Forbidden DB initialization/migration or broad launcher'
foreach ($required in @('OnlyIfSessionOwned','InstallDependenciesConfirmed','GetOwnerSid','StartedAt','CommandLine','AddSeconds(30)','wrapper-exited-no-restart','127.0.0.1:5433','postmaster.pid','Assert-ExistingLocalDatabase','SHOW data_directory','-WindowStyle Hidden')) {
    Assert-Backend ($source.Contains($required)) "Missing lifecycle safety contract: $required"
}
Add-Type -Path (Join-Path $PSScriptRoot 'mita-backend-job.cs')
# Compile the containment class but never instantiate it.
$native=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mita-backend-job.cs'))
Assert-Backend ($native.Contains('0x08000004') -and $native.Contains('0x2000')) 'Suspended launch and kill-on-close job limits required'
Assert-Backend ($native.IndexOf('if (!AssignProcessToJobObject') -lt $native.IndexOf('if (ResumeThread')) 'Job assignment must precede resume'

# Exercise the actual stop function with inert in-memory mocks, not the helper entrypoint.
$stopFunction=$ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-OwnedBackend' },$true)
. ([scriptblock]::Create($stopFunction.Extent.Text))
$script:signals=0; $script:checks=0
function Get-BackendOwner {
    $script:checks++
    if ($script:checks -eq 1) { return [pscustomobject]@{ RunId='owned-run' } }
    return $null
}
function Set-Content { param($LiteralPath,$Value,$Encoding) $script:signals++ }
function Write-BackendAudit { param($result) }
$runtime='unused'; $SessionId='desktop-a'; $OnlyIfSessionOwned=$true
$record=[pscustomobject]@{ RunId='owned-run'; SessionId='desktop-b' }
Stop-OwnedBackend $record
Assert-Backend ($script:signals -eq 0 -and $script:checks -eq 0) 'Desktop close must leave another session untouched'
$record.SessionId='desktop-a'
Stop-OwnedBackend $record
Assert-Backend ($script:signals -eq 1 -and $script:checks -eq 2) 'Matching session must signal reverified owner only'
$script:signals=0; $script:checks=0; $record.RunId='reused-run'
$rejected=$false
try { Stop-OwnedBackend $record } catch { $rejected=$true }
Assert-Backend ($rejected -and $script:signals -eq 0) 'Ownership change must refuse shutdown'

# Windows can reuse a departed wrapper PID. A stale record must be ignored,
# without signaling or inspecting the unrelated replacement process.
$ownerFunction=$ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-BackendOwner' },$true)
. ([scriptblock]::Create($ownerFunction.Extent.Text))
$root='fixture-root'; $sid='fixture-windows-user'; $recordPath=[IO.Path]::GetTempFileName()
$script:cimTouched=$false
function Get-Process { param($Id,$ErrorAction) [pscustomobject]@{ ProcessName='powershell'; StartTime=[datetime]::UtcNow } }
function Get-CimInstance { $script:cimTouched=$true; throw 'CIM should not inspect reused PID' }
try {
    $stale=@{ Root=$root; UserSid=$sid; SessionId='desktop-a'; RunId=('a'*32);
        Id=43210; StartedAt=[datetime]::UtcNow.AddDays(-2).ToString('o') }
    [IO.File]::WriteAllText($recordPath,($stale | ConvertTo-Json))
    Assert-Backend ($null -eq (Get-BackendOwner) -and !$script:cimTouched) 'Stale PID must not be adopted or queried as owner'
} finally { [IO.File]::Delete($recordPath) }

# A stale postmaster.pid can point to a new PostgreSQL process. Matching PID
# and executable are insufficient: reject a different actual data directory.
$identityFunction=$ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-MitaPostgresIdentity' },$true)
. ([scriptblock]::Create($identityFunction.Extent.Text))
$bin=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin'
$data=(Resolve-Path (Join-Path $PSScriptRoot '../backend/.local-db')).Path
$fakeProcess=[pscustomobject]@{ ExecutablePath=(Join-Path $bin 'postgres.exe'); CommandLine='"postgres.exe" -D "backend/.local-db" -p 5433' }
Assert-MitaPostgresIdentity $fakeProcess $bin $data $data
$rejected=$false
try { Assert-MitaPostgresIdentity $fakeProcess $bin $data (Join-Path $PSScriptRoot '..') } catch { $rejected=$true }
Assert-Backend $rejected 'A reused listener PID with a different PostgreSQL data directory must be rejected'
$fakeProcess.ExecutablePath=Join-Path $bin 'unrelated.exe'
$rejected=$false
try { Assert-MitaPostgresIdentity $fakeProcess $bin $data $data } catch { $rejected=$true }
Assert-Backend $rejected 'Listener executable must be the expected PostgreSQL binary'
Write-Output 'PASS: PS5.1 parse, C# compile, safety contracts and mocked session/ownership stop checks. No live service actions.'
