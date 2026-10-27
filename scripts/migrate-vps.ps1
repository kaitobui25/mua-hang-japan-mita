param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$secretFile = Join-Path $root '.agents/runtime/mita-vps-database-url.dpapi'
$backend = Join-Path $root 'backend'
$tunnel = $null

if (!(Test-Path -LiteralPath $secretFile)) { throw 'Missing encrypted VPS database credentials.' }
if ($Apply) {
  $running = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.CommandLine -match '(?i)(src[\\/]worker\.(ts|js)|dist[\\/]worker\.js)'
  })
  if ($running.Count) { throw 'Stop the PC catalog worker before transferring the initial snapshot.' }
}
if (Get-NetTCPConnection -State Listen -LocalPort 15432 -ErrorAction SilentlyContinue) {
  throw 'Port 15432 is in use; refusing to trust a tunnel not owned by this script.'
}

$secret = (Get-Content -LiteralPath $secretFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $env:MITA_VPS_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }

try {
  $identity = Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
  if (!(Test-Path -LiteralPath $identity)) { throw 'Hermes SSH key missing; do not create or replace it.' }
  $args = @('-N', '-T', '-L', '127.0.0.1:15432:127.0.0.1:5432',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-i', $identity,
    'ubuntu@217.142.225.255')
  $tunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList $args -PassThru -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $root '.agents/runtime/mita-vps-migration-ssh.err.log')
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $tunnel.Refresh()
    if ($tunnel.HasExited) { throw 'SSH tunnel exited; verify the known host and ssh-agent.' }
    if (Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 15432 -ErrorAction SilentlyContinue |
        Where-Object OwningProcess -eq $tunnel.Id) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (!$ready) { throw 'SSH tunnel did not become ready.' }

  Push-Location $backend
  try {
    & node.exe scripts/migrate-local-to-vps.mjs $(if ($Apply) { '--apply' } else { '--dry-run' })
    if ($LASTEXITCODE -ne 0) { throw 'One-time migration validation failed.' }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:MITA_VPS_DATABASE_URL -ErrorAction SilentlyContinue
  if ($tunnel) {
    $current = Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
    if ($current -and $current.StartTime -eq $tunnel.StartTime) {
      Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
    }
  }
}
