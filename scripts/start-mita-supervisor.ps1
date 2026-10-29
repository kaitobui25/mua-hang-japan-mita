[CmdletBinding()]
param([switch]$DetailOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.agents/runtime'
$backend = Join-Path $root 'backend'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (!(Test-Path (Join-Path $backend 'node_modules/tsx'))) { throw 'Install backend dependencies before enabling workers.' }
if (!(Test-NetConnection -ComputerName 127.0.0.1 -Port 5433 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  throw 'Mita local PostgreSQL 5433 is unavailable; run start-local.ps1 first.'
}
function Get-Listener([int]$port) {
  return @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1)
}
function Check-OwnedListener([int]$port,[string]$expectedScript) {
  $listener = @(Get-Listener $port)
  if (!$listener.Count) { return $false }
  $pidValue = $listener[0].OwningProcess
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  $expectedPath = (Join-Path $PSScriptRoot $expectedScript).Replace('/','\')
  if (!$process -or !$process.CommandLine -or !$process.CommandLine.Contains($expectedPath)) {
    throw "Port $port is occupied by an unowned process. Refusing to reuse or terminate it."
  }
  return $true
}
function Start-ManagedNode([string]$name,[string]$script,[int]$port,[string[]]$arguments) {
  if (Check-OwnedListener $port $script) { Write-Host "$name already active"; return }
  $scriptPath = Join-Path $PSScriptRoot $script
  $args = @(('"' + $scriptPath + '"')) + $arguments
  $process = Start-Process node.exe -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime "$name.launch.out.log") -RedirectStandardError (Join-Path $runtime "$name.launch.err.log")
  $ready = $false
  for ($attempt=0; $attempt -lt 40; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw "$name exited before readiness; inspect private logs" }
    if (@(Get-Listener $port | Where-Object OwningProcess -eq $process.Id).Count) { $ready=$true; break }
    Start-Sleep -Milliseconds 250
  }
  if (!$ready) { throw "$name did not bind its local control port" }
  @{ Root=$root; Id=$process.Id; StartedAt=$process.StartTime.ToUniversalTime().ToString('o'); Script=$script } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime "$name.pid.json") -Encoding UTF8
  Write-Host "$name running PID=$($process.Id)"
}
if (!(Check-OwnedListener 19978 'mita-supervisor.mjs')) {
  $legacy = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.CommandLine -match '(?i)src[\\/](worker|translator|detail-translator)\.ts\s+daily'
  })
  if ($legacy.Count) { throw 'Existing unsupervised Mita worker detected; stop it before switching lifecycle.' }
}
Start-ManagedNode 'llama-gateway' 'llama-on-demand.mjs' 8080 @()
Start-ManagedNode 'mita-supervisor' 'mita-supervisor.mjs' 19978 $(if ($DetailOnly) { @('--detail-only') } else { @() })
