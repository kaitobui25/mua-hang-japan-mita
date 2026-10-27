param([switch]$Preview, [switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
$runtime = Join-Path $root '.agents/runtime'
$webPort = if ($Preview) { 3100 } else { 3000 }
$apiPort = if ($Preview) { 4100 } else { 4000 }

$env:API_PORT = "$apiPort"
$env:WEB_PORT = "$webPort"
$env:PUBLIC_READ_ONLY = '1'
$env:NEXT_PUBLIC_READ_ONLY = '1'
$env:NEXT_BUILD_DIR = '.next-public'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

Push-Location $root
try {
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
} finally { Pop-Location }
# Next rewrites next-env.d.ts to the active distDir. Keep the tracked dev reference stable.
$typesPath = Join-Path $root 'next-env.d.ts'
$typesContent = [System.IO.File]::ReadAllText($typesPath)
$typesContent = $typesContent.Replace('./.next-public/types/routes.d.ts', './.next/types/routes.d.ts')
[System.IO.File]::WriteAllText($typesPath, $typesContent, (New-Object System.Text.UTF8Encoding($false)))
if ($BuildOnly) { return }

foreach ($port in @($webPort, $apiPort)) {
  if (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
    throw "Port $port is already in use. Stop the corresponding local service first."
  }
}

function Start-MitaPublic([string]$name,[string]$folder,[string[]]$command) {
  $process = Start-Process -FilePath 'npm.cmd' -ArgumentList $command -WorkingDirectory $folder -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "$name.out.log") -RedirectStandardError (Join-Path $runtime "$name.err.log") -PassThru
  @{ Id=$process.Id; StartedAt=$process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime "$name.pid.json") -Encoding UTF8
  Write-Host "$name started PID=$($process.Id)"
}

Start-MitaPublic 'public-api' $backend @('run','start')
Start-MitaPublic 'public-web' $root @('run','start','--','-p',"$webPort")
if (!$Preview) {
  $dailyWorker = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]worker\.ts daily' } | Select-Object -First 1
  if (!$dailyWorker) { Start-MitaPublic 'public-worker' $backend @('run','worker:daily') }
  # DuckDNS now targets Hermes VPS. Never start a PC-IP watcher from local preview.
}
Write-Host "Read-only storefront: http://127.0.0.1:$webPort"
Write-Host 'HTTPS is enabled separately through Caddy after DNS/router prerequisites are met.'
