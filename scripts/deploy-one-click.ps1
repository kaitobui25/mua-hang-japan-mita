param([switch]$DryRun, [switch]$DataOnly, [switch]$MigrationsOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.agents/runtime'
$tunnel = $null
$tunnelStart = $null
$oldSecret = [Environment]::GetEnvironmentVariable('MITA_VPS_DATABASE_URL', 'Process')
$script:expectedPublicTotal = 0

function RunChecked([string]$label, [scriptblock]$command) {
  Write-Host ('[RUN] ' + $label) -ForegroundColor Cyan
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit=$LASTEXITCODE)" }
}

function CallGit([string[]]$arguments) {
  & git.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "git $($arguments -join ' ') failed" }
}

function PrepareDeployLedger([string]$migrationMode) {
  if ($migrationMode -notin @('--dry-run', '--apply')) { throw 'Invalid deploy ledger migration mode' }
  # Reviewed, additive CREATE TABLE IF NOT EXISTS only; no ledger rows are reset.
  # Keep DDL explicit here, outside catalog sync and its shared writer lock.
  Write-Host '[PREFLIGHT] One-Click deploy ledger (read-only).'
  $preflightOutput = @(& node.exe scripts/migrate-vps-deploy-ledger.mjs --dry-run)
  if ($LASTEXITCODE -ne 0) { throw 'VPS One-Click ledger preflight failed; sync/release not attempted' }
  $json = $preflightOutput -join "`n"
  # Accept exactly the CLI's two-field JSON object, without logs, duplicate keys,
  # extra fields or coercion. regclass may return a schema-qualified table name.
  $stateField = '"state"\s*:\s*"dry_run"'
  $ledgerField = '"ledger"\s*:\s*(?:null|"(?:public\.)?catalog_deploy_ledger")'
  $shape = '\A\s*\{\s*(?:' + $stateField + '\s*,\s*' + $ledgerField + '|' + $ledgerField + '\s*,\s*' + $stateField + ')\s*\}\s*\z'
  if ($json -cnotmatch $shape) { throw 'Invalid VPS One-Click ledger preflight output; sync/release not attempted' }
  $preflight = $json | ConvertFrom-Json -ErrorAction Stop
  if ($preflight.state -cne 'dry_run' -or ($null -ne $preflight.ledger -and
      $preflight.ledger -cnotin @('catalog_deploy_ledger', 'public.catalog_deploy_ledger'))) {
    throw 'Invalid VPS One-Click ledger preflight output; sync/release not attempted'
  }
  Write-Output $json
  if ($null -ne $preflight.ledger) {
    Write-Host '[OK] One-Click deploy ledger exists; migration skipped.'
    return
  }
  if ($migrationMode -eq '--dry-run') {
    Write-Host '[DRY RUN] One-Click deploy ledger missing; migration would be needed (no writes).'
    return
  }
  if ($migrationMode -eq '--apply') {
    Write-Host '[MIGRATION] Ensure One-Click deploy ledger exists (idempotent, transactional, 5s lock timeout).'
    & node.exe scripts/migrate-vps-deploy-ledger.mjs --apply
    if ($LASTEXITCODE -ne 0) { throw 'VPS One-Click ledger migration failed; sync/release not attempted' }
  }
}

