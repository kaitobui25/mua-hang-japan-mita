# Windows PowerShell 5.1. Static and inert UI checks; no database or worker commands.
$ErrorActionPreference='Stop'
$paths=@(
    (Join-Path $PSScriptRoot 'mita-desktop.ps1'),
    (Join-Path $PSScriptRoot 'mita-desktop-workers.ps1')
)
foreach ($path in $paths) {
    $tokens=$null; $errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw ('Parser error in ' + $path + ': ' + ($errors | Out-String)) }
    $bytes=[IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) {
        throw ('PowerShell 5.1 UTF-8 BOM missing: ' + $path)
    }
}
$ui=[IO.File]::ReadAllText($paths[1])
$main=[IO.File]::ReadAllText($paths[0])
foreach ($required in @(
    'amazon','names','detail','sync','SplitContainer',
    'Show-WorkerPanel','Set-WorkerControls','Refresh-Workers',
    'Can-Write','Confirm-Write','/workers/settings','/workers/run',
    'workerApi','workerSnapshot','maxProducts','requestId','Get-Item'
)) {
    if (!$ui.Contains($required)) { throw ('Missing worker UI contract: ' + $required) }
}
foreach ($required in @('. (Join-Path $PSScriptRoot ''mita-desktop-workers.ps1'')','Refresh-Workers','Set-WorkerControls')) {
    if (!$main.Contains($required)) { throw ('Desktop not wired to worker component: ' + $required) }
}
if ($ui -match '(?im)^[ \t]*(?:Start-Process|Stop-Process|Invoke-Expression|Remove-Item)\b') {
    throw 'Worker component must not directly manipulate processes'
}
if ($ui.Contains('views.Workers')) { throw 'Obsolete text-only view retained' }
Write-Output 'PASS: Workers WinForms component parsed with PS 5.1, has BOM, four tiles and owner-gated controls.'
