# Local-only source validation, never opens an SSH session or modifies VPS.
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$directory=Join-Path $root '.verification/mita-review-sync-tests'
if (Test-Path -LiteralPath $directory) { throw 'Refusing to replace existing test directory' }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
try {
  $source=Join-Path $root 'public/reviews/review-demo-01.png'
  # Use codepoint construction so Windows PowerShell 5.1 reads this test without UTF-8 BOM issues.
  $approvedName=([string][char]0x0110) + 'uoc duyet.png'
  Copy-Item -LiteralPath $source -Destination (Join-Path $directory $approvedName)
  Copy-Item -LiteralPath $source -Destination (Join-Path $directory 'review-demo-88.png')
  Copy-Item -LiteralPath $source -Destination (Join-Path $directory 'not-an-image.txt')
  $invalid=Join-Path $directory 'invalid.png'
  [IO.File]::WriteAllBytes($invalid, [Text.Encoding]::ASCII.GetBytes('false image header'))
  (Get-Item -LiteralPath $invalid).LastWriteTimeUtc=[DateTime]::UtcNow.AddMinutes(-2)
  $fresh=Join-Path $directory 'fresh-copy.png'
  Copy-Item -LiteralPath $source -Destination $fresh
  (Get-Item -LiteralPath $fresh).LastWriteTimeUtc=[DateTime]::UtcNow
  $output=@(& (Join-Path $PSScriptRoot 'sync-mita-reviews.ps1') -ValidateOnly -SourceDirectory $directory)
  if ($output.Count -ne 2 -or $output[0] -ne ('VALID ' + $approvedName) -or $output[1] -ne 'Review sync local scanned=3 valid=1 skipped=2 uploaded=0 conflicts=0') {
    throw ('Unexpected offline validator output: '+ ($output -join ' | '))
  }
  # Dot-source an offline run to exercise scheduling decisions with no network.
  $null = . (Join-Path $PSScriptRoot 'sync-mita-reviews.ps1') -ValidateOnly -SourceDirectory $directory
  $now = [datetimeoffset]::UtcNow
  $digest = 'a' * 64
  $recent = @{Sha256=$digest; ConfirmedAt=$now.AddMinutes(-5).ToString('o')}
  $expired = @{Sha256=$digest; ConfirmedAt=$now.AddMinutes(-70).ToString('o')}
  if (!(Test-CachedReviewFresh $recent $digest $now)) { throw 'Fresh remote acknowledgement should avoid redundant upload' }
  if (Test-CachedReviewFresh $expired $digest $now) { throw 'Expired acknowledgement must recheck remote (may have been removed)' }
  if (Test-CachedReviewFresh $recent ('b'*64) $now) { throw 'Changed local image must be rechecked immediately' }
  if ((Get-RemoteDisposition 'CONFLICT') -ne 'conflict' -or (Get-RemoteDisposition 'MISSING') -ne 'upload') {
    throw 'Conflict must be isolated; missing must upload'
  }
  Write-Output 'PASS: valid owner image accepted; demo excluded; fake signature and unsupported extension rejected'
} finally {
  if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