function SyncVpsData([string]$mode) {
  $path = Join-Path $runtime 'mita-vps-database-url.dpapi'
  if (!(Test-Path -LiteralPath $path)) { throw 'Missing DPAPI VPS database credential file' }
  if (Get-NetTCPConnection -State Listen -LocalPort 15432 -ErrorAction SilentlyContinue) {
    throw 'SSH port 15432 already in use. Stop another tunnel before deploying.'
  }
  if ((Get-Service ssh-agent).Status -ne 'Running') { throw 'ssh-agent is not running' }
  $key = Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
  if (!(Test-Path -LiteralPath $key) -or !(Test-Path -LiteralPath "$key.pub")) { throw 'Hermes SSH key files missing' }
  $fingerprintText = (& ssh-keygen.exe -lf "$key.pub" 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or $fingerprintText -notmatch 'SHA256:[A-Za-z0-9+/]+') { throw 'Cannot verify SSH fingerprint' }
  $fingerprint = $Matches[0]
  $agentKeys = (& ssh-add.exe -l 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or !$agentKeys.Contains($fingerprint)) {
    throw 'Load your existing Hermes key in ssh-agent first; no passphrase prompt is possible during silent deploy.'
  }
  $encrypted = (Get-Content -LiteralPath $path -Raw).Trim() | ConvertTo-SecureString
  $handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($encrypted)
  try { $env:MITA_VPS_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle) }

  $stderr = Join-Path $runtime 'deploy-ssh.err.log'
  $args = @('-N','-T','-L','127.0.0.1:15432:127.0.0.1:5432',
    '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=12','-o','ServerAliveInterval=15',
    '-o','ServerAliveCountMax=3','-i',('"'+$key+'"'),'ubuntu@217.142.225.255')
  $script:tunnel = Start-Process ssh.exe -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardError $stderr
  $script:tunnelStart = $tunnel.StartTime
  $ready=$false
  for($i=0;$i -lt 48;$i++) {
    $tunnel.Refresh()
    if($tunnel.HasExited) { throw 'SSH tunnel exited; read deploy-ssh.err.log' }
    if(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 15432 -ErrorAction SilentlyContinue |
      Where-Object OwningProcess -eq $tunnel.Id) { $ready=$true; break }
    Start-Sleep -Milliseconds 250
  }
  if(!$ready) { throw 'SSH tunnel failed to open' }
  Write-Host '[OK] SSH tunnel to PostgreSQL VPS established.' -ForegroundColor Green
  Push-Location (Join-Path $root 'backend')
  try {
    Write-Host "[DATA] Database sync phase: $mode"
    $migrationMode = if ($mode -eq '--dry-run' -or $mode -eq '--migrations-dry-run') { '--dry-run' } else { '--apply' }
    PrepareDeployLedger $migrationMode
    if ($mode -eq '--migrations' -or $mode -eq '--migrations-dry-run') {
      & node.exe scripts/migrate-vps-translation.mjs $migrationMode
      if ($LASTEXITCODE -ne 0) { throw 'VPS translation migration failed; sync/release not attempted' }
      & node.exe scripts/migrate-vps-sync-ledger.mjs $migrationMode
      if ($LASTEXITCODE -ne 0) { throw 'VPS ledger migration failed; sync/release not attempted' }
      & node.exe scripts/migrate-vps-title-revisions.mjs $migrationMode
      if ($LASTEXITCODE -ne 0) { throw 'VPS title revision migration failed; sync/release not attempted' }
    } else {
      & node.exe scripts/migrate-vps-title-revisions.mjs $migrationMode
      if ($LASTEXITCODE -ne 0) { throw 'VPS title revision migration failed; sync/release not attempted' }
      & node.exe scripts/sync-catalog-vps.mjs $mode
      if($LASTEXITCODE -ne 0) { throw "VPS catalog $mode failed; code release NOT pushed" }
    }
  } finally { Pop-Location }
}

