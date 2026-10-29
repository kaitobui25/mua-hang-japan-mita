# Mita-only, append-only review image transfer. Normally spawned by mita-supervisor.
# Never operates on E-KAIWA, deletes published files, or installs remote services.
[CmdletBinding()]
param(
  [switch]$ValidateOnly,
  [string]$SourceDirectory
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$localDirectory = Join-Path $root 'public/reviews'
$runtime = Join-Path $root '.agents/runtime'
$statePath = Join-Path $runtime 'mita-review-sync-state.json'
$sshTarget = 'ubuntu@217.142.225.255'
$remoteReceiver = '/opt/mita/shared/bin/mita-review-receiver.py'
$remoteIncoming = '/opt/mita/shared/review-incoming'
$maxSize = 8 * 1024 * 1024
$maxUploadPerRun = 12
$maxCandidates = 300
$maxImages = 120
$recheckAfterMinutes = 60
$namePattern = '^(?![. ])[\p{L}\p{N}_ ().-]{1,180}\.(?:png|jpe?g|webp)$'

if ($SourceDirectory) {
  if (!$ValidateOnly) { throw 'SourceDirectory is available only for offline validation' }
  $allowedTestRoot = [IO.Path]::GetFullPath((Join-Path $root '.verification'))
  $selected = [IO.Path]::GetFullPath($SourceDirectory)
  if (!$selected.StartsWith($allowedTestRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Offline test directory must be within .verification'
  }
  $localDirectory = $selected
}
if (!$ValidateOnly -and $env:MITA_REVIEW_SYNC_ENABLED -ne '1') { Write-Output 'Review sync disabled (MITA_REVIEW_SYNC_ENABLED is not 1)'; return }
if (!(Test-Path -LiteralPath $localDirectory -PathType Container)) { Write-Output 'Review source folder missing; skipping'; return }
if (((Get-Item -LiteralPath $localDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Review source cannot be a symlink/junction'
}

function Get-ValidatedImage([IO.FileInfo]$entry) {
  if ($entry.Name -notmatch $namePattern -or $entry.Name -match '(?i)^review-demo-\d+\.(png|jpe?g|webp)$') { return $null }
  if ([Text.Encoding]::UTF8.GetByteCount($entry.Name) -gt 240) { return $null }
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($entry.Attributes -band [IO.FileAttributes]::Hidden) -ne 0 -or
      ($entry.Attributes -band [IO.FileAttributes]::System) -ne 0) { return $null }
  # Do not pick up a file that has only just been copied into the folder.
  if ($entry.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddSeconds(-30)) { return $null }
  if ($entry.Length -lt 12 -or $entry.Length -gt $maxSize) { return $null }
  # Keep a deny-write/delete handle open through scp so the source can't change mid-transfer.
  $stream = [IO.File]::Open($entry.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $entry.Length) { $stream.Dispose(); return $null }
    $header = New-Object byte[] 12
    if ($stream.Read($header, 0, 12) -ne 12) { $stream.Dispose(); return $null }
    $ext = [IO.Path]::GetExtension($entry.Name).ToLowerInvariant()
    $png = (@(137,80,78,71,13,10,26,10) -join ',') -eq (($header[0..7]) -join ',')
    $jpeg = $header[0] -eq 255 -and $header[1] -eq 216 -and $header[2] -eq 255
    $webp = [Text.Encoding]::ASCII.GetString($header, 0, 4) -eq 'RIFF' -and [Text.Encoding]::ASCII.GetString($header, 8, 4) -eq 'WEBP'
    if (!(($ext -eq '.png' -and $png) -or ($ext -in @('.jpg','.jpeg') -and $jpeg) -or ($ext -eq '.webp' -and $webp))) {
      $stream.Dispose(); return $null
    }
    $stream.Position = 0
    $sha = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stream.Length -ne $entry.Length) { $stream.Dispose(); return $null }
    return @{ Name=$entry.Name; Path=$entry.FullName; Sha256=$sha; Stream=$stream }
  } catch { $stream.Dispose(); throw }
}

function Test-CachedReviewFresh($cached, [string]$digest, [datetimeoffset]$now) {
  if (!$cached -or $cached.Sha256 -ne $digest) { return $false }
  $confirmed = [datetimeoffset]::MinValue
  if (![datetimeoffset]::TryParse($cached.ConfirmedAt, [ref]$confirmed)) { return $false }
  $age = ($now - $confirmed.ToUniversalTime()).TotalMinutes
  return $age -ge 0 -and $age -lt $recheckAfterMinutes
}

function Get-RemoteDisposition([string]$answer) {
  if ($answer -eq 'HAVE') { return 'already-present' }
  if ($answer -eq 'MISSING') { return 'upload' }
  if ($answer -eq 'CONFLICT') { return 'conflict' }
  throw 'Unknown response from Mita review receiver'
}

$files = @(Get-ChildItem -LiteralPath $localDirectory -File -Force |
  Where-Object { $_.Name -match $namePattern -and $_.Name -notmatch '(?i)^review-demo-\d+\.(png|jpe?g|webp)$' } |
  Sort-Object Name | Select-Object -First $maxCandidates)
$considered = 0; $uploaded = 0; $skipped = 0; $validated = 0; $conflicts = 0

if (!$ValidateOnly) {
  if ((Get-Service ssh-agent -ErrorAction Stop).Status -ne 'Running') { throw 'Windows ssh-agent unavailable' }
  $key = Join-Path $env:USERPROFILE '.ssh/oracle_20260624'
  if (!(Test-Path -LiteralPath $key -PathType Leaf) -or !(Test-Path -LiteralPath "$key.pub" -PathType Leaf)) { throw 'Approved Mita SSH identity unavailable' }
  $keyFingerprintText = (& ssh-keygen.exe -lf "$key.pub" 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or $keyFingerprintText -notmatch 'SHA256:[A-Za-z0-9+/]+') { throw 'Cannot verify approved SSH key fingerprint' }
  $fingerprint = $Matches[0]
  $agentIdentities = (& ssh-add.exe -l 2>$null) -join ' '
  if ($LASTEXITCODE -ne 0 -or !$agentIdentities.Contains($fingerprint)) { throw 'Approved Mita SSH key is not loaded in ssh-agent' }
  $commonOptions = @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',
    '-o','ConnectTimeout=12','-o','ConnectionAttempts=1','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-i',$key)
  New-Item -Path $runtime -ItemType Directory -Force | Out-Null
  try { $runLock = [IO.File]::Open((Join-Path $runtime 'mita-review-sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch [IO.IOException] { Write-Output 'Another Mita review sync is already running; skipping'; return }
  # This cache records acknowledged remote hashes, not image backups. Missing/changed images are rechecked remotely.
  $seen = @{}
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
      $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($previous.version -eq 1) {
        foreach ($property in $previous.images.PSObject.Properties) {
          $item = $property.Value
          if ($item.Sha256 -match '^[a-f0-9]{64}$' -and $item.ConfirmedAt -is [string]) {
            $seen[$property.Name] = @{ Sha256=$item.Sha256; ConfirmedAt=$item.ConfirmedAt }
          }
        }
      }
    } catch { $seen = @{} }
  }
  $dirty = $false
}
try {
  foreach ($entry in $files) {
    if ($considered -ge $maxImages) { break }
    $considered++
    $image = Get-ValidatedImage $entry
    if ($null -eq $image) { $skipped++; continue }
    try {
      $validated++
      if ($ValidateOnly) { Write-Output ('VALID ' + $image.Name); continue }
      if (Test-CachedReviewFresh $seen[$image.Name] $image.Sha256 ([datetimeoffset]::UtcNow)) { $skipped++; continue }
      $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($image.Name)).TrimEnd('=').Replace('+','-').Replace('/','_')
      if ($base64 -notmatch '^[a-zA-Z0-9_-]{1,300}$') { throw 'Filename encoding rejected' }
      $remoteCheck = 'python3 ' + $remoteReceiver + ' check ' + $base64 + ' ' + $image.Sha256
      $answer = @(& ssh.exe @commonOptions $sshTarget $remoteCheck 2>$null)
      if ($LASTEXITCODE -ne 0 -or $answer.Count -ne 1) { throw 'Remote Mita review preflight unavailable' }
      $disposition = Get-RemoteDisposition $answer[0]
      if ($disposition -eq 'conflict') {
        # Filename collision is isolated: do not block independent approved images.
        $conflicts++
        continue
      }
      if ($disposition -eq 'upload') {
        if ($uploaded -ge $maxUploadPerRun) { break }
        $token = [Guid]::NewGuid().ToString('N').ToLowerInvariant()
        $remoteStage = $sshTarget + ':' + $remoteIncoming + '/.incoming-' + $token + '.tmp'
        # Local path may have spaces; explicit quotes preserve it in Windows PowerShell 5.1.
        & scp.exe -q -B @commonOptions ('"' + $image.Path + '"') $remoteStage 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Mita review upload failed' }
        $remoteFinish = 'python3 ' + $remoteReceiver + ' finish ' + $base64 + ' ' + $image.Sha256 + ' ' + $token
        $finish = @(& ssh.exe @commonOptions $sshTarget $remoteFinish 2>$null)
        if ($LASTEXITCODE -ne 0 -or $finish.Count -ne 1 -or $finish[0] -notin @('PUBLISHED','HAVE')) {
          throw 'Mita review publication failed; staged temp may require operator cleanup'
        }
        $uploaded++
      }
      $seen[$image.Name] = @{Sha256=$image.Sha256; ConfirmedAt=[datetimeoffset]::UtcNow.ToString('o')}
      $dirty = $true
    } finally { $image.Stream.Dispose() }
  }
} finally {
  try {
    if (!$ValidateOnly -and $dirty) {
      $tempState = $statePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
      try {
        @{version=1;images=$seen} | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $tempState -Encoding UTF8
        Move-Item -LiteralPath $tempState -Destination $statePath -Force
      } finally { if (Test-Path -LiteralPath $tempState) { Remove-Item -LiteralPath $tempState -Force } }
    }
  } finally {
    if ($runLock) { $runLock.Dispose() }
  }
}
Write-Output ('Review sync local scanned=' + $considered + ' valid=' + $validated + ' skipped=' + $skipped + ' uploaded=' + $uploaded + ' conflicts=' + $conflicts)
if ($conflicts -gt 0) { exit 2 }
