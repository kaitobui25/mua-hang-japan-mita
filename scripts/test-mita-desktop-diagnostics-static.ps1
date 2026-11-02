# Windows PowerShell 5.1 static safety checks; never opens the app or network.
$ErrorActionPreference='Stop'
function Assert-True($ok,[string]$message) { if (!$ok) { throw $message } }
$texts=@{}
foreach ($name in @('mita-desktop.ps1','mita-desktop-ports.ps1','mita-desktop-diagnostics.ps1')) {
    $path=Join-Path $PSScriptRoot $name
    $tokens=$null; $errors=$null
    [void][System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    Assert-True ($errors.Count -eq 0) "Parser errors in $name"
    $bytes=[IO.File]::ReadAllBytes($path)
    Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) "UTF-8 BOM needed for $name"
    $texts[$name]=[IO.File]::ReadAllText($path)
}
$desktop=$texts['mita-desktop.ps1']
$diagnostics=$texts['mita-desktop-diagnostics.ps1']
$ports=$texts['mita-desktop-ports.ps1']
foreach ($marker in @("/desktop/snapshot", "/desktop/products?", "/desktop/overview?", "/desktop/logs?", 'Chỉ khác biệt', 'Đổi hiển thị', "SelectedIndex -eq 0")) {
    Assert-True ($diagnostics.Contains($marker) -or $desktop.Contains($marker)) "Missing source UI contract: $marker"
}
Assert-True ($desktop.Contains("if (`$productSource.SelectedIndex -ne 0)")) 'VPS mode must not allow PC visibility mutation'
Assert-True ($desktop.Contains("Refresh-View -ForceComparison")) 'Manual refresh must capture a new snapshot'
Assert-True ($diagnostics.Contains('Load-DesktopProducts') -and $diagnostics.Contains('Get-DifferenceCaption')) 'Missing comparison UI'
Assert-True ($diagnostics.Contains('Chưa thể so sánh PC/VPS') -and $diagnostics.Contains('không khả dụng')) 'Missing offline source state'
Assert-True ($ports.Contains('Get-PortDetailWidth') -and $ports.Contains('Save-PortDetailWidth')) 'Persistent detail width missing'
Assert-True ($ports.Contains('return 175') -and $ports.Contains('Panel2MinSize=155')) 'Narrow panel constraints missing'
Assert-True ($ports.Contains('Get-PortExplanation') -and $ports.Contains('Thông tin kỹ thuật')) 'Progressive detail is missing'
Assert-True ($diagnostics.Contains('hours=$hours') -and $diagnostics.Contains('168')) '7-day log filter missing'
Assert-True (!$diagnostics.Contains('ssh.exe') -and !$diagnostics.Contains('psql.exe')) 'UI must not initiate DB or SSH work'
Write-Output 'PASS: Desktop diagnostic tab wiring and PS5.1 syntax (static only).'
