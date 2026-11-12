[CmdletBinding()]
param([ValidateSet('Start','Update','Status','Stop')][string]$Action = 'Status')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.agents/runtime/mobile-tunnel'
$recordFile = Join-Path $runtime 'tunnel.json'
$stdoutFile = Join-Path $runtime 'cloudflared.out.log'
$stderrFile = Join-Path $runtime 'cloudflared.err.log'

function Get-Listener([int]$port) {
  @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1)
}
function Test-Web {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 12
    return ([int]$response.StatusCode -eq 200)
  } catch { return $false }
}
function Get-Tunnel {
  if (!(Test-Path -LiteralPath $recordFile)) { return $null }
  $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
  if ($record.Root -ne $root -or $record.Id -le 0 -or $record.Url -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') {
    throw 'Unknown tunnel record. Refusing to operate on this process.'
  }
  $process = Get-Process -Id ([int]$record.Id) -ErrorAction SilentlyContinue
  if (!$process) { return $null }
  if ($process.StartTime.ToUniversalTime().ToString('o') -ne $record.StartedAt) {
    throw 'Tunnel PID was recycled. Refusing to operate on another process.'
  }
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.Id)" -ErrorAction SilentlyContinue
  if (!$actual -or $actual.Name -ne 'cloudflared.exe' -or
      $actual.ExecutablePath -ne $record.Executable -or
      $actual.CommandLine -notmatch '(?i)127\.0\.0\.1:3000' -or
      $actual.CommandLine -notmatch '(?i)\btunnel\b') {
    throw 'Tunnel process identity mismatch. Refusing to operate on it.'
  }
  return @{ Process=$process; Record=$record }
}
function Get-WebOwner {
  $listener = @(Get-Listener 3000)
  if (!$listener.Count) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)" -ErrorAction SilentlyContinue
  if (!$process -or !$process.CommandLine) { throw 'Web listener identity unavailable.' }
  if ($process.CommandLine -notlike "*$root*") { throw 'Port 3000 belongs to another project. Refusing to reuse it.' }
  return $process
}
function Show-Status {
  Write-Host ''
  foreach ($port in @(5433,4000,3000)) {
    $listener = @(Get-Listener $port)
    Write-Host ("{0,-15} {1}" -f "Port $port", $(if ($listener.Count) { 'LISTENING' } else { 'OFFLINE' }))
  }
  $tunnel = Get-Tunnel
  if ($tunnel) {
    Write-Host 'Mobile tunnel: RUNNING'
    Write-Host "Mobile URL: $($tunnel.Record.Url)"
    Write-Host 'This URL remains the same while this tunnel process is running.'
  } else { Write-Host 'Mobile tunnel: OFFLINE' }
}

try {
  switch ($Action) {
    'Status' { Show-Status }
    'Start' {
      $tunnel = Get-Tunnel
      if ($tunnel) {
        Write-Host 'Reusing the existing tunnel; URL unchanged.'
        Show-Status
        break
      }
      $web = Get-WebOwner
      $apiListeners = @(Get-Listener 4000)
      $dbListeners = @(Get-Listener 5433)
      if (!$web -or $apiListeners.Count -eq 0 -or $dbListeners.Count -eq 0) {
        Write-Host 'Some local services are offline. Running the ORIGINAL full startup.'
        Write-Host 'Note: original startup runs DB migrations and starts Supervisor.'
        & (Join-Path $PSScriptRoot 'start-local.ps1')
        if (!$?) { throw 'Original local startup failed.' }
        $web = Get-WebOwner
      }
      if (!$web) { throw 'Next.js is not listening on port 3000.' }
      if (!(Test-Web)) { throw 'Local web did not return HTTP 200. Tunnel was not started.' }
      $exe = (Get-Command cloudflared.exe -ErrorAction Stop).Source
      New-Item -ItemType Directory -Force -Path $runtime | Out-Null
      # Do not overwrite logs of an active or unverified tunnel process.
      $existing = @(Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" | Where-Object {
        $_.CommandLine -match '127\.0\.0\.1:3000' -and $_.CommandLine -match '\btunnel\b'
      })
      if ($existing.Count) { throw 'An untracked port-3000 tunnel exists. Inspect it manually; refusing a duplicate.' }
      Set-Content -LiteralPath $stdoutFile -Value '' -Encoding UTF8
      Set-Content -LiteralPath $stderrFile -Value '' -Encoding UTF8
      $proc = Start-Process -FilePath $exe -ArgumentList @('tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:3000','--loglevel','info') -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
      $url = $null
      for ($i=0; $i -lt 60; $i++) {
        $proc.Refresh()
        if ($proc.HasExited) { break }
        $log = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
        if ($log -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0]; break }
        Start-Sleep -Milliseconds 500
      }
      if (!$url) {
        # Only stop the exact process just created by this invocation.
        $proc.Refresh()
        if (!$proc.HasExited) { Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue }
        throw 'Cloudflare did not report a Quick Tunnel URL. Inspect private cloudflared log.'
      }
      $record = @{ Root=$root; Id=$proc.Id; StartedAt=$proc.StartTime.ToUniversalTime().ToString('o'); Executable=$exe; Url=$url }
      $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
      $tunnel = Get-Tunnel
      if (!$tunnel) { throw 'Tunnel exited before validation.' }
      Write-Host "Mobile URL: $url"
      Write-Host 'Anyone with this link can access the public storefront. Do not share it.'
      Write-Host 'Admin remains blocked on non-localhost hostnames.'
      Write-Host 'Close this terminal at any time; tunnel keeps running.'
      Write-Host 'Use Chrome Share > Create QR code (or copy the URL to your phone).'
    }
    'Update' {
      $web = Get-WebOwner
      if (!$web) { throw 'Next.js is not running. Choose mode 1 or 2 first.' }
      if (!(Test-Web)) { throw 'Local web is not responding with HTTP 200; inspect web logs.' }
      Write-Host 'Website ready. Changes to TSX/CSS auto-refresh with Next.js dev.'
      Write-Host 'No restart, build, Git operation, migration or VPS deploy was performed.'
      $tunnel = Get-Tunnel
      if ($tunnel) { Write-Host "Mobile URL unchanged: $($tunnel.Record.Url)" }
      else { Write-Host 'No managed mobile tunnel is running; choose mode 2.' }
    }
    'Stop' {
      $tunnel = Get-Tunnel
      if (!$tunnel) { Write-Host 'No managed mobile tunnel is running.'; break }
      Stop-Process -Id $tunnel.Process.Id -ErrorAction Stop
      $tunnel.Process.WaitForExit(10000) | Out-Null
      if (!$tunnel.Process.HasExited) { throw 'Tunnel did not exit. Record retained.' }
      Remove-Item -LiteralPath $recordFile -Force
      Write-Host 'Mobile tunnel stopped. Local website, API, PostgreSQL and Supervisor untouched.'
    }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