function VerifyPublic([string]$sha) {
  $base='https://mitajapanshop.duckdns.org'
  Write-Host '[CHECK] Live HTTPS catalog and product detail...'
  $homePage = Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 20
  if($homePage.StatusCode -ne 200) { throw 'Homepage did not return HTTP 200' }
  $catalog = Invoke-RestMethod -Uri "$base/api/catalog?page=1&limit=1" -TimeoutSec 20
  if(!($catalog.items -is [array]) -or $catalog.items.Count -ne 1 -or
      [int]$catalog.total -lt $script:expectedPublicTotal) {
    throw "Public catalog count mismatch: $($catalog.total) < expected $($script:expectedPublicTotal)"
  }
  $asin = [string]$catalog.items[0].asin
  $detail=Invoke-RestMethod -Uri "$base/api/catalog/products/$asin" -TimeoutSec 20
  if(!$detail -or (!$detail.asin -and !$detail.id)) { throw "Public detail $asin missing" }
  foreach($route in @('/admin/login','/api/admin/session')) {
    $status = & curl.exe -sS -o NUL -w '%{http_code}' --connect-timeout 8 --max-time 16 ($base+$route)
    if($LASTEXITCODE -ne 0 -or $status -ne '404') { throw "Private route $route exposed or unavailable: HTTP $status" }
  }
  $checkoutPage = Invoke-WebRequest -Uri "$base/thanh-toan" -UseBasicParsing -TimeoutSec 20
  if($checkoutPage.StatusCode -ne 200) { throw 'Public checkout page not available' }
  $invalidCheckout = & curl.exe -sS -o NUL -w '%{http_code}' --connect-timeout 8 --max-time 16 -H 'Content-Type: application/json' -d '{}' "$base/api/checkout"
  if($LASTEXITCODE -ne 0 -or $invalidCheckout -ne '422') { throw "Public checkout validation not enabled: HTTP $invalidCheckout" }
  $other=Invoke-WebRequest -Uri 'https://ekaiwa.duckdns.org/' -UseBasicParsing -TimeoutSec 20
  if($other.StatusCode -ne 200) { throw 'E-KAIWA regression: not HTTP 200' }
  $releaseInfo = & ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 ubuntu@217.142.225.255 cat /opt/mita/current/release-info.json
  if($LASTEXITCODE -ne 0) { throw 'Cannot verify VPS deployed release' }
  $release = ($releaseInfo -join "`n") | ConvertFrom-Json
  if($release.revision -ne $sha) { throw "VPS revision mismatch: $($release.revision) expected $sha" }
  Write-Host "[OK] VPS release $($release.version) @ $sha" -ForegroundColor Green
  Write-Host "[OK] Public catalog $($catalog.total) cards, checkout active and validated; E-KAIWA OK; admin blocked" -ForegroundColor Green
}

