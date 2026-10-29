# Task Scheduler entrypoint. Starts only the Mita PostgreSQL cluster + workers.
# No migration, no immediate crawler, no public web server.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$data=Join-Path $root 'backend/.local-db'
$pgbin='C:\Program Files\PostgreSQL\18\bin'
if (!(Test-Path -LiteralPath (Join-Path $data 'PG_VERSION'))) {
  throw 'Mita PostgreSQL cluster has not been initialized; use manual setup first'
}
& (Join-Path $pgbin 'pg_isready.exe') -h 127.0.0.1 -p 5433 | Out-Null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $pgbin 'pg_ctl.exe') -D $data -l (Join-Path $root 'backend/.local-postgres.log') -o '-p 5433 -h 127.0.0.1' -w start
  if ($LASTEXITCODE -ne 0) { throw 'Mita local PostgreSQL did not start' }
}
& (Join-Path $PSScriptRoot 'start-mita-supervisor.ps1')
