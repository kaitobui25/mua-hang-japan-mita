# Invoked only after the three worker terminal states. Never runs migrations.
[CmdletBinding()]
param([switch]$DryRun)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime=Join-Path $root '.agents/runtime'
$credentials=Join-Path $runtime 'mita-vps-database-url.dpapi'
$tunnel=$null
$created=$null
$saved=[Environment]::GetEnvironmentVariable('MITA_VPS_DATABASE_URL','Process')
if (!$env:MITA_SYNC_JOBS) { throw 'Missing daily worker terminal-state barrier' }
if (!(Test-Path -LiteralPath $credentials)) { throw 'Encrypted Mita VPS connection is unavailable' }
if (Get-NetTCPConnection -State Listen -LocalPort 15432 -ErrorAction SilentlyContinue) {
  throw 'Port 15432 occupied; refusing to trust an existing foreign tunnel'
}
if ((Get-Service ssh-agent).Status -ne 'Running') { throw 'Windows ssh-agent is unavailable' }
$key=Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
if (!(Test-Path -LiteralPath $key) -or !(Test-Path -LiteralPath "$key.pub")) {
  throw 'Approved Hermes identity not found'
}
$fingerprintText=(& ssh-keygen.exe -lf "$key.pub" 2>$null) -join ' '
if ($LASTEXITCODE -ne 0 -or $fingerprintText -notmatch 'SHA256:[A-Za-z0-9+/]+') {
  throw 'Cannot identify approved Hermes public key'
}
$fingerprint=$Matches[0]
$loadedKeys=(& ssh-add.exe -l 2>$null) -join ' '
if ($LASTEXITCODE -ne 0 -or !$loadedKeys.Contains($fingerprint)) {
  throw 'Approved SSH key is not loaded in ssh-agent'
}
$secure=(Get-Content -LiteralPath $credentials -Raw).Trim() | ConvertTo-SecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:MITA_VPS_DATABASE_URL=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
try {
  $uri=[Uri]$env:MITA_VPS_DATABASE_URL
  if ($uri.Host -ne '127.0.0.1' -or $uri.Port -ne 15432 -or $uri.AbsolutePath -ne '/mita' -or $uri.Query -or $uri.Fragment) {
    throw 'VPS URL points outside approved loopback tunnel'
  }
  $args=@('-N','-T','-L','127.0.0.1:15432:127.0.0.1:5432',
    '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes',
    '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=12',
    '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
    '-o','IdentitiesOnly=yes','-i',('"' + $key + '"'),'ubuntu@217.142.225.255')
  $tunnel=Start-Process ssh.exe -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtime 'nightly-ssh.err.log')
  $created=$tunnel.StartTime
  $ready=$false
  for ($attempt=0;$attempt -lt 48;$attempt++) {
    $tunnel.Refresh()
    if ($tunnel.HasExited) { throw 'SSH tunnel exited before readiness' }
    if (@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 15432 -ErrorAction SilentlyContinue |
        Where-Object OwningProcess -eq $tunnel.Id).Count) { $ready=$true; break }
    Start-Sleep -Milliseconds 250
  }
  if (!$ready) { throw 'Approved SSH tunnel did not become ready' }
  Push-Location (Join-Path $root 'backend')
  try {
    $mode=if ($DryRun) { '--dry-run' } else { '--apply' }
    $transfer=@(& node.exe scripts/sync-catalog-vps.mjs $mode)
    $transferCode=$LASTEXITCODE
    $transfer | ForEach-Object { Write-Output $_ }
    if ($transferCode -ne 0) { throw 'Daily sync failed; inspect remote ledger and private logs' }
    if ($DryRun) { return }
    $partial=@($transfer | Where-Object { $_ -match '^SYNC_COMMIT_OK .*"state":"partial"' }).Count -gt 0
    & node.exe scripts/sync-catalog-vps.mjs --verify
    if ($LASTEXITCODE -ne 0) { throw 'Daily sync committed but content verification failed' }
    if ($partial) { Write-Output 'Daily sync committed with preserved partial galleries'; exit 2 }
  } finally { Pop-Location }
} finally {
  [Environment]::SetEnvironmentVariable('MITA_VPS_DATABASE_URL',$saved,'Process')
  if ($tunnel) {
    $current=Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
    if ($current -and $current.StartTime -eq $created) {
      Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
    }
  }
}
