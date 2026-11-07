# Safe fixtures only. No network, live database, production POST or service control.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$wrapper = Join-Path $PSScriptRoot 'mita-daily-audit.ps1'
$parseTokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'PowerShell wrapper parse failed' }
Push-Location $root
try {
    & powershell.exe -NoProfile -File $wrapper -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'Fixture self-test through PS5.1 failed' }
    & cmd.exe /d /c 'echo.|mita-audit.bat -SelfTest'
    if ($LASTEXITCODE -ne 0) { throw 'BAT success exit/pause test failed' }
    $mutex = New-Object System.Threading.Mutex($false, 'Global\MitaJapanDailyAuditV1')
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Another real audit is running; do not disturb it' }
        & cmd.exe /d /c 'echo.|mita-audit.bat -SelfTest'
        if ($LASTEXITCODE -ne 1) { throw 'BAT must preserve mutex-rejection exit code 1' }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    Write-Host '[OK] PS5.1 parse, fixture suite, BAT Enter pause/exit 0 and mutex contention/exit 1.' -ForegroundColor Green
} finally { Pop-Location }
