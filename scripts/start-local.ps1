$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
& (Join-Path $PSScriptRoot 'check-scrapling.ps1')
$runtime = Join-Path $root '.agents/runtime'
$pgbin = 'C:\Program Files\PostgreSQL\18\bin'
$pgdata = Join-Path $backend '.local-db'

if (!(Test-Path (Join-Path $pgbin 'pg_ctl.exe'))) { throw 'PostgreSQL 18 must be installed locally.' }
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
if (!(Test-Path (Join-Path $pgdata 'PG_VERSION'))) {
  & (Join-Path $pgbin 'initdb.exe') -D $pgdata -U mita_local -A trust -E UTF8 --no-instructions
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize local PostgreSQL' }
}
& (Join-Path $pgbin 'pg_isready.exe') -h 127.0.0.1 -p 5433 | Out-Null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pgbin 'pg_ctl.exe') -D $pgdata -l (Join-Path $backend '.local-postgres.log') -o '-p 5433 -h 127.0.0.1' -w start
  if ($LASTEXITCODE -ne 0) { throw 'Could not start local PostgreSQL' }
}
Push-Location $backend
try {
  if (!(Test-Path 'node_modules')) { npm.cmd install --no-audit --no-fund }
  npm.cmd run db:migrate
  if ($LASTEXITCODE -ne 0) { throw 'Database migration failed' }
} finally { Pop-Location }
if (!(Test-Path (Join-Path $root 'node_modules'))) {
  Push-Location $root
  try { npm.cmd install --no-audit --no-fund } finally { Pop-Location }
}

function Start-MitaService([string]$name,[string]$folder,[string]$script,[int]$port) {
  if ($port -gt 0 -and (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    Write-Host "$name already listening on $port"
    return
  }
  $output = Join-Path $runtime "$name.out.log"
  $errors = Join-Path $runtime "$name.err.log"
  $process = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run',$script) -WorkingDirectory $folder -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errors -PassThru
  @{ Id = $process.Id; StartedAt = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime "$name.pid.json") -Encoding UTF8
  Write-Host "$name started PID=$($process.Id)"
}
Start-MitaService 'api' $backend 'start' 4000
Start-MitaService 'web' $root 'dev' 3000
$dailyWorker = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]worker\.ts daily' } | Select-Object -First 1
if ($dailyWorker) {
  Write-Host "daily catalog worker already running PID=$($dailyWorker.ProcessId)"
} else {
  Start-MitaService 'worker' $backend 'worker:daily' 0
}
$dailyTranslator = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]translator\.ts daily' } | Select-Object -First 1
if ($dailyTranslator) {
  Write-Host "daily translator already running PID=$($dailyTranslator.ProcessId)"
} else {
  Start-MitaService 'translator' $backend 'worker:translate:daily' 0
}
& (Join-Path $PSScriptRoot 'start-local-detail.ps1')
Write-Host 'Local Mita: http://127.0.0.1:3000'
Write-Host 'Daily catalog sync: 04:00 Asia/Tokyo'
Write-Host 'Daily name translation: 05:00 Asia/Tokyo (no catch-up)'
Write-Host 'Daily local detail translation: 05:15 Asia/Tokyo (no catch-up)'
Write-Host 'Manual stop: ./scripts/stop-local.ps1 (add -StopDatabase to stop the project PostgreSQL cluster)'
