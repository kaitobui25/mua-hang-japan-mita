[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$recordPath = Join-Path $root '.agents/runtime/vps-worker.pid.json'
if (!(Test-Path -LiteralPath $recordPath)) { Write-Host 'No managed VPS worker session.'; return }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
if ($record.Root -ne $root) { throw 'Worker record belongs to a different project.' }
foreach ($owned in $record.Processes) {
  $current = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
  if (!$current) { continue }
  # Never stop an unrelated service or a recycled PID. No name-wide/process-tree kills.
  if ($current.ProcessName -ne $owned.Name -or $current.StartTime.ToUniversalTime().ToString('o') -ne $owned.StartedAt) {
    throw 'Process identity changed; refusing to stop it.'
  }
  if ($PSCmdlet.ShouldProcess("$($owned.Name) PID=$($owned.Id)", 'Stop managed VPS worker session process')) {
    Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue
  }
}
