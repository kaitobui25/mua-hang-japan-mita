# Local WinForms layout smoke. No backend, database, workers or network operations.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Assert-True($value,[string]$message) { if (!$value) { throw $message } }
$previous=$env:LOCALAPPDATA
$folder=Join-Path ([IO.Path]::GetTempPath()) ('mita-layout-test-'+[guid]::NewGuid().ToString('N'))
$env:LOCALAPPDATA=$folder
$script:role=$null; $script:csrf=$null; $script:pending=$null
$form=New-Object System.Windows.Forms.Form
$form.Size=New-Object System.Drawing.Size(1100,730)
$page=New-Object System.Windows.Forms.Panel
$page.Dock='Fill'; $form.Controls.Add($page)
try {
    . (Join-Path $PSScriptRoot 'mita-desktop-ports.ps1')
    Assert-True ((Get-PortDetailWidth) -eq 175) 'Incorrect default detail width'
    Initialize-PortTab $page
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Select-PortNode 'workers' -ShowDetails
    [System.Windows.Forms.Application]::DoEvents()
    $t=$script:portTopology
    Assert-True (!$t.Split.Panel2Collapsed) 'Details did not open'
    Assert-True ($t.Split.Panel2.Width -ge 155 -and $t.Split.Panel2.Width -le 210) "Details should open around 175px (actual $($t.Split.Panel2.Width); desired $($t.DetailWidth); container $($t.Split.Width))"
    Assert-True ($t.Detail.Text.Contains('tiến trình, không phải cổng')) 'Workers explanation not displayed'
    Assert-True (!$t.Detail.Text.Contains('Nguồn kiểm tra:')) 'Technical detail should initially be hidden'
    $t.ShowTechnical.Checked=$true
    Assert-True ($t.Detail.Text.Contains('Nguồn kiểm tra:')) 'Technical details did not expand'
    Save-PortDetailWidth 240
    Assert-True ((Get-PortDetailWidth) -eq 240) 'Width persistence failed'
    Save-PortDetailWidth 100
    Assert-True ((Get-PortDetailWidth) -eq 240) 'Invalid width must be ignored'
    Write-Output 'PASS: WinForms Cổng layout 175px, plain-language explanation, technical disclosure and saved width.'
} finally {
    $form.Close(); $form.Dispose()
    $env:LOCALAPPDATA=$previous
    if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
}
