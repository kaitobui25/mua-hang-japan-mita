# Loaded ONLY inside the dedicated monitoring runspace. No UI, credentials or writes.
function New-PortObservation($id,$state,$reason,$source) {
    [pscustomobject]@{ Id=$id; State=$state; Reason=$reason; ProbeSource=$source; LastProbed=[datetime]::Now }
}

# Only processes created here may be terminated on timeout. Never attach to or
# terminate an existing service/tunnel. Output stays private and is never logged.
function Invoke-PortCommand([string]$file,[string]$arguments,[int]$timeout=2000) {
    $p=New-Object System.Diagnostics.Process
    $p.StartInfo=New-Object System.Diagnostics.ProcessStartInfo
    $p.StartInfo.FileName=$file; $p.StartInfo.Arguments=$arguments
    $p.StartInfo.UseShellExecute=$false; $p.StartInfo.CreateNoWindow=$true
    $p.StartInfo.RedirectStandardOutput=$true; $p.StartInfo.RedirectStandardError=$true
    $started=$false
    try {
        $started=$p.Start()
        $output=$p.StandardOutput.ReadToEndAsync(); $errors=$p.StandardError.ReadToEndAsync()
        if (!$p.WaitForExit($timeout)) { $p.Kill(); return $null }
        if (!$output.Wait(200) -or !$errors.Wait(200)) { return $null }
        [pscustomobject]@{ Code=$p.ExitCode; Text=$output.GetAwaiter().GetResult() }
    } catch { return $null } finally {
        if ($started) { try { if (!$p.HasExited) { $p.Kill() } } catch { } }
        $p.Dispose()
    }
}

