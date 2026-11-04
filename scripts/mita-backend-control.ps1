# Backend 4000 ONLY. Windows PowerShell 5.1. No API-role authorization needed.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Restart','Status','Run')][string]$Action,
    [ValidateSet('Start','Dev')][string]$Mode='Start',
    [ValidatePattern('^[a-zA-Z0-9-]{1,80}$')][string]$SessionId='manual',
    [switch]$OnlyIfSessionOwned,
    # Set ONLY after the UI/user explicitly confirms installing backend dependencies.
    [switch]$InstallDependenciesConfirmed,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$RunId
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend=Join-Path $root 'backend'
$runtime=Join-Path $root '.agents/runtime/backend-4000'
$recordPath=Join-Path $runtime 'owner.json'
$self=$PSCommandPath
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$launchedRecord=$null

function Write-BackendAudit([string]$result) {
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    @{ AtUtc=[DateTime]::UtcNow.ToString('o'); UserSid=$sid; SessionId=$SessionId;
       Action=$Action; Mode=$Mode; Result=$result } | ConvertTo-Json -Compress |
        Add-Content -LiteralPath (Join-Path $runtime 'audit.jsonl') -Encoding UTF8
}
function Get-BackendListeners {
    # Enumerate all listeners so a wildcard/IPv6/non-loopback bind also blocks start.
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 4000)
}
function Get-BackendOwner {
    if (!(Test-Path -LiteralPath $recordPath)) { return $null }
    $r=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($r.Root -ne $root -or $r.UserSid -ne $sid -or $r.RunId -notmatch '^[a-f0-9]{32}$' -or
        $r.SessionId -notmatch '^[a-zA-Z0-9-]{1,80}$' -or [int]$r.Id -le 0) { throw 'Invalid backend owner record or different Windows user.' }
    $p=Get-Process -Id $r.Id -ErrorAction SilentlyContinue
    if (!$p) { return $null } # Job closes automatically when its owning wrapper exits.
    # A previous job may have exited and Windows reused its PID. Never signal
    # the replacement process; with no listener, Start may replace this record.
    if ($p.ProcessName -ne 'powershell' -or $p.StartTime.ToUniversalTime().ToString('o') -ne $r.StartedAt) { return $null }
    $w=Get-CimInstance Win32_Process -Filter "ProcessId=$($r.Id)" -ErrorAction Stop
    if (!$w) { return $null }
    try {
        $ownerSid=Invoke-CimMethod -InputObject $w -MethodName GetOwnerSid -ErrorAction Stop
    } catch {
        # Exit race: CIM may report a process that vanishes before GetOwnerSid.
        # Only regard it as stopped if a fresh CIM lookup proves PID absent.
        if (!(Get-CimInstance Win32_Process -Filter "ProcessId=$($r.Id)" -ErrorAction Stop)) { return $null }
        throw
    }
    if ($ownerSid.ReturnValue -ne 0 -or $ownerSid.Sid -ne $sid -or
        $w.ExecutablePath -ne (Join-Path $PSHOME 'powershell.exe') -or
        !$w.CommandLine.Contains(('"'+$self+'"')) -or
        $w.CommandLine -notmatch ('(?i)-Action\s+Run\s+-Mode\s+(Start|Dev)\s+-SessionId\s+'+[regex]::Escape($r.SessionId)+'\s+-RunId\s+'+[regex]::Escape($r.RunId)+'(?:\s|$)')) {
        throw 'Cannot verify backend wrapper path, command line and Windows owner.'
    }
    return $r
}
function Test-BackendHealth([string]$expectedRun) {
    $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:4000/api/health')
    $request.Proxy=$null; $request.AllowAutoRedirect=$false; $request.Timeout=750; $request.ReadWriteTimeout=750
    $response=$null
    try {
        $response=$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { return $false }
        $reader=New-Object IO.StreamReader($response.GetResponseStream())
        try {
            # ReadBlock may wait for a full 4096-char buffer on keep-alive HTTP.
            # The health response is tiny; reject oversized content before parsing.
            if ($response.ContentLength -gt 4096) { return $false }
            $body=$reader.ReadToEnd()
            if (!$body -or $body.Length -gt 4096) { return $false }
            $h=$body | ConvertFrom-Json
            return ($h.ok -is [bool] -and $h.ok -and $h.lifecycleRunId -ceq $expectedRun)
        } finally { $reader.Dispose() }
    } catch { return $false } finally { if ($response) { $response.Dispose() }; $request.Abort() }
}
function Assert-MitaPostgresIdentity($process,[string]$bin,[string]$data,[string]$reportedData) {
    $expected=(Resolve-Path -LiteralPath $data).Path
    $exe=Join-Path $bin 'postgres.exe'
    if (!$process -or $process.ExecutablePath -ine $exe) { throw 'Port 5433 process is not the expected PostgreSQL executable.' }
    $match=[regex]::Match([string]$process.CommandLine,'(?i)(?:^|\s)-D\s+(?:"([^"]+)"|(\S+))(?=\s|$)')
    if (!$match.Success) { throw 'PostgreSQL data-directory argument cannot be verified.' }
    $launchDir=if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if ([IO.Path]::IsPathRooted($launchDir)) {
        if ((Resolve-Path -LiteralPath $launchDir).Path -ine $expected) { throw 'PostgreSQL launched with a different cluster path.' }
    } elseif (($launchDir.Replace('\','/') -replace '^\./','') -ine 'backend/.local-db') {
        throw 'PostgreSQL relative cluster path is not recognized.'
    }
    if ((Resolve-Path -LiteralPath $reportedData).Path -ine $expected) {
        throw 'PostgreSQL server reports a different data directory.'
    }
}
function Assert-ExistingLocalDatabase([string]$bin,[string]$data) {
    # pg_isready alone could accept an unrelated PostgreSQL on 5433.
    $pidFile=Join-Path $data 'postmaster.pid'
    if (!(Test-Path -LiteralPath $pidFile -PathType Leaf)) { throw 'Mita PostgreSQL cluster PID file is absent.' }
    $pidLine=(Get-Content -LiteralPath $pidFile -TotalCount 1 -Encoding ASCII).Trim()
    if ($pidLine -notmatch '^[1-9][0-9]{0,9}$') { throw 'Invalid existing Mita PostgreSQL PID.' }
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 5433 -and $_.LocalAddress -eq '127.0.0.1' })
    if (@($listeners | Where-Object OwningProcess -eq ([int]$pidLine)).Count -ne 1) {
        throw 'Port 5433 does not belong to the existing Mita PostgreSQL cluster.'
    }
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$pidLine" -ErrorAction Stop
    if (!$process) { throw 'PostgreSQL listener process vanished.' }
    $previousTimeout=$env:PGCONNECT_TIMEOUT
    $env:PGCONNECT_TIMEOUT='3'
    try {
        $reportedData=@(& (Join-Path $bin 'psql.exe') -X -w -h 127.0.0.1 -p 5433 -U mita_local -d postgres -At -c 'SHOW data_directory' 2>$null)
        if ($LASTEXITCODE -ne 0 -or $reportedData.Count -ne 1) { throw 'Cannot verify Mita PostgreSQL server data directory.' }
    } finally { $env:PGCONNECT_TIMEOUT=$previousTimeout }
    Assert-MitaPostgresIdentity $process $bin $data ([string]$reportedData[0])
    & (Join-Path $bin 'pg_ctl.exe') status -D $data | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Existing Mita PostgreSQL cluster is not running.' }
}
function Confirm-LocalDatabase {
    $bin='C:\Program Files\PostgreSQL\18\bin'
    $data=Join-Path $backend '.local-db'
    foreach ($file in @((Join-Path $bin 'pg_isready.exe'),(Join-Path $bin 'pg_ctl.exe'),(Join-Path $bin 'psql.exe'),(Join-Path $bin 'postgres.exe'),(Join-Path $data 'PG_VERSION'))) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Existing local PostgreSQL 18 cluster required; never initialized by this helper.' }
    }
    & (Join-Path $bin 'pg_isready.exe') -h 127.0.0.1 -p 5433 -t 1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Assert-ExistingLocalDatabase $bin $data; return }
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 5433)
    if ($listeners.Count) { throw 'Port 5433 occupied but PostgreSQL not ready; refusing to start another database.' }
    # Never create/init/migrate a DB, never stop it, never invoke start-local.ps1.
    & (Join-Path $bin 'pg_ctl.exe') -D $data -l (Join-Path $backend '.local-postgres.log') -o '-p 5433 -h 127.0.0.1' -w -t 15 start | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Existing local PostgreSQL could not start.' }
    Assert-ExistingLocalDatabase $bin $data
    Write-BackendAudit 'existing-local-postgresql-started'
}
function Stop-OwnedBackend($record) {
    if (!$record) { Write-BackendAudit 'already-stopped'; return }
    if ($OnlyIfSessionOwned -and $record.SessionId -cne $SessionId) { Write-BackendAudit 'different-session-left-running'; return }
    # Revalidate immediately before signaling; no PID termination or port-based kill.
    $fresh=Get-BackendOwner
    if (!$fresh -or $fresh.RunId -cne $record.RunId) { throw 'Backend ownership changed.' }
    Set-Content -LiteralPath (Join-Path $runtime ($record.RunId+'.stop')) -Value $record.RunId -Encoding ASCII
    $deadline=[DateTime]::UtcNow.AddSeconds(12)
    do {
        if (!(Get-BackendOwner)) { Write-BackendAudit 'stopped'; return }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Backend stop timed out; no arbitrary process was terminated.'
}

if ($Action -eq 'Run') {
    # Private wrapper entry point. Starts no service without a matching launch record.
    if (!$RunId) { throw 'Run requires a launch ID.' }
    $deadline=[DateTime]::UtcNow.AddSeconds(5); $record=$null
    do {
        if (Test-Path -LiteralPath $recordPath) {
            $candidate=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($candidate.RunId -ceq $RunId -and $candidate.Id -eq $PID) { $record=Get-BackendOwner; break }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$record -or $record.Mode -cne $Mode -or $record.SessionId -cne $SessionId) { throw 'Matching launch authorization not found.' }
    $job=$null
    try {
        Add-Type -Path (Join-Path $PSScriptRoot 'mita-backend-job.cs')
        # Override inherited remote/API configuration in this child process only.
        $env:API_PORT='4000'; $env:DATABASE_URL='postgresql://mita_local@127.0.0.1:5433/postgres'
        # Local purchase-assistance uses the same DB as catalog and checkout.
        # AMAZON_ACCESS_LOCK and source_access_blocks still block denied Amazon access.
        $env:AMAZON_QUOTES_ENABLED='1'
        $env:MITA_VPS_WORKER=$null
        $env:MITA_BACKEND_RUN_ID=$RunId
        $env:MITA_BACKEND_STOP_FILE=Join-Path $runtime ($RunId+'.backend-stop')
        $npm=(Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
        $script=if ($Mode -eq 'Dev') { 'dev' } else { 'start' }
        $out=Join-Path $runtime ($RunId+'.out.log'); $err=Join-Path $runtime ($RunId+'.err.log')
        # cmd metacharacters in paths must never become executable input.
        foreach ($path in @($npm,$out,$err)) { if ($path -match '[%"\r\n!]') { throw 'Unsupported command path characters.' } }
        $cmd=Join-Path $env:SystemRoot 'System32\cmd.exe'
        $command='"'+$cmd+'" /d /s /c ""'+$npm+'" run '+$script+' 1>>"'+$out+'" 2>>"'+$err+'""'
        $job=New-Object MitaBackendJob($cmd,$command,$backend)
        $stop=Join-Path $runtime ($RunId+'.stop')
        while (!$job.HasExited) {
            if ((Test-Path -LiteralPath $stop) -and (Get-Content -LiteralPath $stop -Raw).Trim() -ceq $RunId) {
                Set-Content -LiteralPath $env:MITA_BACKEND_STOP_FILE -Value $RunId -Encoding ASCII
                Start-Sleep -Seconds 3
                break
            }
            Start-Sleep -Milliseconds 200
        }
    } finally {
        if ($job) { $job.Dispose() } # Close only this job; contains npm and all tsx/watch children.
        Write-BackendAudit 'wrapper-exited-no-restart'
    }
    return
}

# Serialize UI/CLI mutations across sessions for this repo and Windows user.
$hash=[Security.Cryptography.SHA256]::Create()
try { $key=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()+$sid)))).Replace('-','') } finally { $hash.Dispose() }
$mutex=New-Object Threading.Mutex($false,('Local\MitaBackend4000-'+$key))
$locked=$false
try {
    try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (!$locked) { throw 'Another backend lifecycle operation is in progress.' }
    $record=Get-BackendOwner
    $listeners=@(Get-BackendListeners)
    if ($listeners.Count -and (!$record -or !(Test-BackendHealth $record.RunId))) {
        # Stop of an owned job remains possible after health failure, but never touches this listener.
        if ($Action -ne 'Stop' -or !$record) { throw 'Unknown or unhealthy listener on 4000; refusing start/restart/adoption.' }
    }
    if ($Action -eq 'Status') {
        [pscustomobject]@{ State=$(if ($record) { if (Test-BackendHealth $record.RunId) { 'ready' } else { 'unhealthy' } } else { 'stopped' }); Owner=$record }
        return
    }
    if ($Action -in @('Stop','Restart')) {
        Stop-OwnedBackend $record
        if ($Action -eq 'Stop') { return }
        if ($OnlyIfSessionOwned -and $record -and $record.SessionId -cne $SessionId) { throw 'Restart refused: backend belongs to another desktop session.' }
        $record=$null
    }
    if ($record) {
        Write-BackendAudit 'already-running-not-adopted'
        [pscustomobject]@{ State='already-running'; Started=$false; Owner=$record }
        return
    }
    if (@(Get-BackendListeners).Count) { throw 'Port 4000 is occupied; refusing start.' }
    $null=Get-Command node.exe,npm.cmd -CommandType Application -ErrorAction Stop
    $package=Get-Content -LiteralPath (Join-Path $backend 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $missing=@(@($package.dependencies.PSObject.Properties.Name)+@($package.devDependencies.PSObject.Properties.Name) | Where-Object {
        !(Test-Path -LiteralPath (Join-Path $backend ('node_modules/'+$_+'/package.json')))
    })
    if ($missing.Count -or !(Test-Path -LiteralPath (Join-Path $backend 'node_modules/.bin/tsx.cmd'))) {
        if (!$InstallDependenciesConfirmed) { throw 'Backend dependencies missing. Ask user to confirm installation, then retry with -InstallDependenciesConfirmed.' }
        Write-BackendAudit 'dependency-install-confirmed'
        Push-Location $backend
        try { & npm.cmd install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' } } finally { Pop-Location }
    }
    Confirm-LocalDatabase
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $RunId=[Guid]::NewGuid().ToString('N')
    $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$self+'" -Action Run -Mode '+$Mode+' -SessionId '+$SessionId+' -RunId '+$RunId
    $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime ($RunId+'.wrapper.out.log')) -RedirectStandardError (Join-Path $runtime ($RunId+'.wrapper.err.log'))
    $record=[pscustomobject]@{ Root=$root; UserSid=$sid; SessionId=$SessionId; RunId=$RunId; Id=$p.Id; StartedAt=$p.StartTime.ToUniversalTime().ToString('o'); Mode=$Mode }
    $temp=Join-Path $runtime ($RunId+'.owner.tmp')
    $record | ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $recordPath -Force
    $launchedRecord=$record
    Write-BackendAudit 'launched'
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
        if (!(Get-BackendOwner)) { throw 'Backend wrapper exited; inspect per-run logs. No automatic restart.' }
        if (Test-BackendHealth $RunId) {
            Write-BackendAudit 'ready'
            [pscustomobject]@{ State='ready'; Started=$true; Owner=$record }
            return
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Stop-OwnedBackend $record
    throw 'Backend health readiness timed out after 30 seconds; owned job stopped.'
} catch {
    # Roll back only the newly launched, reverified job, including probe/CIM failures.
    if ($launchedRecord) {
        try { Stop-OwnedBackend $launchedRecord } catch { Write-BackendAudit 'owned-startup-cleanup-unconfirmed' }
    }
    Write-BackendAudit 'rejected-or-failed'
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