try {
  Set-Location $root
  if ($MigrationsOnly -and $DataOnly) { throw 'MigrationsOnly cannot be combined with DataOnly' }
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Write-Host ('=== MITA ONE-CLICK DEPLOY ' + (Get-Date -Format o) + ' ===') -ForegroundColor Cyan
  if((git branch --show-current).Trim() -ne 'main') { throw 'Deploy requires main branch' }
  # Freeze the already committed source immediately. Staged/untracked edits are never published.
  $clickSha = (& git.exe rev-parse --verify 'HEAD^{commit}').Trim()
  if ($LASTEXITCODE -ne 0 -or $clickSha -notmatch '^[0-9a-f]{40}$') { throw 'Cannot identify the committed HEAD at click time' }
  Write-Host "[SOURCE] Pinned committed HEAD: $clickSha"
  if(!(Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw 'GitHub CLI gh.exe is required' }
  RunChecked 'GitHub authentication' { gh.exe auth status 1>$null }
  RunChecked 'Fetch remote main' { git.exe fetch origin main }
  RunChecked 'Check pinned history contains origin/main' { git.exe merge-base --is-ancestor origin/main $clickSha }
  $remoteAtStart = (& git.exe rev-parse --verify origin/main).Trim()
  if ($LASTEXITCODE -ne 0 -or $remoteAtStart -notmatch '^[0-9a-f]{40}$') { throw 'Cannot identify fetched remote main' }
  $clickMessage = (& git.exe log -1 --format=%B $clickSha) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read pinned commit message' }
  $taggedPush = $remoteAtStart -ne $clickSha -and $clickMessage.Contains('[deploy]')
  if (!$DryRun -and !$DataOnly -and !$MigrationsOnly -and !$taggedPush) {
    # The running script might itself be uncommitted; the pinned commit must
    # already contain the guarded manual deployment workflow before any DB write.
    $workflowAtClick = & git.exe show ('{0}:.github/workflows/mita-deploy.yml' -f $clickSha)
    if ($LASTEXITCODE -ne 0 -or ($workflowAtClick -join "`n") -notmatch 'inputs\.release_sha == github\.sha') {
      throw 'Commit the guarded One-Click workflow before deploying; no DB changes made'
    }
  }
  if (!$DryRun -and !$MigrationsOnly) {
    # These executable data tools must also match the click-time commit. Other
    # working-tree edits remain untouched and are not part of the release.
    $dataCode = @('scripts/deploy-one-click.ps1','backend/scripts/sync-catalog-vps.mjs',
      'backend/scripts/gallery-snapshot-policy.mjs','backend/scripts/migrate-vps-title-revisions.mjs',
      'backend/scripts/migrate-vps-deploy-ledger.mjs',
      'backend/src/db')
    & git.exe diff --quiet $clickSha -- @dataCode
    if ($LASTEXITCODE -ne 0) { throw 'Data sync/migration scripts differ from committed HEAD; commit them before One-Click' }
  }

  if(!$DryRun -and !$MigrationsOnly) {
    # Upgrade local source first, so newly introduced translation metadata is
    # present before copying. Migration is additive and idempotent.
    RunChecked 'Apply local additive schema' { npm.cmd run db:migrate --prefix backend }
  }

  SyncVpsData $(if($MigrationsOnly -and $DryRun) {'--migrations-dry-run'} elseif($MigrationsOnly) {'--migrations'} elseif($DryRun) {'--dry-run'} else {'--deploy-apply'})
  if ($MigrationsOnly) {
    Write-Host $(if($DryRun) {'[MIGRATIONS DRY RUN] No VPS writes.'} else {'[MIGRATIONS OK] VPS translation + nightly ledger + One-Click ledger + title revisions only; no catalog sync, commit or deploy.'}) -ForegroundColor Green
  } elseif($DryRun) {
    Write-Host '[DRY RUN PASSED] No Git push and no VPS database changes.' -ForegroundColor Green
  } else {
    # The sync connection remains open until validation; verify the exact row keys.
    Push-Location (Join-Path $root 'backend')
    try {
      $verify = & node.exe scripts/sync-catalog-vps.mjs --verify
      $verify | ForEach-Object { Write-Host $_ }
      if($LASTEXITCODE -ne 0) { throw 'Post-sync VPS data verification failed' }
      foreach($line in $verify) {
        if($line -match '^PUBLIC_EXPECTED_TOTAL=(\d+)$') { $script:expectedPublicTotal=[int]$Matches[1] }
      }
      if($script:expectedPublicTotal -le 0) { throw 'No positive expected public catalog total from DB verification' }
    } finally { Pop-Location }
    if($DataOnly) {
      Write-Host '[OK] Data synced and verified; code deployment skipped (-DataOnly).' -ForegroundColor Green
    } else {
      # Publish only the commit that existed at click time, never staged or
      # untracked files or a branch tip that changed while syncing data.
      $headNow = (& git.exe rev-parse --verify HEAD).Trim()
      if ($LASTEXITCODE -ne 0 -or $headNow -ne $clickSha) { throw 'Local HEAD changed after click; release stopped' }
      $remoteLines = @(& git.exe ls-remote origin refs/heads/main)
      $remoteMatch = if ($remoteLines.Count -eq 1) { [regex]::Match($remoteLines[0], '^([0-9a-f]{40})\s+refs/heads/main$') } else { $null }
      if ($LASTEXITCODE -ne 0 -or !$remoteMatch -or !$remoteMatch.Success) {
        throw 'Cannot verify current remote main; release stopped'
      }
      if ($remoteMatch.Groups[1].Value -ne $remoteAtStart) { throw 'Remote main changed after click; release stopped' }
      $oldPushRunIds = @()
      if ($taggedPush) {
        # A matching SHA alone is insufficient when an old push run exists.
        $oldPushRuns = & gh.exe run list --workflow mita-deploy.yml --commit $clickSha --event push --limit 100 --json databaseId
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect previous push runs; release stopped' }
        $oldPushRunIds = @(($oldPushRuns | ConvertFrom-Json) | ForEach-Object { [long]$_.databaseId })
      }
      if ($remoteAtStart -ne $clickSha) {
        # The exact remote lease forbids racing main updates; the fetched main
        # was already proven an ancestor of clickSha (no history rewrite).
        CallGit @('push',("--force-with-lease=refs/heads/main:$remoteAtStart"),'origin',("${clickSha}:refs/heads/main"))
        Write-Host "[PUSH OK] Previously committed source: $clickSha" -ForegroundColor Green
      } else { Write-Host "[PUSH SKIPPED] Remote already contains $clickSha" }
      $runEvent = if ($taggedPush) { 'push' } else { 'workflow_dispatch' }
      $requestId = [guid]::NewGuid().ToString('N')
      if ($runEvent -eq 'workflow_dispatch') {
        # The workflow rejects dispatches where main is no longer this SHA.
        RunChecked 'Dispatch pinned One-Click deployment' {
          gh.exe workflow run mita-deploy.yml --ref main -f "release_sha=$clickSha" -f "request_id=$requestId"
        }
      }
      $runId=$null
      for($attempt=0;$attempt -lt 30;$attempt++) {
        $runs = & gh.exe run list --workflow mita-deploy.yml --commit $clickSha --event $runEvent --limit 40 --json databaseId,headSha,headBranch,event,displayTitle,status,conclusion,url
        if($LASTEXITCODE -ne 0) { throw 'Cannot read GitHub Actions run status' }
        $entry=@(($runs | ConvertFrom-Json) | Where-Object {
          $_.headSha -eq $clickSha -and $_.headBranch -eq 'main' -and $_.event -eq $runEvent -and
          (($runEvent -eq 'push' -and [long]$_.databaseId -notin $oldPushRunIds) -or
           ($runEvent -eq 'workflow_dispatch' -and $_.displayTitle -eq "Mita One-Click $requestId"))
        } | Select-Object -First 1)
        if($entry.Count -gt 0) { $runId=[long]$entry[0].databaseId; break }
        Start-Sleep -Seconds 5
      }
      if(!$runId) { throw "No matching release workflow run for $clickSha; inspect GitHub Actions" }
      Write-Host "[CI] GitHub Actions run #$runId, monitoring build + Hermes deployment..."
      $complete=$false
      for($i=0;$i -lt 160;$i++) {
        $runInfo=& gh.exe run view $runId --json status,conclusion,url,headSha,headBranch,event,displayTitle
        if($LASTEXITCODE -ne 0) { throw "Could not inspect GitHub run $runId" }
        $info=($runInfo | ConvertFrom-Json)
        if($info.headSha -ne $clickSha -or $info.headBranch -ne 'main' -or $info.event -ne $runEvent -or
          ($runEvent -eq 'workflow_dispatch' -and $info.displayTitle -ne "Mita One-Click $requestId")) {
          throw 'CI run identity mismatch'
        }
        if($info.status -eq 'completed') {
          $complete=$true
          if($info.conclusion -ne 'success') {
            Write-Host "[CI FAILURE] $($info.url) - $($info.conclusion)" -ForegroundColor Red
            & gh.exe run view $runId --log-failed
            throw "GitHub Actions did not complete successfully: $($info.conclusion)"
          }
          Write-Host ('[CI OK] '+$info.url) -ForegroundColor Green
          break
        }
        Write-Host ('[CI] ' + $info.status + ' - ' + (Get-Date -Format HH:mm:ss))
        Start-Sleep -Seconds 15
      }
      if(!$complete) { throw "GitHub Actions timeout after 40 minutes; run $runId" }
      VerifyPublic $clickSha
      Write-Host '[DEPLOY COMPLETE] Committed click-time HEAD, database, website and services verified.' -ForegroundColor Green
    }
  }
  exit 0
} catch {
  Write-Host '[DEPLOY FAILED] ' -NoNewline -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host 'No claim of success. Review the error above; rerun after repair.' -ForegroundColor Yellow
  exit 1
} finally {
  [Environment]::SetEnvironmentVariable('MITA_VPS_DATABASE_URL',$oldSecret,'Process')
  if($tunnel) {
    $p=Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
    if($p -and $p.StartTime -eq $tunnelStart) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
  }
}
