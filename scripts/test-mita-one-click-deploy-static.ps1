# Read-only source-contract checks. Never dot-source One-Click or contact Git/VPS.
$ErrorActionPreference = 'Stop'
function Assert-OneClick([bool]$condition, [string]$message) {
  if (!$condition) { throw $message }
}

$scriptPath = Join-Path $PSScriptRoot 'deploy-one-click.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
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
Assert-OneClick ($source.Contains('backend/scripts/migrate-vps-deploy-ledger.mjs')) 'One-Click ledger migration must be pinned to committed source'
Assert-OneClick ($source.Contains('backend/scripts/migrate-vps-amazon-quotes.mjs')) 'VPS checkout migration must be pinned to committed source'
Assert-OneClick ($source.Contains('Local HEAD changed after click') -and
  $source.Contains('Remote main changed after click')) 'Changed HEAD or remote must stop release'

$migrations = [regex]::Matches($source, '& node\.exe scripts/migrate-vps-title-revisions\.mjs \$migrationMode')
$sync = $source.IndexOf('scripts/sync-catalog-vps.mjs $mode')
Assert-OneClick ($migrations.Count -eq 2 -and $migrations[1].Index -lt $sync) 'VPS title migration must precede sync in both normal and migrations-only paths'
Assert-OneClick ($source.Contains("if (`$mode -eq '--dry-run' -or `$mode -eq '--migrations-dry-run') { '--dry-run' } else { '--apply' }")) 'Dry-run must not apply VPS migration'
Assert-OneClick ($source.Contains('VPS title revision migration failed; sync/release not attempted')) 'VPS migration errors must stop sync/deploy'
$checkoutMigrations = [regex]::Matches($source, '& node\.exe scripts/migrate-vps-amazon-quotes\.mjs \$migrationMode')
Assert-OneClick ($checkoutMigrations.Count -eq 2 -and $checkoutMigrations[1].Index -lt $sync) 'Checkout schema migration must precede sync in both normal and migrations-only paths'
Assert-OneClick ($source.Contains('VPS checkout schema migration failed; sync/release not attempted')) 'VPS checkout migration failure must block deployment'
$prepare = $source.IndexOf('    PrepareDeployLedger $migrationMode')
$modeBranch = $source.IndexOf("    if (`$mode -eq '--migrations' -or `$mode -eq '--migrations-dry-run')")
Assert-OneClick ($prepare -ge 0 -and $prepare -lt $modeBranch -and $modeBranch -lt $sync) 'Ledger preflight/migration must run before both normal sync and migrations-only branches'
Assert-OneClick (([regex]::Matches($source, 'PrepareDeployLedger \$migrationMode')).Count -eq 1) 'All modes must use the same ledger preparation gate exactly once'
Assert-OneClick (([regex]::Matches($source, '& node\.exe scripts/migrate-vps-deploy-ledger\.mjs')).Count -eq 2) 'Ledger commands must occur only in the shared helper (preflight and apply)'
$tunnelReady = $source.IndexOf("if(!`$ready) { throw 'SSH tunnel failed to open' }")
Assert-OneClick ($tunnelReady -ge 0 -and $tunnelReady -lt $prepare) 'Ledger preparation must follow owned SSH tunnel readiness'
Assert-OneClick ($source.Contains('StrictHostKeyChecking=yes') -and $source.Contains('Where-Object OwningProcess -eq $tunnel.Id')) 'SSH host and tunnel ownership guards must remain'
Assert-OneClick ($source.Contains('if(!$DryRun -and !$MigrationsOnly) {') -and
  $source.Contains("RunChecked 'Apply local additive schema'")) 'Dry-run must continue to skip local schema writes'

