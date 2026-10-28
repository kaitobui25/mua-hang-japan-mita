param([switch]$DryRun, [switch]$DataOnly)
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
    & node.exe scripts/sync-catalog-vps.mjs $mode
    if($LASTEXITCODE -ne 0) { throw "VPS catalog $mode failed; code release NOT pushed" }
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
  foreach($route in @('/admin/login','/api/admin/session','/thanh-toan')) {
    $status = & curl.exe -sS -o NUL -w '%{http_code}' --connect-timeout 8 --max-time 16 ($base+$route)
    if($LASTEXITCODE -ne 0 -or $status -ne '404') { throw "Private route $route exposed or unavailable: HTTP $status" }
  }
  $other=Invoke-WebRequest -Uri 'https://ekaiwa.duckdns.org/' -UseBasicParsing -TimeoutSec 20
  if($other.StatusCode -ne 200) { throw 'E-KAIWA regression: not HTTP 200' }
  $releaseInfo = & ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 ubuntu@217.142.225.255 cat /opt/mita/current/release-info.json
  if($LASTEXITCODE -ne 0) { throw 'Cannot verify VPS deployed release' }
  $release = ($releaseInfo -join "`n") | ConvertFrom-Json
  if($release.revision -ne $sha) { throw "VPS revision mismatch: $($release.revision) expected $sha" }
  Write-Host "[OK] VPS release $($release.version) @ $sha" -ForegroundColor Green
  Write-Host "[OK] Public catalog $($catalog.total) cards, detail $asin; E-KAIWA OK; private paths blocked" -ForegroundColor Green
}

try {
  Set-Location $root
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Write-Host ('=== MITA ONE-CLICK DEPLOY ' + (Get-Date -Format o) + ' ===') -ForegroundColor Cyan
  if((git branch --show-current).Trim() -ne 'main') { throw 'Deploy requires main branch' }
  if(!(Get-Command gh.exe -ErrorAction SilentlyContinue)) { throw 'GitHub CLI gh.exe is required' }
  RunChecked 'GitHub authentication' { gh.exe auth status 1>$null }
  RunChecked 'Fetch remote main' { git.exe fetch origin main }
  RunChecked 'Check local history contains origin/main' { git.exe merge-base --is-ancestor origin/main HEAD }

  if(!$DryRun) {
    # Upgrade local source first, so newly introduced translation metadata is
    # present before copying. Migration is additive and idempotent.
    RunChecked 'Apply local additive schema' { npm.cmd run db:migrate --prefix backend }
  }

  SyncVpsData $(if($DryRun) {'--dry-run'} else {'--apply'})
  if($DryRun) {
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
      # Explicit HEAD marker is required by the existing GitHub Actions workflow.
      CallGit @('add','-A')
      RunChecked 'Validate staged patch' { git.exe diff --cached --check }
      CallGit @('commit','--allow-empty','-m','One-click verified Mita release [deploy]')
      $sha = (& git.exe rev-parse HEAD).Trim()
      CallGit @('push','origin','main')
      Write-Host "[PUSH OK] $sha" -ForegroundColor Green
      $runId=$null
      for($attempt=0;$attempt -lt 30;$attempt++) {
        $runs = & gh.exe run list --workflow mita-deploy.yml --commit $sha --limit 5 --json databaseId,headSha,status,conclusion,url
        if($LASTEXITCODE -ne 0) { throw 'Cannot read GitHub Actions run status' }
        $entry=@(($runs | ConvertFrom-Json) | Where-Object { $_.headSha -eq $sha } | Select-Object -First 1)
        if($entry.Count -gt 0) { $runId=[long]$entry[0].databaseId; break }
        Start-Sleep -Seconds 5
      }
      if(!$runId) { throw "No workflow run for commit $sha; inspect GitHub Actions" }
      Write-Host "[CI] GitHub Actions run #$runId, monitoring build + Hermes deployment..."
      $complete=$false
      for($i=0;$i -lt 160;$i++) {
        $runInfo=& gh.exe run view $runId --json status,conclusion,url,headSha
        if($LASTEXITCODE -ne 0) { throw "Could not inspect GitHub run $runId" }
        $info=($runInfo | ConvertFrom-Json)
        if($info.headSha -ne $sha) { throw 'CI run commit identity mismatch' }
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
      VerifyPublic $sha
      Write-Host '[DEPLOY COMPLETE] Git push, database, website and services verified.' -ForegroundColor Green
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
