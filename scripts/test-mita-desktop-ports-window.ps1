# Live WinForms-only smoke test. No lifecycle commands or simulated service states.
# Captures the actual visible window at two sizes and both layouts.
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mita-desktop.ps1'))
$source=$source.Replace('$PSScriptRoot',("'"+$PSScriptRoot.Replace("'","''")+"'"))
$entry='[System.Windows.Forms.Application]::Run($form)'
$source=$source.TrimEnd()
if (!$source.EndsWith($entry)) { throw 'Desktop entrypoint changed; refuse injection.' }
$injected=@'
$script:smokeResults=New-Object System.Collections.Generic.List[string]
$script:smokeErrors=New-Object System.Collections.Generic.List[string]
$script:smokeStage=0
$script:smokeTimer=New-Object System.Windows.Forms.Timer
$script:smokeTimer.Interval=750
$script:smokeTimer.Add_Tick({
    try {
        $t=$script:portTopology
        $cases=@(
            @{ Width=1366; Height=768; Layout=0; Name='graph-1366' },
            @{ Width=900; Height=600; Layout=1; Name='list-900' }
        )
        if ($script:smokeStage -lt $cases.Count) {
            $case=$cases[$script:smokeStage]
            $form.Size=New-Object Drawing.Size($case.Width,$case.Height)
            $form.Location=New-Object Drawing.Point(30,30)
            $t.Layout.SelectedIndex=$case.Layout
            Select-PortNode 'pc-api'
            [System.Windows.Forms.Application]::DoEvents()
            if (!$t.BackendBar.Visible) { throw 'Backend controls not visible for 4000.' }
            if ($t.BackendBar.Bottom -gt $script:pages.Ports.ClientSize.Height -or $t.BackendBar.Top -lt 0) { throw 'Backend bar clipped.' }
            if (!$t.BackendBar.Controls.Contains($t.BackendStart) -or !$t.BackendBar.Controls.Contains($t.BackendStop) -or !$t.BackendBar.Controls.Contains($t.BackendRestart)) { throw 'Missing backend controls.' }
            if ($t.Selected -ne 'pc-api') { throw 'Selection lost.' }
            $dir=Join-Path $script:root '.agents/runtime/backend-4000'
            [void][IO.Directory]::CreateDirectory($dir)
            $bmp=New-Object Drawing.Bitmap($form.Width,$form.Height)
            try {
                # Draw the entire actual WinForms tree, independent of system DPI
                # and physical monitor cropping at 150% scaling.
                $form.DrawToBitmap($bmp,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)))
                $bmp.Save((Join-Path $dir ('ui-'+$case.Name+'.png')),[Drawing.Imaging.ImageFormat]::Png)
            } finally { $bmp.Dispose() }
            $script:smokeResults.Add(('{0}: selected={1}; bar={2}; barY={3}; detailY={4}; mode={5}' -f $case.Name,$t.Selected,$t.BackendBar.Visible,$t.BackendBar.Top,$t.Detail.Top,$t.BackendMode.Text))
            $script:smokeStage++
        } else {
            Select-PortNode 'pc-db'
            if ($t.BackendBar.Visible) { throw 'Backend controls visible on DB node.' }
            $script:smokeResults.Add('Non-4000 node hides controls.')
            $script:smokeTimer.Stop(); $form.Close()
        }
    } catch {
        $script:smokeErrors.Add($_.Exception.Message)
        $script:smokeTimer.Stop(); $form.Close()
    }
})
$form.Add_Shown({
    $tabs.SelectedTab=$script:pages.Ports
    Select-PortNode 'pc-api'
    $script:smokeTimer.Start()
})
[System.Windows.Forms.Application]::Run($form)
$script:smokeTimer.Dispose()
foreach ($line in $script:smokeResults) { Write-Output $line }
if ($script:smokeErrors.Count) { throw ($script:smokeErrors -join '; ') }
'@
Invoke-Expression ($source.Substring(0,$source.Length-$entry.Length)+$injected)