# Execute only the parsed ledger helper with an in-memory node mock. Never load
# the deploy entry point, open a tunnel, read credentials or connect to a DB.
$helper = $ast.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'PrepareDeployLedger'
}, $true)
Assert-OneClick ($null -ne $helper) 'Missing ledger preparation helper'
& {
  param($definition)
  . ([scriptblock]::Create($definition))
  function node.exe([string]$tool, [string]$mode) {
    Assert-OneClick ($tool -eq 'scripts/migrate-vps-deploy-ledger.mjs') 'Unexpected command in ledger preparation'
    $script:ledgerCalls.Add($mode)
    $global:LASTEXITCODE = if ($mode -eq $script:ledgerFailMode) { 1 } else { 0 }
    if ($mode -eq '--dry-run') { $script:ledgerOutput }
    elseif ($mode -eq '--apply') {
      # Mimic the table existing after the first successful migration.
      $script:ledgerOutput = '{"state":"dry_run","ledger":"catalog_deploy_ledger"}'
      '{"state":"DEPLOY_LEDGER_MIGRATION_OK"}'
    }
  }
  $oldExitCode = $global:LASTEXITCODE
  try {
    $missing = '{"state":"dry_run","ledger":null}'
    $existing = '{"state":"dry_run","ledger":"catalog_deploy_ledger"}'
    foreach ($case in @(
      @{ Mode='--dry-run'; Output=$missing; Fail=''; Expected='--dry-run'; Error='' },
      @{ Mode='--dry-run'; Output=$existing; Fail=''; Expected='--dry-run'; Error='' },
      @{ Mode='--apply'; Output=$missing; Fail=''; Expected='--dry-run,--apply'; Error='' },
      @{ Mode='--apply'; Output=$existing; Fail=''; Expected='--dry-run'; Error='' },
      @{ Mode='--apply'; Output='{"ledger":"public.catalog_deploy_ledger","state":"dry_run"}'; Fail=''; Expected='--dry-run'; Error='' },
      @{ Mode='--apply'; Fail='--dry-run'; Expected='--dry-run'; Error='preflight failed' },
      @{ Mode='--apply'; Fail='--apply'; Expected='--dry-run,--apply'; Error='migration failed' },
      @{ Mode='--dry-run'; Fail='--dry-run'; Expected='--dry-run'; Error='preflight failed' },
      @{ Mode='invalid'; Fail=''; Expected=''; Error='Invalid deploy ledger migration mode' }
    )) {
      $script:ledgerCalls = New-Object 'System.Collections.Generic.List[string]'
      $script:ledgerFailMode = $case.Fail
      $script:ledgerOutput = if ($case.ContainsKey('Output')) { $case.Output } else { $missing }
      $failure = ''
      try { PrepareDeployLedger $case.Mode } catch { $failure = $_.Exception.Message }
      Assert-OneClick (($script:ledgerCalls -join ',') -eq $case.Expected) "Ledger command order mismatch: $($case.Mode)/$($case.Fail)"
      if ($case.Error) {
        Assert-OneClick ($failure.Contains($case.Error)) "Ledger failure did not stop preparation: $($case.Error)"
      } else { Assert-OneClick (!$failure) "Unexpected ledger failure: $failure" }
    }
    foreach ($invalid in @('', 'not json', 'null', '[]', '[{"state":"dry_run","ledger":null}]',
      '{"state":"wrong","ledger":null}', '{"state":"dry_run"}',
      '{"state":"dry_run","ledger":"other_table"}', '{"state":"dry_run","ledger":false}',
      '{"state":"dry_run","ledger":""}', '{"state":"dry_run","ledger":"CATALOG_DEPLOY_LEDGER"}',
      '{"state":"dry_run","ledger":null,"extra":true}',
      '{"state":"dry_run","ledger":null,"ledger":null}',
      ($missing + "`n" + $missing), ('log line' + "`n" + $missing))) {
      foreach ($mode in @('--apply', '--dry-run')) {
        $script:ledgerCalls.Clear(); $script:ledgerFailMode = ''; $script:ledgerOutput = $invalid
        $failure = ''
        try { PrepareDeployLedger $mode } catch { $failure = $_.Exception.Message }
        Assert-OneClick ($failure.Contains('Invalid VPS One-Click ledger preflight output')) 'Invalid preflight must fail closed'
        Assert-OneClick (($script:ledgerCalls -join ',') -eq '--dry-run') 'Invalid output must never trigger DDL'
      }
    }
    $script:ledgerCalls.Clear(); $script:ledgerFailMode = ''; $script:ledgerOutput = $missing
    PrepareDeployLedger '--apply'
    PrepareDeployLedger '--apply'
    Assert-OneClick (($script:ledgerCalls -join ',') -eq '--dry-run,--apply,--dry-run') 'Existing ledger must skip DDL after first apply'
  } finally {
    $global:LASTEXITCODE = $oldExitCode
    Remove-Variable ledgerCalls,ledgerFailMode,ledgerOutput -Scope Script
  }
} $helper.Extent.Text
Assert-OneClick ($source.Contains("'--deploy-apply'")) 'One-Click must use repeated-deploy sync mode, not daily --apply'
Assert-OneClick ($source.Contains("'--migrations-dry-run'")) 'Dry-run migration mode must remain accessible without writes'

Assert-OneClick ($workflow.Contains('release_sha:') -and $workflow.Contains('request_id:')) 'Workflow must require immutable SHA and unique request ID'
Assert-OneClick ($workflow.Contains("github.ref == 'refs/heads/main'") -and
  $workflow.Contains('inputs.release_sha == github.sha')) 'Workflow must reject non-main or wrong SHA dispatch'
Assert-OneClick ($workflow.Contains('name: Deploy exactly this commit to Hermes') -and
  $workflow.Contains("if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch'")) 'Pinned dispatch must actually deploy (not just build)'
Assert-OneClick ($source.Contains('gh.exe workflow run mita-deploy.yml --ref main') -and
  $source.Contains('"release_sha=$clickSha"') -and $source.Contains('"request_id=$requestId"')) 'One-Click dispatch must provide SHA and request ID'
Assert-OneClick ($source.Contains('Mita One-Click $requestId') -and $source.Contains('CI run identity mismatch')) 'One-Click must identify its exact workflow run'
Assert-OneClick ($source.Contains('$oldPushRunIds') -and $source.Contains('databaseId -notin $oldPushRunIds')) 'A previous push run must not be accepted as this release'

Write-Output 'PASS: One-Click PowerShell parser, mocked ledger success/failure and dry-run, migration order, pinned committed SHA and guarded workflow contracts.'
