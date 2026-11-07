# Windows PowerShell 5.1. Chỉ khởi động PostgreSQL Mita khi người dùng nhấn Enter.
param([switch]$ReadOnly, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$mutex = $null
$owned = $false
$result = 1
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $root 'backend\.local-db'
$pgCtl = 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe'
$pgExe = 'C:\Program Files\PostgreSQL\18\bin\postgres.exe'
$pgLog = Join-Path $root 'backend\.local-postgres.log'
$stopRequest = Join-Path $root '.agents\runtime\mita-supervisor.stop'

function Get-MitaLocalState {
    if (-not (Test-Path -LiteralPath $pgCtl -PathType Leaf) -or
        -not (Test-Path -LiteralPath $pgExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $data 'PG_VERSION') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $data 'global\pg_control') -PathType Leaf)) {
        return 'unknown'
    }
    if ((Get-Content -LiteralPath (Join-Path $data 'PG_VERSION') -Raw).Trim() -ne '18') {
        return 'unknown'
    }
    try {
        # Đọc toàn bộ listener để phân biệt cổng trống với lỗi quyền/CIM.
        # Không dùng -LocalPort 5433 -ErrorAction Stop vì cổng trống cũng phát sinh lỗi.
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 5433 })
        # pg_ctl status trả exit code 3 khi cluster dừng; đây không phải lỗi PowerShell.
        # PowerShell 5.1 có thể coi stderr của native command là terminating error.
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $status = (& $pgCtl -D $data status 2>$null | Out-String)
            $statusCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($statusCode -eq 3 -and $listeners.Count -eq 0) {
            if (Test-Path -LiteralPath $stopRequest) { return 'stop-requested' }
            return 'stopped'
        }
        if ($statusCode -ne 0 -or $status -notmatch 'PID:\s*(\d+)') { return 'unknown' }
        $pgPid = [int]$Matches[1]
        if ($listeners.Count -lt 1 -or @($listeners | Where-Object { $_.OwningProcess -ne $pgPid }).Count -gt 0) {
            return 'unknown'
        }
        $process = Get-Process -Id $pgPid -ErrorAction Stop
        if ($process.Path -ine $pgExe) { return 'unknown' }
        return 'verified'
    } catch { return 'unknown' }
}

function Start-ExistingMitaPostgres {
    # Chỉ dùng cluster đã có. Tuyệt đối không initdb, migrate hoặc khởi động Supervisor.
    if ((Get-MitaLocalState) -ne 'stopped') {
        Write-Host '[FAIL] Không thể khởi động PostgreSQL Mita (5433).' -ForegroundColor Red
        Write-Host '       Nguyên nhân: Trạng thái đã thay đổi hoặc cổng 5433 thuộc tiến trình khác.'
        Write-Host '       Cách xử lý: Kiểm tra PID, dịch vụ và yêu cầu dừng; không khởi động tự động.'
        return $false
    }
    Write-Host ''
    Write-Host 'Đang khởi động PostgreSQL Mita (5433) từ dữ liệu hiện có...' -ForegroundColor Cyan
    try {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $pgCtl -D $data -l $pgLog -o '-p 5433 -h 127.0.0.1' -w -t 30 start 2>$null | Out-Null
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($code -eq 0 -and (Get-MitaLocalState) -eq 'verified') {
            Write-Host '[OK] PostgreSQL Mita (5433) đã hoạt động.' -ForegroundColor Green
            return $true
        }
        Write-Host '[FAIL] PostgreSQL Mita (5433) chưa khởi động thành công.' -ForegroundColor Red
        Write-Host "       Nguyên nhân: pg_ctl trả mã $code hoặc PID/cổng/đường dẫn chưa được xác minh."
        Write-Host '       Cách xử lý: Xem backend\.local-postgres.log; không chạy migration.'
        return $false
    } catch {
        Write-Host '[FAIL] Lệnh khởi động PostgreSQL Mita (5433) thất bại.' -ForegroundColor Red
        Write-Host '       Nguyên nhân: pg_ctl không hoàn tất do quyền, file hoặc dịch vụ.'
        Write-Host '       Cách xử lý: Xem backend\.local-postgres.log và quyền truy cập thư mục dữ liệu.'
        return $false
    }
}

