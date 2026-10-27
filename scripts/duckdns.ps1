param([switch]$Setup, [switch]$Watch, [string]$Ip)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$secretPath = Join-Path $root '.agents/runtime/duckdns.token'

if ($Setup) {
  New-Item -ItemType Directory -Path (Split-Path $secretPath) -Force | Out-Null
  $secret = Read-Host 'DuckDNS token (hidden, saved encrypted for this Windows account)' -AsSecureString
  if ($secret.Length -lt 1) { throw 'DuckDNS token is empty.' }
  $secret | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath -Encoding ASCII
  Write-Host 'DuckDNS token saved encrypted for the current Windows user.'
  return
}

# The authoritative website moved to Hermes VPS. Without an explicit target,
# DuckDNS would silently reset the domain to the Windows PC public IP.
if ($Watch) { throw 'Periodic PC IP detection is disabled for the VPS-hosted domain. Use -Ip <VPS IPv4> for a one-time update.' }
if ([string]::IsNullOrWhiteSpace($Ip)) { throw 'Explicit target required: ./scripts/duckdns.ps1 -Ip <VPS IPv4>.' }
$target = $null
if (![Net.IPAddress]::TryParse($Ip, [ref]$target) -or $target.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'Target IP must be an IPv4 address.'
}
if (!(Test-Path -LiteralPath $secretPath)) { throw 'First run: ./scripts/duckdns.ps1 -Setup' }

function Update-DuckDns {
  $stage = 'decrypt'
  $secret = (Get-Content -LiteralPath $secretPath -Raw).Trim() | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $uri = 'https://www.duckdns.org/update?domains=mitajapanshop&ip=' + [uri]::EscapeDataString($Ip) + '&token=' + [uri]::EscapeDataString($token)
    $stage = 'http'
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 20
    $answer = if ($response.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($response.Content).Trim() } else { ([string]$response.Content).Trim() }
    $stage = 'response'
    if ($answer -ne 'OK') { throw 'DuckDNS rejected the update.' }
    Write-Host ('mitajapanshop.duckdns.org updated at ' + (Get-Date -Format s))
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'none' }
    $reason = if ($_.Exception.Message -eq 'DuckDNS rejected the update.') { 'rejected' } else { $_.Exception.GetType().Name }
    throw "DuckDNS update failed (stage=$stage, $reason, HTTP=$status)."
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $token = $null
  }
}

Update-DuckDns
