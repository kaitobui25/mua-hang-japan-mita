# Temporary 5-minute read-only SSH forwarding session. No DB sync or VPS writes.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Status','Run')][string]$Action,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$SessionId='00000000000000000000000000000000',
    [ValidatePattern('^[a-f0-9]{32}$')][string]$RunId='00000000000000000000000000000000'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime=Join-Path $root '.agents/runtime/tunnel-diagnostic'
$recordFile=Join-Path $runtime 'owner.json'
$leaseFile=Join-Path $root '.agents/runtime/tunnel-15432.lease'
$ssh=Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
$identity=Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-Record {
    if (!(Test-Path -LiteralPath $recordFile)) { return $null }
    $record=Get-Content -LiteralPath $recordFile -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($record.Root -cne $root -or $record.UserSid -cne $sid -or $record.RunId -notmatch '^[a-f0-9]{32}$') { throw 'Untrusted tunnel owner record.' }
    return $record
}
function New-OwnerMutex {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root+$sid))).Replace('-','').Substring(0,24) }
    finally { $sha.Dispose() }
    return (New-Object Threading.Mutex($false,('Local\MitaTunnel15432-'+$hash)))
}
function Remove-OwnerIfMatch($expected) {
    $mutex=New-OwnerMutex; $locked=$false
    try {
        $locked=$mutex.WaitOne([timespan]::FromSeconds(3))
        if (!$locked) { throw 'Cannot serialize tunnel owner cleanup.' }
        $current=Get-Record
        if (!$current) { return }
        if ($current.RunId -cne $expected.RunId -or $current.SessionId -cne $expected.SessionId) {
            throw 'Tunnel ownership changed during shutdown; never remove another session record.'
        }
        if ((Get-OwnedChild $current) -or (Test-Occupied)) { throw 'Tunnel child or listener still present; retaining owner record.' }
        Remove-Item -LiteralPath $recordFile -ErrorAction Stop
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
function Get-Owner {
    $record=Get-Record
    if (!$record) { return $null }
    $p=Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
    if (!$p -or $p.ProcessName -ne 'powershell' -or $p.StartTime.ToUniversalTime().ToString('o') -cne $record.StartedAt) { return $null }
    $win=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction Stop
    if (!$win -or $win.ExecutablePath -ine (Join-Path $PSHOME 'powershell.exe') -or
        !$win.CommandLine.Contains($PSCommandPath) -or !$win.CommandLine.Contains($record.RunId)) { return $null }
    return $record
}
function Get-OwnedChild($record) {
    if (!$record) { return $null }
    $file=Join-Path $runtime ($record.RunId+'.child.json')
    if (!(Test-Path -LiteralPath $file)) { return $null }
    $child=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($child.RunId -cne $record.RunId -or [int]$child.Pid -le 0) { throw 'Untrusted tunnel child record.' }
    $proc=Get-Process -Id $child.Pid -ErrorAction SilentlyContinue
    if (!$proc) { return $null }
    if ($proc.ProcessName -ne 'ssh' -or $proc.StartTime.ToUniversalTime().ToString('o') -cne $child.StartedAt) {
        throw 'Tunnel child PID reused; never stop a replacement process.'
    }
    $win=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Pid)" -ErrorAction Stop
    if (!$win -or $win.ExecutablePath -ine $ssh -or
        $win.CommandLine -notmatch '127\.0\.0\.1:15432:127\.0\.0\.1:5432' -or
        $win.CommandLine -notmatch 'StrictHostKeyChecking=yes') {
        throw 'Tunnel child command identity changed; refusing stop.'
    }
    return $child
}
function Test-Occupied {
    return (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 15432).Count -gt 0)
}
function Check-Preflight {
    if (Test-Occupied) { throw 'Port 15432 is in use; never adopt an existing tunnel.' }
    if (!(Test-Path $ssh) -or !(Test-Path $identity) -or !(Test-Path ($identity+'.pub'))) { throw 'Approved SSH executable or key is unavailable.' }
    if ((Get-Service ssh-agent -ErrorAction Stop).Status -ne 'Running') { throw 'Windows ssh-agent is not running.' }
    $fingerprint=(& ssh-keygen.exe -lf ($identity+'.pub') 2>$null) -join ' '
    if ($LASTEXITCODE -ne 0 -or $fingerprint -notmatch 'SHA256:[A-Za-z0-9+/]+') { throw 'Could not verify approved SSH identity.' }
    $loaded=(& ssh-add.exe -l 2>$null) -join ' '
    if ($LASTEXITCODE -ne 0 -or !$loaded.Contains($Matches[0])) { throw 'Approved key is not loaded in ssh-agent.' }
    # An old supervisor does not coordinate port 15432. Fail closed rather
    # than let a diagnostic session race its nightly sync startup.
    try {
        $coordinator=& (Join-Path $PSScriptRoot 'mita-sync-control.ps1') -Action Status
        if (!$coordinator -or $coordinator.protocol -cne 'mita-sync-v1' -or
            $coordinator.dispatching -or $coordinator.inFlight) {
            throw 'Sync coordinator is busy or does not support tunnel reservation.'
        }
    } catch { throw 'A verified updated Sync supervisor is required before opening diagnostic tunnel.' }
    $today=[datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd')
    $stateFile=Join-Path $root ('.agents/runtime/mita-daily-'+$today+'.json')
    if (Test-Path $stateFile) {
        $state=Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.sync.state -eq 'running') { throw 'Nightly Sync is running; tunnel diagnostic is forbidden.' }
        if ($state.sync.state -eq 'pending' -and @($state.jobs.PSObject.Properties | Where-Object {
            $_.Value.state -in @('completed','skipped','partial','failed') }).Count -eq 3) {
            throw 'Nightly Sync may start at any time; diagnostic tunnel refused.'
        }
    }
}
if (!(Test-Path $runtime)) { [void][IO.Directory]::CreateDirectory($runtime) }
if ($Action -eq 'Status') {
    $record=Get-Record
    if ($record -and !(Get-Owner) -and (Get-OwnedChild $record)) { throw 'Tunnel child remains without a verified wrapper; manual recovery required.' }
    if ($record -and (Get-Owner)) { $record }
    return
}
if ($Action -eq 'Start') {
    # Serialize simultaneous Desktop Start requests before ownership is recorded.
    # Run wrappers do not take this mutex; they use the shared Sync lease below.
    $mutex=New-OwnerMutex
    $locked=$false
    try {
        $locked=$mutex.WaitOne([timespan]::FromSeconds(3))
        if (!$locked) { throw 'Another Desktop is starting a diagnostic tunnel.' }
    Check-Preflight
    if (Get-Record) { throw 'A diagnostic tunnel owner record already exists; verify cleanup before another Start.' }
    if (Test-Path -LiteralPath $leaseFile) { throw 'Port 15432 is reserved by Sync or another diagnostic session.' }
    $newRun=[guid]::NewGuid().ToString('N')
    $argument='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action Run -SessionId '+$SessionId+' -RunId '+$newRun
    $wrapper=Start-Process (Join-Path $PSHOME 'powershell.exe') -ArgumentList $argument -WindowStyle Hidden -PassThru
    $record=@{Root=$root;UserSid=$sid;SessionId=$SessionId;RunId=$newRun;Pid=$wrapper.Id;StartedAt=$wrapper.StartTime.ToUniversalTime().ToString('o');ExpiresAt=[datetime]::UtcNow.AddMinutes(5).ToString('o')}
    $temp=Join-Path $runtime ($newRun+'.owner.tmp')
    [IO.File]::WriteAllText($temp,($record | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
    [IO.File]::Move($temp,$recordFile) # Same-directory atomic publication.
    $ready=$false
    $readyFile=Join-Path $runtime ($newRun+'.ready')
    for ($n=0;$n -lt 60;$n++) {
        Start-Sleep -Milliseconds 200
        $wrapper.Refresh()
        if ($wrapper.HasExited) { break }
        $r=Get-Owner
        if ($r -and (Test-Path -LiteralPath $readyFile)) {
            $confirmedPid=[int](Get-Content -LiteralPath $readyFile -Raw -Encoding ASCII)
            $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 15432 -and $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $confirmedPid })
            if ($listeners.Count -eq 1) { $ready=$true; break }
        }
    }
    if (!$ready) {
        Set-Content (Join-Path $runtime ($newRun+'.stop')) $newRun -Encoding ASCII
        throw 'Diagnostic tunnel did not become ready; no unverified listener was adopted.'
    }
    Get-Owner
    return
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
if ($Action -eq 'Stop') {
    $record=Get-Record
    if (!$record) {
        if (Test-Occupied) { throw 'Unverified tunnel listener remains; no owner record.' }
        return
    }
    if ($record.SessionId -cne $SessionId) { throw 'Only the creating desktop session may stop this tunnel.' }
    Set-Content (Join-Path $runtime ($record.RunId+'.stop')) $record.RunId -Encoding ASCII
    for ($n=0;$n -lt 40;$n++) {
        Start-Sleep -Milliseconds 200
        if (!(Get-Owner) -and !(Get-OwnedChild $record) -and !(Test-Occupied)) {
            Remove-OwnerIfMatch $record
            return
        }
    }
    # If the wrapper exited early, stop only the exact child proved by its
    # PID/start timestamp/executable/command line. Never kill the port owner.
    if (!(Get-Owner)) {
        $child=Get-OwnedChild $record
        if ($child) {
            Stop-Process -Id $child.Pid -ErrorAction Stop
            Start-Sleep -Milliseconds 300
        }
        if (!(Get-OwnedChild $record) -and !(Test-Occupied)) {
            Remove-OwnerIfMatch $record
            return
        }
    }
    throw 'Diagnostic tunnel shutdown has not been verified; retaining ownership for inspection.'
    return
}
if ($Action -eq 'Run') {
    $child=$null; $started=$null; $reservation=$null
    try {
        $until=[datetime]::UtcNow.AddSeconds(5)
        while ([datetime]::UtcNow -lt $until) {
            $owner=Get-Owner
            if ($owner -and $owner.RunId -ceq $RunId -and $owner.SessionId -ceq $SessionId -and $owner.Pid -eq $PID) { break }
            Start-Sleep -Milliseconds 100
        }
        if (!$owner -or $owner.Pid -ne $PID -or $owner.RunId -cne $RunId) { throw 'Tunnel wrapper identity not registered.' }
        $reservation=[IO.File]::Open($leaseFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $stamp=[Text.Encoding]::UTF8.GetBytes('diagnostic:'+$RunId)
        $reservation.Write($stamp,0,$stamp.Length)
        Check-Preflight
        $args=@('-N','-T','-L','127.0.0.1:15432:127.0.0.1:5432','-o','BatchMode=yes',
            '-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','IdentitiesOnly=yes',
            '-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',
            '-i',('"'+$identity+'"'),'ubuntu@217.142.225.255')
        $child=Start-Process $ssh -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtime ($RunId+'.err.log'))
        $started=$child.StartTime
        @{RunId=$RunId;Pid=$child.Id;StartedAt=$child.StartTime.ToUniversalTime().ToString('o')} |
            ConvertTo-Json | Set-Content (Join-Path $runtime ($RunId+'.child.json')) -Encoding UTF8
        for ($n=0;$n -lt 45;$n++) {
            $child.Refresh(); if ($child.HasExited) { break }
            $mine=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
                $_.LocalPort -eq 15432 -and $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $child.Id })
            if ($mine.Count -eq 1) {
                Set-Content -LiteralPath (Join-Path $runtime ($RunId+'.ready')) -Value $child.Id -Encoding ASCII
                break
            }
            Start-Sleep -Milliseconds 200
        }
        $expires=[datetime]::Parse($owner.ExpiresAt).ToUniversalTime()
        while ([datetime]::UtcNow -lt $expires) {
            $child.Refresh()
            if ($child.HasExited) { break }
            $stop=Join-Path $runtime ($RunId+'.stop')
            if (Test-Path $stop) { if ((Get-Content $stop -Raw).Trim() -ceq $RunId) { break } }
            Start-Sleep -Milliseconds 250
        }
    } finally {
        $record=Get-Record
        $owned=if ($record -and $record.RunId -ceq $RunId) { Get-OwnedChild $record } else { $null }
        if ($owned) {
            Stop-Process -Id $owned.Pid -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 250
        }
        $remaining=if ($record -and $record.RunId -ceq $RunId) { Get-OwnedChild $record } else { $null }
        if (!$remaining -and !(Test-Occupied)) {
            if ($record -and $record.RunId -ceq $RunId -and $record.Pid -eq $PID) { Remove-OwnerIfMatch $record }
            Remove-Item (Join-Path $runtime ($RunId+'.ready')) -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $runtime ($RunId+'.child.json')) -ErrorAction SilentlyContinue
        }
        if ($reservation) {
            $reservation.Dispose()
            try {
                if ([IO.File]::ReadAllText($leaseFile) -ceq ('diagnostic:'+$RunId)) { Remove-Item $leaseFile -ErrorAction SilentlyContinue }
            } catch { }
        }
    }
}
