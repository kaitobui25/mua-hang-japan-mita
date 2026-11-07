# Windows PowerShell 5.1. The BAT owns the Enter-to-exit prompt.
param([switch]$ReadOnly, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$mutex = $null
$owned = $false
$result = 1
try {
    # Global namespace also prevents two Windows sessions auditing concurrently.
    $mutex = New-Object System.Threading.Mutex($false, 'Global\MitaJapanDailyAuditV1')
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
        Write-Host '[FAIL] Audit dang chay trong cua so khac. Hay doi audit do ket thuc.' -ForegroundColor Red
        $result = 1
    } else {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $entry = Join-Path $PSScriptRoot 'mita-daily-audit.mjs'
        $env:MITA_DAILY_AUDIT_MUTEX = 'held'
        if (-not $SelfTest) {
            # Verify both the listener executable and the existing Mita cluster PID.
            $env:MITA_DAILY_AUDIT_LOCAL_OWNER = 'unverified'
            try {
                $listeners = @(Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction Stop)
                $pgCtl = 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe'
                $cluster = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend\.local-db'
                $status = (& $pgCtl -D $cluster status 2>$null | Out-String)
                $pgPid = if ($status -match 'PID:\s*(\d+)') { [int]$Matches[1] } else { 0 }
                if ($LASTEXITCODE -eq 0 -and $pgPid -gt 0 -and $listeners.Count -gt 0) {
                    $foreign = @($listeners | Where-Object { $_.OwningProcess -ne $pgPid })
                    $process = Get-Process -Id $pgPid -ErrorAction Stop
                    if ($foreign.Count -eq 0 -and $process.Path -eq 'C:\Program Files\PostgreSQL\18\bin\postgres.exe') {
                        $env:MITA_DAILY_AUDIT_LOCAL_OWNER = 'verified'
                    }
                }
            } catch { # Fail closed locally on absent, foreign or inaccessible listeners.
            }
        }
        if ($SelfTest) { & $node $entry '--self-test' }
        elseif ($ReadOnly) { & $node $entry '--read-only' }
        else { & $node $entry }
        $result = $LASTEXITCODE
    }
} catch {
    # Do not echo arbitrary exception text: it can contain connection credentials.
    Write-Host '[FAIL] Khong the khoi dong audit. Can Node 22, PowerShell 5.1 va quyen tao mutex Global.' -ForegroundColor Red
    $result = 1
} finally {
    Remove-Item Env:MITA_DAILY_AUDIT_MUTEX -ErrorAction SilentlyContinue
    Remove-Item Env:MITA_DAILY_AUDIT_LOCAL_OWNER -ErrorAction SilentlyContinue
    if ($owned -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
exit $result
