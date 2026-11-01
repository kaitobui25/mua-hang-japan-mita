# Windows PowerShell 5.1. Invoke in-process from a background UI runspace.
# Pass CookieHeader/CsrfToken in memory, never command-line arguments or logs.
# Status is read-only. SyncNow requires explicit confirmation plus live Owner
# authorization at the coordinator. There is deliberately no Stop or force replay.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Status','SyncNow')][string]$Action,
    [ValidatePattern('^[a-zA-Z0-9-]{1,80}$')][string]$SessionId,
    [string]$CookieHeader,
    [string]$CsrfToken,
    [switch]$Confirmed,
    [switch]$ForceRerunConfirmed
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$recordPath=Join-Path $root '.agents/runtime/mita-supervisor.pid.json'
$supervisorPath=Join-Path $PSScriptRoot 'mita-supervisor.mjs'
$nightlyPath=Join-Path $PSScriptRoot 'nightly-vps-sync.ps1'

function Assert-SyncRequest {
    if ($ForceRerunConfirmed) { throw 'Forced rerun is unsupported: never replace/delete a daily ledger claim. Manual inspection required.' }
    if ($Action -eq 'SyncNow') {
        if (!$Confirmed -or !$SessionId) { throw 'SyncNow requires explicit confirmation and desktop SessionId.' }
        if ($CookieHeader -cnotmatch '^mita_admin=[a-f0-9]{64}$' -or $CsrfToken -cnotmatch '^[a-f0-9]{64}$') {
            throw 'SyncNow requires an in-memory Owner session cookie and CSRF token; a role string is not authorization.'
        }
    }
}
function Get-SyncCoordinator {
    if (!(Test-Path -LiteralPath $recordPath -PathType Leaf)) { throw 'Managed supervisor identity unavailable; no standalone sync fallback.' }
    $record=Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.Root -ine $root -or $record.Script -cne 'mita-supervisor.mjs' -or [int]$record.Id -le 0) { throw 'Invalid supervisor PID record.' }
    $process=Get-Process -Id $record.Id -ErrorAction Stop
    if ($process.ProcessName -ine 'node' -or $process.StartTime.ToUniversalTime().ToString('o') -cne $record.StartedAt) { throw 'Supervisor PID was reused or identity changed.' }
    $win=Get-CimInstance Win32_Process -Filter "ProcessId=$($record.Id)" -ErrorAction Stop
    $pattern='(?i)(?:^|\s)"?'+[regex]::Escape($supervisorPath)+'"?(?=\s|$)'
    if (!$win -or !$win.CommandLine -or $win.CommandLine -notmatch $pattern -or $win.ExecutablePath -notmatch '(?i)[\\/]node\.exe$') { throw 'Supervisor executable or script identity cannot be verified.' }
    $owner=Invoke-CimMethod -InputObject $win -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Supervisor belongs to another Windows user or owner is unknown.' }
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 19978)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1' -or $listeners[0].OwningProcess -ne $record.Id) { throw 'Supervisor loopback listener identity cannot be verified.' }
    return $record
}
function Assert-SyncReply($reply,$record) {
    if ($reply.protocol -cne 'mita-sync-v1') { throw 'Supervisor does not support the safe sync contract; no fallback.' }
    if (!$reply.ok) { throw ('Sync rejected: '+$reply.error) }
    if ($reply.root -ine $root -or $reply.pid -ne $record.Id -or $reply.supervisorRunId -cnotmatch '^[a-f0-9-]{36}$') { throw 'Coordinator reply identity mismatch.' }
    if ($Action -eq 'SyncNow' -and ($reply.state -cne 'accepted' -or !$reply.owner -or
        $reply.owner.supervisorRunId -cne $reply.supervisorRunId -or $reply.owner.supervisorPid -ne $record.Id -or
        $reply.owner.runId -cnotmatch '^[a-f0-9-]{36}$' -or [int]$reply.owner.pid -le 0 -or
        $reply.owner.sessionId -cne $SessionId -or $reply.owner.script -ine $nightlyPath)) {
        throw 'Sync acceptance lacks a matching script-owned PID/run identity. Refresh status; never retry automatically.'
    }
}
function Send-SyncRequest($message) {
    $tcp=New-Object Net.Sockets.TcpClient
    $reader=$null; $writer=$null
    try {
        $connect=$tcp.ConnectAsync('127.0.0.1',19978)
        if (!$connect.Wait(1500)) { throw 'Supervisor connection timed out.' }
        $stream=$tcp.GetStream(); $stream.ReadTimeout=if ($Action -eq 'Status') { 1500 } else { 14000 }; $stream.WriteTimeout=1500
        $reader=New-Object IO.StreamReader($stream)
        $writer=New-Object IO.StreamWriter($stream,(New-Object Text.UTF8Encoding($false)))
        $writer.AutoFlush=$true
        if ($reader.ReadLine() -cne 'Mita supervisor active') { throw 'Unrecognized supervisor banner.' }
        $writer.WriteLine(($message | ConvertTo-Json -Compress))
        # Bound the reply before parsing. No credentials are returned or persisted.
        $line=New-Object Text.StringBuilder
        while ($line.Length -lt 32768) {
            $character=$reader.Read()
            if ($character -lt 0) { throw 'Supervisor closed without a complete reply. Refresh status; no automatic retry.' }
            if ($character -eq 10) { return ($line.ToString() | ConvertFrom-Json) }
            $null=$line.Append([char]$character)
        }
        throw 'Supervisor response exceeded limit.'
    } finally {
        if ($writer) { $writer.Dispose() }; if ($reader) { $reader.Dispose() }; $tcp.Dispose()
    }
}

Assert-SyncRequest
$record=Get-SyncCoordinator
$message=@{protocol='mita-sync-v1';action=$Action}
if ($Action -eq 'SyncNow') {
    $message.sessionId=$SessionId; $message.cookie=$CookieHeader; $message.csrf=$CsrfToken
}
try { $reply=Send-SyncRequest $message } finally { $message.Clear(); $CookieHeader=$null; $CsrfToken=$null }
Assert-SyncReply $reply $record
# A response from a changed process is never accepted/adopted.
$fresh=Get-SyncCoordinator
if ($fresh.Id -ne $record.Id -or $fresh.StartedAt -cne $record.StartedAt) { throw 'Supervisor changed during request. Refresh status; no automatic retry.' }
$reply
