$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.agents/runtime'
$processes = @(Get-CimInstance Win32_Process)
function Stop-Children([int]$parent) {
  foreach ($child in ($processes | Where-Object { $_.ParentProcessId -eq $parent })) {
    Stop-Children $child.ProcessId
    Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
  }
}
foreach ($name in @('cloudflared-quick','caddy-tunnel','caddy-public','public-ddns','public-translator','public-worker','public-web','public-api')) {
  $recordPath = Join-Path $runtime "$name.pid.json"
  if (!(Test-Path $recordPath)) { continue }
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
  if (!$process -or $process.StartTime.ToUniversalTime().ToString('o') -ne $record.StartedAt) { continue }
  Stop-Children $process.Id
  Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $recordPath -ErrorAction SilentlyContinue
  Write-Host "$name stopped"
}
