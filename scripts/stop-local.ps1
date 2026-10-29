[CmdletBinding(SupportsShouldProcess)]
param([switch]$StopDatabase)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.agents/runtime'

function Get-OwnedProcess([ValidateSet('mita-supervisor','llama-gateway')][string]$name) {
  $expectedScript = if ($name -eq 'mita-supervisor') { 'mita-supervisor.mjs' } else { 'llama-on-demand.mjs' }
  $recordPath=Join-Path $runtime "$name.pid.json"
  if (!(Test-Path -LiteralPath $recordPath)) { return $null }
  $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  if ($record.Root -ne $root -or $record.Script -ne $expectedScript -or [int]$record.Id -le 0) {
    throw "Unexpected $name process record; refusing to stop"
  }
  $actual=Get-Process -Id $record.Id -ErrorAction SilentlyContinue
  if (!$actual) { return $null }
  if ($actual.StartTime.ToUniversalTime().ToString('o') -ne $record.StartedAt) {
    throw "Recycled PID detected for $name; refusing to stop"
  }
  $win=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.Id)"
  $escapedPath=[regex]::Escape((Join-Path $PSScriptRoot $expectedScript))
  $scriptArgPattern='(?i)(?:^|\s)"?' + $escapedPath + '"?(?=\s|$)'
  if (!$win -or $actual.ProcessName -ne 'node' -or
      $win.ExecutablePath -notmatch '(?i)[\\/]node\.exe$' -or
      !$win.CommandLine -or $win.CommandLine -notmatch $scriptArgPattern) {
    throw "Unexpected executable for $name; refusing to stop"
  }
  return $actual
}

# Managed process stop is cooperative. Active jobs drain under advisory locks
# before the supervisor exits. The gateway drains current inference first.
$supervisor=Get-OwnedProcess 'mita-supervisor'
$gateway=Get-OwnedProcess 'llama-gateway'
if ($supervisor -and $PSCmdlet.ShouldProcess('Mita worker supervisor','Request graceful worker drain')) {
  Set-Content -LiteralPath (Join-Path $runtime 'mita-supervisor.stop') -Value stop -Encoding ASCII
  Write-Host 'Supervisor drain requested. Jobs finish before workers stop.'
}
if ($gateway -and $PSCmdlet.ShouldProcess('Mita llama gateway','Request inference drain')) {
  Set-Content -LiteralPath (Join-Path $runtime 'llama-gateway.stop') -Value stop -Encoding ASCII
  Write-Host 'Gateway idle stop requested.'
}

# The historical npm.cmd launchers record a parent PID and start time, but not
# reliable identity for their child tree. Never terminate a legacy launcher or
# descendants by PID: they may have exited or spawned an unrelated process.
$legacyNames = @('detail-translator','llama','translator','worker','web','api')
$legacyRecords = @($legacyNames | Where-Object {
  Test-Path -LiteralPath (Join-Path $runtime "$_.pid.json")
})
if ($legacyRecords.Count -gt 0) {
  Write-Warning ("Legacy service records ({0}) require manual process verification and graceful stop; no processes were killed." -f ($legacyRecords -join ', '))
}
if ($StopDatabase) {
  if ($supervisor -or $gateway -or $legacyRecords.Count -gt 0) {
    throw 'Cannot stop Mita database while managed processes or unverified legacy records remain. Drain/verify them first.'
  }
  $pgdata = Join-Path $root 'backend/.local-db'
  if ($PSCmdlet.ShouldProcess($pgdata, 'Stop project PostgreSQL cluster')) {
    # Smart shutdown waits for existing connections to finish; never abort an
    # active job just because the owner requested the optional database stop.
    & 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D $pgdata -m smart -t 20 -w stop
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL stop failed' }
  }
}
