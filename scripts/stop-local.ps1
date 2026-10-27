[CmdletBinding(SupportsShouldProcess)]
param([switch]$StopDatabase)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.agents/runtime'
$stopCmdlet = $PSCmdlet

foreach ($name in @('worker','web','api')) {
  $recordPath = Join-Path $runtime "$name.pid.json"
  if (!(Test-Path -LiteralPath $recordPath)) { continue }
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
  # Never terminate a recycled PID or an unrelated pre-existing service.
  if (!$process -or $process.StartTime.ToUniversalTime().ToString('o') -ne $record.StartedAt) { continue }
  $all = @(Get-CimInstance Win32_Process)
  function Stop-Children([int]$parent) {
    foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $parent })) {
      Stop-Children $child.ProcessId
      if ($stopCmdlet.ShouldProcess("$name child PID=$($child.ProcessId)", 'Stop process')) {
        Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
      }
    }
  }
  Stop-Children $process.Id
  if ($PSCmdlet.ShouldProcess("$name PID=$($process.Id)", 'Stop process')) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
  }
}
if ($StopDatabase) {
  $pgdata = Join-Path $root 'backend/.local-db'
  if ($PSCmdlet.ShouldProcess($pgdata, 'Stop project PostgreSQL cluster')) {
    & 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D $pgdata -m fast -w stop
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL stop failed' }
  }
}
