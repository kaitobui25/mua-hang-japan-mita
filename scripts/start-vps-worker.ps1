# Manual foreground supervisor. Uses the Windows DPAPI-protected VPS credential
# installed in .agents/runtime, or an explicitly set MITA_VPS_DATABASE_URL.
# Never pass credentials on a command line. Ctrl+C or stop-vps-worker.ps1 stops this session.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
$runtime = Join-Path $root '.agents/runtime'
$recordPath = Join-Path $runtime 'vps-worker.pid.json'
$ssh = $null
$worker = $null
$lock = $null
$saved = @{}
$loadedDpapi = $false
try {
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  # Exclusive handle also prevents simultaneous launchers; it is released on exit/crash.
  $lock = [IO.File]::Open((Join-Path $runtime 'vps-worker.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  $existing = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.CommandLine -match '(?i)(src[\\/]worker\.(ts|js)|dist[\\/]worker\.js)'
  })
  # Fail conservatively even if another checkout's worker cannot be attributed safely.
  if ($existing.Count) { throw 'A Mita worker is already running. Stop it explicitly before switching databases.' }
  if (Get-NetTCPConnection -State Listen -LocalPort 15432 -ErrorAction SilentlyContinue) {
    throw 'Port 15432 is occupied; refusing to reuse an unowned tunnel/database.'
  }
  if (!$env:MITA_VPS_DATABASE_URL) {
    $encryptedPath = Join-Path $runtime 'mita-vps-database-url.dpapi'
    if (!(Test-Path -LiteralPath $encryptedPath)) {
      throw 'No VPS database credentials. Provision DPAPI credentials before launching the worker.'
    }
    $secure = (Get-Content -LiteralPath $encryptedPath -Raw).Trim() | ConvertTo-SecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $env:MITA_VPS_DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    $loadedDpapi = $true
  }
  $target = $null
  if (![Uri]::TryCreate($env:MITA_VPS_DATABASE_URL, [UriKind]::Absolute, [ref]$target) -or
      $target.Scheme -notin @('postgres', 'postgresql') -or $target.Host -ne '127.0.0.1' -or
      $target.Port -ne 15432 -or $target.Query -or $target.Fragment) {
    throw 'Set MITA_VPS_DATABASE_URL to the VPS database credentials at 127.0.0.1:15432 (no query/fragment).'
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)' | & $node
  if ($LASTEXITCODE -ne 0) { throw 'Node >=22.12 is required.' }
  if (!(Test-Path (Join-Path $backend 'node_modules/tsx/dist/loader.mjs'))) { throw 'Install backend dependencies first.' }
  if ((Get-Service ssh-agent).Status -ne 'Running') { throw 'Start the Windows ssh-agent service manually first.' }
  $key = Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
  if (!(Test-Path -LiteralPath $key)) { throw 'Existing oracle_20260624 SSH identity was not found.' }
  $publicKey = "$key.pub"
  if (!(Test-Path -LiteralPath $publicKey)) { throw 'The identity public .pub file is required to select the agent key.' }
  # Checking the agent by public fingerprint avoids a hidden passphrase prompt.
  # The owner loads the private identity separately if it is not already present.
  $fingerprintText = (& ssh-keygen.exe -lf $publicKey 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or $fingerprintText -notmatch 'SHA256:[A-Za-z0-9+/]+') {
    throw 'Unable to identify the existing Hermes public key.'
  }
  $fingerprint = $Matches[0]
  $loadedIdentities = (& ssh-add.exe -l 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or !$loadedIdentities.Contains($fingerprint)) {
    throw 'Hermes SSH identity is not loaded. Run ssh-add ~/.ssh/oracle_20260624 interactively in your own PowerShell first.'
  }
  $sshArgs = @('-N', '-T', '-L', '127.0.0.1:15432:127.0.0.1:5432', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', '-o', 'ConnectTimeout=10', '-o', 'IdentitiesOnly=yes', '-i', ('"' + $publicKey + '"'), 'ubuntu@217.142.225.255')
  $ssh = Start-Process ssh.exe -ArgumentList $sshArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtime 'vps-tunnel.err.log')
  $ready = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    $ssh.Refresh()
    if ($ssh.HasExited) { throw 'SSH failed. Check vps-tunnel.err.log and independently verify the known host key.' }
    if (Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 15432 -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $ssh.Id) { $ready = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (!$ready) { throw 'SSH tunnel did not become ready.' }
  foreach ($name in @('DATABASE_URL', 'MITA_VPS_WORKER', 'DB_POOL_MAX', 'PG_BOSS_POOL_MAX')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $env:DATABASE_URL = $env:MITA_VPS_DATABASE_URL
  $env:MITA_VPS_WORKER = '1'
  $env:DB_POOL_MAX = '2'
  $env:PG_BOSS_POOL_MAX = '2'
  Push-Location $backend
  try {
    # Real authenticated DB preflight; no migrations and no local database fallback.
    'import pg from "pg"; const c = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000}); try { await c.connect(); await c.query("SELECT 1"); } catch { console.error("VPS database preflight failed"); process.exitCode=1; } finally { await c.end(); }' | & $node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'VPS database is unavailable.' }
    $worker = Start-Process $node -ArgumentList @('--import', 'tsx', ('"' + (Join-Path $backend 'src/worker.ts') + '"'), 'daily') -WorkingDirectory $backend -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'vps-worker.out.log') -RedirectStandardError (Join-Path $runtime 'vps-worker.err.log')
  } finally { Pop-Location }
  @{ Root = $root; Processes = @(
    @{ Id = $worker.Id; StartedAt = $worker.StartTime.ToUniversalTime().ToString('o'); Name = 'node' },
    @{ Id = $ssh.Id; StartedAt = $ssh.StartTime.ToUniversalTime().ToString('o'); Name = 'ssh' }
  ) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $recordPath -Encoding UTF8
  Write-Host "VPS PC worker started PID=$($worker.Id); tunnel PID=$($ssh.Id). Keep this manual session open."
  while (!$worker.HasExited -and !$ssh.HasExited) {
    Start-Sleep -Seconds 1
    $worker.Refresh(); $ssh.Refresh()
  }
  throw 'Worker or tunnel stopped; stopping this session. No automatic restart.'
} finally {
  foreach ($owned in @($worker, $ssh)) {
    if ($owned) {
      $current = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
      if ($current -and $current.StartTime -eq $owned.StartTime) { Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue }
    }
  }
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  if ($loadedDpapi) { Remove-Item Env:MITA_VPS_DATABASE_URL -ErrorAction SilentlyContinue }
  if ($lock) {
    Remove-Item -LiteralPath $recordPath -ErrorAction SilentlyContinue
    $lock.Dispose()
  }
}
