# Read-only source-contract checks. Never dot-source One-Click or contact Git/VPS.
$ErrorActionPreference = 'Stop'
function Assert-OneClick([bool]$condition, [string]$message) {
  if (!$condition) { throw $message }
}

$scriptPath = Join-Path $PSScriptRoot 'deploy-one-click.ps1'
$tokens = $null; $errors = $null
[Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
Assert-OneClick ($errors.Count -eq 0) 'One-Click PowerShell parser errors'
$source = [IO.File]::ReadAllText($scriptPath)
$workflow = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\.github\workflows\mita-deploy.yml'))

$pin = $source.IndexOf("rev-parse --verify 'HEAD^{commit}'")
$auth = $source.IndexOf("RunChecked 'GitHub authentication'")
Assert-OneClick ($pin -ge 0 -and $pin -lt $auth) 'Committed SHA must be pinned before network/DB operations'
Assert-OneClick ($source -notmatch '(?i)CallGit\s+@\(''(?:add|commit|reset|stash)''') 'One-Click must not stage/commit/reset/stash files'
Assert-OneClick ($source -notmatch '(?i)git\.exe\s+(?:add|commit|reset|stash)\b') 'One-Click must not mutate the index'
Assert-OneClick ($source.Contains('${clickSha}:refs/heads/main')) 'Push must reference pinned SHA, not mutable main'
Assert-OneClick ($source.Contains('--force-with-lease=refs/heads/main:$remoteAtStart')) 'Push must reject a concurrent remote main update'
Assert-OneClick ($source.Contains('git.exe diff --quiet $clickSha -- @dataCode')) 'Data-sync executable files must match pinned commit'
Assert-OneClick ($source.Contains('Local HEAD changed after click') -and
  $source.Contains('Remote main changed after click')) 'Changed HEAD or remote must stop release'

$migrations = [regex]::Matches($source, '& node\.exe scripts/migrate-vps-title-revisions\.mjs \$migrationMode')
$sync = $source.IndexOf('scripts/sync-catalog-vps.mjs $mode')
Assert-OneClick ($migrations.Count -eq 2 -and $migrations[1].Index -lt $sync) 'VPS title migration must precede sync in both normal and migrations-only paths'
Assert-OneClick ($source.Contains("if (`$mode -eq '--dry-run') { '--dry-run' } else { '--apply' }")) 'Dry-run must not apply VPS migration'
Assert-OneClick ($source.Contains('VPS title revision migration failed; sync/release not attempted')) 'VPS migration errors must stop sync/deploy'

Assert-OneClick ($workflow.Contains('release_sha:') -and $workflow.Contains('request_id:')) 'Workflow must require immutable SHA and unique request ID'
Assert-OneClick ($workflow.Contains("github.ref == 'refs/heads/main'") -and
  $workflow.Contains('inputs.release_sha == github.sha')) 'Workflow must reject non-main or wrong SHA dispatch'
Assert-OneClick ($workflow.Contains('name: Deploy exactly this commit to Hermes') -and
  $workflow.Contains("if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch'")) 'Pinned dispatch must actually deploy (not just build)'
Assert-OneClick ($source.Contains('gh.exe workflow run mita-deploy.yml --ref main') -and
  $source.Contains('"release_sha=$clickSha"') -and $source.Contains('"request_id=$requestId"')) 'One-Click dispatch must provide SHA and request ID'
Assert-OneClick ($source.Contains('Mita One-Click $requestId') -and $source.Contains('CI run identity mismatch')) 'One-Click must identify its exact workflow run'
Assert-OneClick ($source.Contains('$oldPushRunIds') -and $source.Contains('databaseId -notin $oldPushRunIds')) 'A previous push run must not be accepted as this release'

Write-Output 'PASS: One-Click PowerShell parser, migration order, pinned committed SHA and guarded workflow contracts.'