try {
    $mutex = New-Object System.Threading.Mutex($false, 'Global\MitaJapanDailyAuditV1')
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
        Write-Host '[FAIL] Đã có cửa sổ khác đang chạy audit.' -ForegroundColor Red
        Write-Host '       Nguyên nhân: Một lượt audit khác đang giữ mutex.'
        Write-Host '       Cách xử lý: Chạy lại khi lượt kiểm tra đó kết thúc.'
    } else {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $entry = Join-Path $PSScriptRoot 'mita-daily-audit.mjs'
        $env:MITA_DAILY_AUDIT_MUTEX = 'held'
        $initialState = if ($SelfTest) { 'unknown' } else { Get-MitaLocalState }
        $env:MITA_DAILY_AUDIT_LOCAL_OWNER = if ($initialState -eq 'verified') { 'verified' } else { 'unverified' }

        if ($SelfTest) { & $node $entry '--self-test' }
        elseif ($ReadOnly) { & $node $entry '--read-only' }
        else { & $node $entry }
        $result = $LASTEXITCODE

        if (-not $SelfTest -and -not $ReadOnly -and $initialState -eq 'stopped' -and
            -not [Console]::IsInputRedirected) {
            # Kiểm tra lại để không hỏi khi PostgreSQL đã được tiến trình khác khôi phục.
            $currentState = Get-MitaLocalState
            if ($currentState -eq 'stopped') {
                Write-Host ''
                Write-Host '========== TÙY CHỌN KHÔI PHỤC DATABASE LOCAL ==========' -ForegroundColor Yellow
                Write-Host 'PostgreSQL riêng của Mita ở cổng 5433 đang tắt.'
                Write-Host 'Khởi động chỉ dùng dữ liệu hiện có, không migrate và không chạy bù job.'
                $answer = Read-Host 'Nhấn Enter để KHỞI ĐỘNG; nhập N rồi Enter để bỏ qua'
                if ($null -ne $answer -and $answer.Trim() -eq '') {
                    if (Start-ExistingMitaPostgres) {
                        $env:MITA_DAILY_AUDIT_LOCAL_OWNER = 'verified'
                        Write-Host ''
                        Write-Host '========== KIỂM TRA LẠI CÁC MỤC LIÊN QUAN 5433 ==========' -ForegroundColor Cyan
                        & $node $entry '--local-recheck'
                        $recheckCode = $LASTEXITCODE
                        if ($recheckCode -eq 1) { $result = 1 }
                        elseif ($result -eq 0 -and $recheckCode -eq 2) { $result = 2 }
                        Write-Host ''
                        Write-Host 'Kết quả ở trên chỉ cập nhật các mục 5433, không thay thế audit VPS ban đầu.'
                    } else { $result = 1 }
                } elseif ($null -ne $answer -and $answer.Trim().ToUpperInvariant() -eq 'N') {
                    Write-Host '[INFO] Đã bỏ qua khởi động PostgreSQL Mita (5433).' -ForegroundColor Yellow
                } else {
                    Write-Host '[INFO] Lựa chọn không hợp lệ; PostgreSQL Mita (5433) vẫn giữ nguyên.' -ForegroundColor Yellow
                }
            }
        } elseif (-not $SelfTest -and -not $ReadOnly -and $initialState -eq 'stopped' -and
                  [Console]::IsInputRedirected) {
            Write-Host '[INFO] Không hỏi khởi động 5433 vì đầu vào không tương tác.' -ForegroundColor Yellow
        }
    }
} catch {
    # Tránh in ngoại lệ thô: có thể chứa thông tin kết nối nhạy cảm.
    Write-Host '[FAIL] Không thể hoàn tất chương trình audit.' -ForegroundColor Red
    Write-Host '       Nguyên nhân: Không thể chạy công cụ hoặc xử lý môi trường Windows.'
    Write-Host '       Cách xử lý: Kiểm tra Node.js 22, PowerShell 5.1 và quyền chạy.'
    $result = 1
} finally {
    Remove-Item Env:MITA_DAILY_AUDIT_MUTEX -ErrorAction SilentlyContinue
    Remove-Item Env:MITA_DAILY_AUDIT_LOCAL_OWNER -ErrorAction SilentlyContinue
    if ($owned -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
Write-Host ''
[void](Read-Host 'Nhấn Enter để đóng cửa sổ')
exit $result
