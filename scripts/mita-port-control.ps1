# Safe local controls for exactly two managed Mita services; never arbitrary PID/port.
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)][ValidateSet('start','stop')][string]$Action,
    [Parameter(Mandatory=$true)][ValidateSet('gateway','supervisor')][string]$Service
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime=Join-Path $root '.agents/runtime'
$scriptName=if ($Service -eq 'gateway') { 'llama-on-demand.mjs' } else { 'mita-supervisor.mjs' }
$recordName=if ($Service -eq 'gateway') { 'llama-gateway' } else { 'mita-supervisor' }
$port=if ($Service -eq 'gateway') { 8080 } else { 19978 }
$recordPath=Join-Path $runtime ($recordName+'.pid.json')
$stopPath=Join-Path $runtime ($recordName+'.stop')
$scriptPath=Join-Path $PSScriptRoot $scriptName
$launched=$null; $launchStarted=$null; $committed=$false
function Get-OwnedNode {
    $listeners=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $port -ErrorAction SilentlyContinue)
    $record=$null
    if (Test-Path -LiteralPath $recordPath) { $record=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    if (!$record) {
        if ($listeners.Count) { throw "Cổng $port đã bị chiếm; không thể xác minh quyền sở hữu." }
        return $null
    }
    if ($record.Root -ne $root -or $record.Script -ne $scriptName -or [int]$record.Id -le 0) { throw 'Hồ sơ PID không hợp lệ.' }
    $proc=Get-Process -Id $record.Id -ErrorAction SilentlyContinue
    if (!$proc) {
        if ($listeners.Count) { throw 'Cổng có listener nhưng PID Mita đã ghi không tồn tại.' }
        return $null
    }
    if ($proc.ProcessName -ne 'node' -or $proc.StartTime.ToUniversalTime().ToString('o') -ne $record.StartedAt) { throw 'PID bị tái sử dụng hoặc tiến trình không đúng.' }
    $win=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.Id)" -ErrorAction Stop
    $pattern='(?i)(?:^|\s)"?' + [regex]::Escape($scriptPath) + '"?(?=\s|$)'
    if (!$win.CommandLine -or $win.CommandLine -notmatch $pattern -or $win.ExecutablePath -notmatch '(?i)[\\/]node\.exe$') { throw 'CommandLine không trùng script Mita.' }
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $proc.Id) { throw 'Listener không thuộc tiến trình đã xác minh.' }
    return $proc
}
function Write-Audit([string]$result) {
    if (!(Test-Path -LiteralPath $runtime)) { New-Item -ItemType Directory -Path $runtime -Force | Out-Null }
    $line=@{atUtc=[DateTime]::UtcNow.ToString('o');host='PC';service=$Service;action=$Action;result=$result} | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $runtime 'mita-port-control-audit.jsonl') -Encoding UTF8 -Value $line
}
try {
    $owned=Get-OwnedNode
    if ($Action -eq 'stop') {
        if (!$owned) { throw 'Dịch vụ không chạy hoặc không thuộc Mita.' }
        if ($Service -eq 'gateway') {
            # Gateway may serve a worker between inference calls. Require the
            # scheduling supervisor to finish draining BEFORE stopping gateway.
            $supervisorListener=@(Get-NetTCPConnection -State Listen -LocalPort 19978 -ErrorAction SilentlyContinue)
            if ($supervisorListener.Count) { throw 'Supervisor 19978 còn chạy/đang drain; dừng supervisor an toàn trước gateway.' }
            $workers=@(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
                $_.CommandLine -match '(?i)src[\\/](worker|translator|detail-translator)\.ts(?:\s|$)'
            })
            if ($workers.Count) { throw 'Worker dịch thuật/thu thập còn chạy; không dừng gateway khi còn phụ thuộc.' }
        }
        if (!$PSCmdlet.ShouldProcess("$Service PID=$($owned.Id)",'Request cooperative drain')) { return }
        # Stops occur only once active jobs / inference drain, per existing scripts.
        Set-Content -LiteralPath $stopPath -Value stop -Encoding ASCII
        Write-Audit 'stop-requested'
        Write-Output "Đã yêu cầu dừng an toàn $Service; cần xác nhận qua kiểm tra trạng thái."
        return
    }
    if ($owned) { throw 'Dịch vụ đã chạy.' }
    if ($Service -eq 'supervisor') {
        if (!(Test-Path -LiteralPath (Join-Path $root 'backend/node_modules/tsx'))) { throw 'Thiếu dependencies backend.' }
        if (!(Test-NetConnection -ComputerName 127.0.0.1 -Port 5433 -InformationLevel Quiet -WarningAction SilentlyContinue)) { throw 'PostgreSQL Mita 5433 chưa sẵn sàng.' }
        $gatewayListener=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 8080 -ErrorAction SilentlyContinue)
        $gatewayRecordPath=Join-Path $runtime 'llama-gateway.pid.json'
        if ($gatewayListener.Count -ne 1 -or !(Test-Path -LiteralPath $gatewayRecordPath)) { throw 'Gateway 8080 chưa chạy hoặc không được quản lý bởi Mita.' }
        $gatewayRecord=Get-Content -LiteralPath $gatewayRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $gatewayProc=Get-Process -Id $gatewayRecord.Id -ErrorAction SilentlyContinue
        $gatewayCmd=if ($gatewayProc) { Get-CimInstance Win32_Process -Filter "ProcessId=$($gatewayRecord.Id)" -ErrorAction SilentlyContinue }
        if (!$gatewayProc -or $gatewayRecord.Root -ne $root -or $gatewayRecord.Script -ne 'llama-on-demand.mjs' -or
            $gatewayProc.ProcessName -ne 'node' -or $gatewayProc.StartTime.ToUniversalTime().ToString('o') -ne $gatewayRecord.StartedAt -or
            $gatewayListener[0].OwningProcess -ne $gatewayProc.Id -or !$gatewayCmd.CommandLine -or
            !$gatewayCmd.CommandLine.Contains((Join-Path $PSScriptRoot 'llama-on-demand.mjs'))) {
            throw 'Không xác minh được gateway Mita; từ chối bật supervisor.'
        }
        $legacy=@(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match '(?i)src[\\/](worker|translator|detail-translator)\.ts\s+daily' })
        if ($legacy.Count) { throw 'Có worker legacy chưa được quản lý.' }
    }
    if (!(Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'Script Mita không tồn tại.' }
    if (!$PSCmdlet.ShouldProcess("$Service / $port",'Start named Mita process')) { return }
    if (!(Test-Path -LiteralPath $runtime)) { New-Item -ItemType Directory -Path $runtime -Force | Out-Null }
    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force }
    $proc=Start-Process -FilePath 'node.exe' -ArgumentList @(('"' + $scriptPath + '"')) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime ($recordName+'.launch.out.log')) -RedirectStandardError (Join-Path $runtime ($recordName+'.launch.err.log'))
    $launched=$proc; $launchStarted=$proc.StartTime
    $ready=$false
    for($i=0;$i -lt 40;$i++) {
        $proc.Refresh()
        if ($proc.HasExited) { throw "Dịch vụ $Service thoát trước khi sẵn sàng." }
        $active=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $proc.Id)
        if ($active.Count -eq 1) { $ready=$true; break }
        Start-Sleep -Milliseconds 250
    }
    if (!$ready) { throw "Dịch vụ $Service không mở cổng đã định." }
    @{Root=$root; Id=$proc.Id; StartedAt=$proc.StartTime.ToUniversalTime().ToString('o'); Script=$scriptName} | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    $committed=$true
    Write-Audit 'start-confirmed'
    Write-Output "Đã xác minh $Service sở hữu cổng $port."
} catch {
    # Never kill a supervisor as startup rollback: it may have launched child
    # workers before the PID record was written. Request cooperative draining
    # instead; ownership must be recovered manually if record persistence failed.
    if ($Action -eq 'start' -and $launched -and !$committed) {
        $current=Get-Process -Id $launched.Id -ErrorAction SilentlyContinue
        if ($current -and $current.ProcessName -eq 'node' -and $current.StartTime -eq $launchStarted) {
            try { Set-Content -LiteralPath $stopPath -Value stop -Encoding ASCII } catch { }
        }
    }
    Write-Audit 'rejected-or-failed'
    throw
}
