param([switch]$TestOnly)

$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:3100/admin/login'
$forward = '127.0.0.1:3100:127.0.0.1:3100'
$hostTarget = 'ubuntu@217.142.225.255'
$sshProcess = $null

function Test-AdminLogin {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

try {
  # Never open an unrelated application listening on localhost:3100.
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if (!$owner -or $owner.Name -ne 'ssh.exe' -or
        !$owner.CommandLine.Contains($forward) -or
        !$owner.CommandLine.Contains($hostTarget)) {
      throw 'Local port 3100 is in use by another application. Close it before opening Mita Admin.'
    }
    if (!(Test-AdminLogin)) { throw 'Existing SSH tunnel is not serving the Mita Admin login page.' }
    Write-Host 'Existing Mita Admin SSH tunnel is ready.'
    if (!$TestOnly) { Start-Process -FilePath $url }
    return
  }

  if ((Get-Service ssh-agent -ErrorAction Stop).Status -ne 'Running') {
    throw 'Windows ssh-agent is stopped. Start it and load your existing Hermes SSH key first.'
  }
  $key = Join-Path $env:USERPROFILE '.ssh/oracle_20260624.pub'
  if (!(Test-Path -LiteralPath $key)) { throw 'Hermes SSH public key was not found.' }
  $fingerprintText = (& ssh-keygen.exe -lf $key 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or $fingerprintText -notmatch 'SHA256:[A-Za-z0-9+/]+') {
    throw 'Could not read the Hermes SSH key fingerprint.'
  }
  $fingerprint = $Matches[0]
  $loaded = (& ssh-add.exe -l 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or !$loaded.Contains($fingerprint)) {
    throw 'Load your Hermes SSH key into ssh-agent first (ssh-add ~/.ssh/oracle_20260624).'
  }

  $sshArgs = @('-N', '-T', '-L', $forward,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', '-o', 'ConnectTimeout=10',
    '-o', 'IdentitiesOnly=yes', '-i', ('"' + $key + '"'), $hostTarget)

  # Share the batch window: closing it also closes the SSH console session.
  $sshProcess = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArgs -PassThru -NoNewWindow
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    $sshProcess.Refresh()
    if ($sshProcess.HasExited) { throw 'SSH connection failed. Check key/known_hosts and VPS availability.' }
    $port = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $sshProcess.Id }
    if ($port -and (Test-AdminLogin)) { $ready = $true; break }
    Start-Sleep -Milliseconds 300
  }
  if (!$ready) { throw 'Admin login did not respond through the SSH tunnel.' }

  Write-Host "Mita Admin is ready: $url"
  if ($TestOnly) { return }

  Start-Process -FilePath $url
  Write-Host 'Keep this window open while using Admin. Press Ctrl+C to disconnect.'
  while (!$sshProcess.HasExited) {
    Start-Sleep -Seconds 1
    $sshProcess.Refresh()
  }
  throw 'Admin SSH tunnel disconnected.'
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if ($sshProcess) {
    $running = Get-Process -Id $sshProcess.Id -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime -eq $sshProcess.StartTime) {
      Stop-Process -Id $sshProcess.Id -ErrorAction SilentlyContinue
    }
  }
}
