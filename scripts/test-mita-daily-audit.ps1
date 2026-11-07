# Chỉ kiểm thử fixture, đọc trạng thái PostgreSQL; không start DB, không POST hoặc gọi SSH.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$wrapper = Join-Path $PSScriptRoot 'mita-daily-audit.ps1'
$entry = Join-Path $PSScriptRoot 'mita-daily-audit.mjs'
$parseTokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Không phân tích được cú pháp PowerShell 5.1.' }
foreach ($file in @($wrapper, $PSCommandPath)) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    if ($bytes.Length -lt 3 -or [BitConverter]::ToString($bytes[0..2]) -ne 'EF-BB-BF') {
        throw 'PowerShell tiếng Việt cần UTF-8 BOM.'
    }
}
$source = Get-Content -LiteralPath $wrapper -Encoding UTF8 -Raw
$nodeSource = Get-Content -LiteralPath $entry -Encoding UTF8 -Raw
$batFile = Join-Path $root 'mita-audit.bat'
$batBytes = [System.IO.File]::ReadAllBytes($batFile)
if ([BitConverter]::ToString($batBytes[0..2]) -eq 'EF-BB-BF') {
    throw 'BAT phải là UTF-8 không BOM để CMD hiểu @echo off.'
}
$batText = [System.IO.File]::ReadAllText($batFile, [System.Text.Encoding]::UTF8)
if ($batText -match '(?<!\r)\n') { throw 'BAT cần xuống dòng CRLF để CMD chạy đủ các lệnh.' }
if (-not $source.Contains('[Console]::IsInputRedirected') -or
    -not $source.Contains("Read-Host 'Nhấn Enter để KHỞI ĐỘNG") -or
    -not $source.Contains("'--local-recheck'") -or
    -not $source.Contains("if ((Get-MitaLocalState) -ne 'stopped')")) {
    throw 'Thiếu chốt xác minh 5433, xác nhận Enter hoặc kiểm tra lại local.'
}
if (-not $nodeSource.Contains("args[0] === '--local-recheck'") -or
    -not $nodeSource.Contains("MITA_DAILY_AUDIT_LOCAL_OWNER === 'verified'")) {
    throw 'Node chưa bảo vệ chế độ kiểm tra lại 5433.'
}
$recheckStart = $nodeSource.IndexOf('async function localRecheck(')
$recheckEnd = $nodeSource.IndexOf('async function run(', $recheckStart)
if ($recheckStart -lt 0 -or $recheckEnd -le $recheckStart) { throw 'Không tìm thấy nhánh local-recheck.' }
$localBlock = $nodeSource.Substring($recheckStart, $recheckEnd - $recheckStart)
if ($localBlock -match 'remoteQuery\(|remoteCheckout\(|\bhttp\(|\bcheckout\(|\bwriteFile\(') {
    throw 'local-recheck chứa thao tác ngoài DB local.'
}

# Chỉ trích định nghĩa hàm để đọc trạng thái; tuyệt đối không thực thi wrapper chính.
$stateStart = $source.IndexOf('function Get-MitaLocalState')
$stateEnd = $source.IndexOf('function Start-ExistingMitaPostgres', $stateStart)
if ($stateStart -lt 0 -or $stateEnd -le $stateStart) { throw 'Không tìm thấy hàm xác minh local.' }
$pgCtl = 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe'
$pgExe = 'C:\Program Files\PostgreSQL\18\bin\postgres.exe'
$data = Join-Path $root 'backend\.local-db'
$stopRequest = Join-Path $root '.agents\runtime\mita-supervisor.stop'
Invoke-Expression $source.Substring($stateStart, $stateEnd - $stateStart)
$actualState = Get-MitaLocalState
if ($actualState -notin @('stopped', 'stop-requested', 'verified', 'unknown')) {
    throw 'Hàm xác minh trả trạng thái không hợp lệ.'
}
$savedCtl = $pgCtl
$pgCtl = Join-Path $root '__pg_ctl_khong_ton_tai__'
if ((Get-MitaLocalState) -ne 'unknown') { throw 'pg_ctl thiếu phải fail-closed.' }
$pgCtl = $savedCtl
if ($actualState -eq 'stopped') {
    $savedStop = $stopRequest
    $stopRequest = Join-Path $data 'PG_VERSION'
    if ((Get-MitaLocalState) -ne 'stop-requested') { throw 'Stop-request phải chặn khởi động.' }
    $stopRequest = $savedStop
}
# Listener khác PID phải trả unknown; không sửa port hoặc process thật.
function Get-NetTCPConnection {
    [CmdletBinding()]
    param([int]$LocalPort, [string]$State)
    [pscustomobject]@{ LocalPort = 5433; OwningProcess = 99999999 }
}
try {
    if ((Get-MitaLocalState) -ne 'unknown') { throw 'Listener khác PID phải fail-closed.' }
} finally {
    Remove-Item Function:\Get-NetTCPConnection
}

Push-Location $root
try {
    & cmd.exe /d /c 'echo.|powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\mita-daily-audit.ps1 -SelfTest'
    if ($LASTEXITCODE -ne 0) { throw 'Fixture thông qua PowerShell 5.1 không đạt.' }
    $batOutput = & cmd.exe /d /c 'echo.|mita-audit.bat -SelfTest' 2>&1
    if ($LASTEXITCODE -ne 0 -or ($batOutput -join [Environment]::NewLine) -match 'not recognized|không được nhận diện') {
        throw 'CMD không đọc đúng BAT hoặc BAT không giữ mã thoát 0.'
    }
    $batOutput | Out-Host
    $mutex = New-Object System.Threading.Mutex($false, 'Global\MitaJapanDailyAuditV1')
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Có audit thật đang chạy; không can thiệp.' }
        & cmd.exe /d /c 'echo.|mita-audit.bat -SelfTest'
        if ($LASTEXITCODE -ne 1) { throw 'BAT không giữ mã thoát 1 khi mutex bận.' }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $oldMutex = $env:MITA_DAILY_AUDIT_MUTEX
    $oldOwner = $env:MITA_DAILY_AUDIT_LOCAL_OWNER
    try {
        $env:MITA_DAILY_AUDIT_MUTEX = 'missing'
        $env:MITA_DAILY_AUDIT_LOCAL_OWNER = 'unverified'
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $node $entry '--local-recheck' 2>&1 | Out-Null
        } finally { $ErrorActionPreference = $previousPreference }
        if ($LASTEXITCODE -ne 1) { throw 'Thiếu mutex phải chặn local-recheck.' }
        $env:MITA_DAILY_AUDIT_MUTEX = 'held'
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $node $entry '--local-recheck' 2>&1 | Out-Null
        } finally { $ErrorActionPreference = $previousPreference }
        if ($LASTEXITCODE -ne 1) { throw 'Owner chưa xác minh phải chặn local-recheck.' }
    } finally {
        $env:MITA_DAILY_AUDIT_MUTEX = $oldMutex
        $env:MITA_DAILY_AUDIT_LOCAL_OWNER = $oldOwner
    }
    Write-Host ('[OK] PowerShell 5.1/BOM, fixture Node, BAT Enter/mutex, cổng 5433 và chặn local-recheck. Trạng thái: ' + $actualState) -ForegroundColor Green
    Write-Host '     Không khởi động PostgreSQL, không tạo đơn QA và không chạy bù job.'
} finally { Pop-Location }