function Test-PortHttp([int]$port,[string]$path,[switch]$Api) {
    $request=[System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port$path")
    $request.Proxy=$null; $request.AllowAutoRedirect=$false
    $request.Timeout=900; $request.ReadWriteTimeout=900
    $response=$null
    try {
        $response=$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { return $false }
        if (!$Api) { return $true }
        $reader=New-Object System.IO.StreamReader($response.GetResponseStream())
        try {
            # Health JSON is tiny. Never read an unbounded response body.
            $buffer=New-Object char[] 4096; $count=$reader.Read($buffer,0,$buffer.Length)
            $health=(-join $buffer[0..($count-1)]) | ConvertFrom-Json
            return ($health.ok -is [bool] -and $health.ok -eq $true)
        } finally { $reader.Dispose() }
    } catch { return $false } finally { if ($response) { $response.Dispose() }; $request.Abort() }
}

function Test-PortSupervisor {
    $tcp=New-Object System.Net.Sockets.TcpClient
    try {
        $connect=$tcp.ConnectAsync('127.0.0.1',19978)
        if (!$connect.Wait(600)) { return $false }
        $stream=$tcp.GetStream(); $stream.ReadTimeout=700
        $deadline=[datetime]::UtcNow.AddMilliseconds(1400)
        $bytes=New-Object byte[] 64; $text=''
        while ($text.Length -lt 64 -and !$text.Contains("`n") -and [datetime]::UtcNow -lt $deadline) {
            $count=$stream.Read($bytes,0,$bytes.Length)
            if ($count -eq 0) { break }
            $text += [System.Text.Encoding]::ASCII.GetString($bytes,0,$count)
        }
        return ($text -ceq "Mita supervisor active`n")
    } catch { return $false } finally { $tcp.Dispose() }
}

function Invoke-PortProbes {
    $ErrorActionPreference='Stop'
    $listeners=@(); $listenerKnown=$false
    try { $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop); $listenerKnown=$true } catch {
        # Get-NetTCPConnection reports an error when no listeners match too;
        # never infer stopped services from failed listener enumeration.
    }
    foreach ($spec in @(
        @('pc-web',3000,'/admin/login'),@('pc-api',4000,'/api/health'),
        @('pc-db',5433,'pg_isready'),@('supervisor',19978,'raw TCP banner'),
        @('gateway',8080,'/health'),@('gguf',8081,'/health'),@('neo',9010,'unverified MCP')
    )) {
        $id=$spec[0]; $port=[int]$spec[1]; $source="PC Get-NetTCPConnection + 127.0.0.1:$port $($spec[2])"
        if (!$listenerKnown) { New-PortObservation $id unknown 'Không đọc được TCP listener; chưa xác định.' $source; continue }
        $found=@($listeners | Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::1') })
        if (!$found.Count) {
            $state=if ($id -eq 'gguf') { 'idle' } else { 'offline' }
            $reason=if ($id -eq 'gguf') { 'Không có listener GGUF theo nhu cầu; Idle là bình thường.' } else { 'Không có TCP listener trên loopback.' }
            New-PortObservation $id $state $reason 'PC Get-NetTCPConnection'; continue
        }
        $healthy=$false
        switch ($id) {
            'pc-db' {
                $r=Invoke-PortCommand 'C:\Program Files\PostgreSQL\18\bin\pg_isready.exe' '-h 127.0.0.1 -p 5433 -t 1'
                $healthy=($null -ne $r -and $r.Code -eq 0)
            }
            'supervisor' { $healthy=Test-PortSupervisor }
            'neo' { }
            default { $healthy=Test-PortHttp $port $spec[2] -Api:($id -eq 'pc-api') }
        }
        if ($healthy) { New-PortObservation $id online 'TCP listener và kiểm tra ứng dụng thành công.' $source }
        else { New-PortObservation $id warning 'Có listener; chưa chứng minh ứng dụng khỏe (probe lỗi/không hỗ trợ).' $source }
    }
    $source='PC Get-NetTCPConnection + Win32_Process (SSH forward ownership)'
    $tunnel=@($listeners | Where-Object LocalPort -eq 15432)
    if (!$listenerKnown) { New-PortObservation tunnel unknown 'Không đọc được listener.' $source }
    elseif (!$tunnel.Count) { New-PortObservation tunnel idle 'Không có tunnel tạm; Idle là bình thường.' $source }
    else {
        $verified=$true
        foreach ($entry in $tunnel) {
            try {
                $process=Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.OwningProcess)" -ErrorAction Stop
                $cmd=[string]$process.CommandLine
                if ($process.Name -ne 'ssh.exe' -or
                    $process.ExecutablePath -ne (Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe') -or
                    $cmd -notmatch '(?:^|\s)-L\s+"?127\.0\.0\.1:15432:127\.0\.0\.1:5432"?(?:\s|$)' -or
                    $cmd -notmatch '(?:^|\s)ubuntu@217\.142\.225\.255(?:\s|$)' -or
                    $entry.LocalAddress -ne '127.0.0.1' -or
                    $cmd -notmatch '(?:^|\s)-N(?:\s|$)' -or
                    $cmd -notmatch [regex]::Escape((Join-Path $env:USERPROFILE '.ssh/oracle_20260624')) -or
                    $cmd -notmatch 'StrictHostKeyChecking=yes' -or $cmd -notmatch 'BatchMode=yes') { $verified=$false }
            } catch { $verified=$false }
        }
        if ($verified) {
            $r=Invoke-PortCommand 'C:\Program Files\PostgreSQL\18\bin\pg_isready.exe' '-h 127.0.0.1 -p 15432 -t 1'
            if ($r -and $r.Code -eq 0) { New-PortObservation tunnel online 'Listener thuộc SSH forward đã xác minh; pg_isready thành công.' "$source + pg_isready" }
            else { New-PortObservation tunnel warning 'SSH forward đã xác minh; chưa chứng minh PostgreSQL khỏe.' "$source + pg_isready" }
        } else { New-PortObservation tunnel warning 'Listener chưa xác minh thuộc SSH forward được duyệt; không gửi probe DB.' $source }
    }
    New-PortObservation workers unknown 'Không suy diễn tiến trình worker từ cổng; xem trạng thái Supervisor riêng.' 'Không probe tiến trình'
    # The Sync node is a finite daily job, not a port. Use the actual daily
    # supervisor state and a verified local process observation, never infer
    # running merely from a stale JSON marker or SSH monitoring connectivity.
    $syncSource='Verified Supervisor IPC + JST snapshot + process inventory'
    try {
        $root=Split-Path $PSScriptRoot -Parent
        $today=[datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd')
        $statePath=Join-Path $root ('.agents/runtime/mita-daily-'+$today+'.json')
        $daily=if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
        $syncState=if ($daily -and $daily.sync) { [string]$daily.sync.state } else { 'unknown' }
        $syncAt=if ($daily -and $daily.sync -and $daily.sync.at) { [string]$daily.sync.at } else { 'chưa có' }
        $running=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop | Where-Object {
            [string]$_.CommandLine -match '(?i)(?:^|[\s"])(?:[A-Z]:[^"\s]*[\\/])?nightly-vps-sync\.ps1(?:["\s]|$)' -and
            [string]$_.CommandLine -match [regex]::Escape((Join-Path $root 'scripts/nightly-vps-sync.ps1'))
        })
        $coordinator=$null
        try { $coordinator=& (Join-Path $PSScriptRoot 'mita-sync-control.ps1') -Action Status } catch { }
        $verified=$false
        if ($running.Count -eq 1 -and $coordinator -and $coordinator.state -eq 'running' -and
            $coordinator.inFlight -and $coordinator.owner -and
            [int]$coordinator.owner.pid -eq [int]$running[0].ProcessId -and
            [int]$coordinator.owner.supervisorPid -eq [int]$running[0].ParentProcessId -and
            $coordinator.owner.runId -match '^[a-f0-9-]{36}$') {
            $verified=$true
        }
        if ($verified) { New-PortObservation sync online "Supervisor xác nhận Sync đang chạy (PID $($running[0].ProcessId))." $syncSource }
        elseif ($running.Count -eq 1) { New-PortObservation sync warning 'Có tiến trình Sync nhưng Supervisor chưa xác minh được PID/run ID của lượt chạy.' $syncSource }
        elseif ($running.Count -gt 1) { New-PortObservation sync warning 'Có nhiều tiến trình Sync; không xác minh được quyền sở hữu.' $syncSource }
        else {
            $status=switch ($syncState) {
                'completed' {'idle'} 'pending' {'idle'} 'skipped' {'idle'}
                'partial' {'warning'} 'failed' {'warning'} 'running' {'warning'}
                default {'unknown'}
            }
            $reason=if ($syncState -eq 'running') { 'Snapshot ghi running nhưng chưa thấy tiến trình Sync tương ứng; cần kiểm tra.' }
                else { "Sync JST $today : $syncState; cập nhật: $syncAt. Không có tiến trình đồng bộ đang xác minh." }
            New-PortObservation sync $status $reason $syncSource
        }
    } catch { New-PortObservation sync unknown 'Không đọc/xác minh được nhật ký hoặc tiến trình Sync.' $syncSource }

    # Existing approved identity only; no password, host-key enrollment, tunnel,
    # agent modification, HTTP exposure, shell config, sudo or service controls.
    $key=Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
    $ssh=Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
    $source='VPS SSH strict/BatchMode (6s); ss -ltnH'
    # Listener-only is deliberately Warning, never Online. Bound remote output.
    $remote=@'
LC_ALL=C; export LC_ALL; snapshot=$(timeout 2 ss -ltnH) || exit 1;
echo MITA_SS_OK; printf '%s\n' "$snapshot" | head -n 128;
test $(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:3100/admin/login) = 200 && echo MITA_WEB_OK;
python3 -c 'import json,urllib.request; h=urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:4100/api/health",timeout=1); exit(0 if json.loads(h.read(4096)).get("ok") is True else 1)' 2>/dev/null && echo MITA_API_OK;
pg_isready -h 127.0.0.1 -p 5432 -t 1 >/dev/null 2>&1 && echo MITA_DB_OK; exit 0
'@
    $remote=$remote.Replace("`r",'').Replace("`n",' ')
    $r=$null
    if ((Test-Path -LiteralPath $key) -and (Test-Path -LiteralPath "$key.pub")) {
        $arguments='-F NUL -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectionAttempts=1 -o ConnectTimeout=4 -o ServerAliveInterval=2 -o ServerAliveCountMax=1 -i "' + $key + '" ubuntu@217.142.225.255 "' + $remote.Replace('"','\"') + '"'
        $r=Invoke-PortCommand $ssh $arguments 6000
    }
    $connected=($null -ne $r -and $r.Code -eq 0 -and ($r.Text -split "`n").Trim() -contains 'MITA_SS_OK')
    foreach ($id in @('monitor','ssh','vps-web','vps-api','vps-db','http','https')) {
        if (!$connected) {
            New-PortObservation $id offline 'Mất kết nối giám sát SSH VPS (hoặc thiếu key/host key); KHÔNG kết luận dịch vụ VPS đã dừng.' $source
            continue
        }
        if ($id -in @('monitor','ssh')) { New-PortObservation $id online 'SSH xác thực thành công và lệnh chỉ đọc có phản hồi.' $source; continue }
        $port=switch ($id) { 'vps-web' {3100} 'vps-api' {4100} 'vps-db' {5432} 'http' {80} 'https' {443} }
        $present=@($r.Text -split "`n" | Where-Object { ($_.Trim() -split '\s+')[3] -match (':' + $port + '$') }).Count -gt 0
        $app=($id -eq 'vps-web' -and ($r.Text -split "`n").Trim() -contains 'MITA_WEB_OK') -or ($id -eq 'vps-api' -and ($r.Text -split "`n").Trim() -contains 'MITA_API_OK') -or ($id -eq 'vps-db' -and ($r.Text -split "`n").Trim() -contains 'MITA_DB_OK')
        if ($present -and $app) {
            $appSource=switch ($id) { 'vps-web' { 'curl loopback :3100/admin/login HTTP 200' } 'vps-api' { 'python3 loopback :4100/api/health JSON ok:true' } 'vps-db' { 'pg_isready loopback :5432' } }
            New-PortObservation $id online 'TCP listener và kiểm tra ứng dụng qua SSH thành công.' "$source + $appSource"
        }
        elseif ($present) { New-PortObservation $id warning 'SSH thấy TCP listener; chưa chứng minh sức khỏe ứng dụng.' $source }
        else { New-PortObservation $id unknown 'Không thấy listener trong snapshot giới hạn; không kết luận dịch vụ đã dừng.' $source }
    }
}
