# PowerShell 5.1-only static and isolated safety tests. Never opens SSH/DB.
$ErrorActionPreference='Stop'
function Assert-Diagnostic($condition,[string]$message) { if (!$condition) { throw $message } }
$file=Join-Path $PSScriptRoot 'mita-tunnel-diagnostic.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
Assert-Diagnostic ($errors.Count -eq 0) 'Diagnostic PowerShell 5.1 parse failed'
$source=[IO.File]::ReadAllText($file)
foreach ($required in @('UserSid','StartedAt','CommandLine','BatchMode=yes','StrictHostKeyChecking=yes','ExitOnForwardFailure=yes','ExpiresAt','AddMinutes(5)','Get-Owner','Get-OwnedChild','15432','Stop-Process','Only the creating desktop session','tunnel-15432.lease','FileMode]::CreateNew','A verified updated Sync supervisor','Local\MitaTunnel15432-','ReleaseMutex()')) {
    Assert-Diagnostic ($source.Contains($required)) "Missing diagnostic safety invariant: $required"
}
$bytes=[IO.File]::ReadAllBytes($file)
Assert-Diagnostic ($bytes.Length -gt 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'PowerShell 5.1 requires UTF-8 BOM'
foreach ($name in @('Get-Record','Get-Owner','Check-Preflight')) {
    Assert-Diagnostic ($null -ne $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)) "Missing $name"
}
Assert-Diagnostic ($source.Contains('$record.SessionId -cne $SessionId')) 'Stop must reject another Desktop session'
Assert-Diagnostic ($source.Contains('$record.Pid -eq $PID')) 'Wrapper must clean up only its own owner record'
Assert-Diagnostic ($source.Contains('OwningProcess -eq $child.Id')) 'Tunnel readiness must bind exact created SSH PID'
Assert-Diagnostic ($source.Contains('Get-OwnedChild $record') -and $source.Contains('Get-Record')) 'Missing wrapper must not silently clear an owned SSH child'
Assert-Diagnostic ($source.Contains('$_') -and $source.Contains('Get-NetTCPConnection')) 'Tunnel must check listener ownership'
Write-Output 'PASS: PS5.1 parse and owner/session/expiry/SSH provenance contracts; no live tunnel started.'
