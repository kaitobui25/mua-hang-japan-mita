# Inert WinForms smoke: no login, API writes, worker launches or service control.
# Uses synthetic screen data to validate layout at wide and minimum window widths.
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mita-desktop.ps1'))
$source=$source.Replace('$PSScriptRoot',("'" + $PSScriptRoot.Replace("'","''") + "'"))
$entry='[System.Windows.Forms.Application]::Run($form)'
$source=$source.TrimEnd()
if (!$source.EndsWith($entry)) { throw 'Unexpected Desktop entrypoint.' }
$injected=@'
$script:workerSmokeErrors=New-Object System.Collections.Generic.List[string]
$script:workerSmokeResults=New-Object System.Collections.Generic.List[string]
$script:workerSmokeIndex=0
$script:workerApi=('{"settings":{"version":1,"engine":"openrouter","schedules":{"amazon":"04:00","names":"05:00","detail":"05:15"}},"workers":{"amazon":{"state":"skipped","nextRun":"2026-11-02T19:00:00.000Z","nextActions":"Tôn trọng các chặn nguồn","coverage":null},"names":{"state":"completed","nextRun":"2026-11-02T20:00:00.000Z","nextActions":"Tên còn thiếu/lỗi theo quota","coverage":{"translated":832,"total":832}},"detail":{"state":"completed","nextRun":"2026-11-02T20:15:00.000Z","nextActions":"Dịch slot chưa hoàn tất","coverage":{"translated":5178,"total":12701}},"sync":{"state":"partial","nextRun":null,"nextActions":"Theo rào chắn và ledger","coverage":null}}}' | ConvertFrom-Json)
$script:workerSnapshot=('{"day":"2026-11-02","jobs":{"amazon":{"state":"skipped","updatedAt":"2026-11-01T19:06:05.420Z"},"names":{"state":"completed","updatedAt":"2026-11-01T20:00:29.521Z"},"detail":{"state":"completed","updatedAt":"2026-11-01T21:10:27.699Z"}},"sync":{"state":"partial","at":"2026-11-01T21:11:05.023Z"}}' | ConvertFrom-Json)
$script:role='owner'
$script:csrf=$null
foreach($key in @('amazon','names','detail','sync')) {
    $job=if($key -eq 'sync'){$script:workerSnapshot.sync}else{$script:workerSnapshot.jobs.$key}
    Set-WorkerTile $key $job $script:workerApi.workers.$key
}
$script:workerSmokeTimer=New-Object System.Windows.Forms.Timer
$script:workerSmokeTimer.Interval=650
$script:workerSmokeTimer.Add_Tick({
    try {
        $cases=@(
            @{Width=1850;Height=768;Key='amazon';Name='wide'},
            @{Width=1366;Height=768;Key='names';Name='medium'},
            @{Width=900;Height=600;Key='detail';Name='minimum'},
            @{Width=1100;Height=700;Key='sync';Name='sync'}
        )
        if ($script:workerSmokeIndex -ge $cases.Count) {
            $script:workerSelected='names'
            $script:role='staff'; Show-WorkerPanel
            if ($workerSave.Enabled -or $workerRun.Enabled) { throw 'Staff controls unexpectedly enabled.' }
            $script:role='owner'; $script:csrf=$null; Show-WorkerPanel
            if ($workerSave.Enabled -or $workerRun.Enabled) { throw 'Missing session token did not lock controls.' }
            $script:csrf='synthetic-smoke-token-never-sent'; $script:workerApi=$null; Show-WorkerPanel
            if ($workerSave.Enabled -or $workerRun.Enabled) { throw 'Missing Workers API did not lock controls.' }
            $script:workerSmokeTimer.Stop(); $form.Close(); return
        }
        $case=$cases[$script:workerSmokeIndex]
        $form.Size=New-Object Drawing.Size($case.Width,$case.Height)
        $form.Location=New-Object Drawing.Point(20,20)
        $script:role='owner'; $script:pending=$null
        $script:csrf='synthetic-smoke-token-never-sent'
        $script:workerSelected=$case.Key
        Show-WorkerPanel
        [System.Windows.Forms.Application]::DoEvents()
        if ($script:workerTiles.Count -ne 4) { throw 'Expected four worker choices.' }
        if ($workerScroll.Height -lt 120 -or !$workerScroll.AutoScroll) { throw ('Worker dashboard cannot scroll at '+$form.Size.Width+'x'+$form.Size.Height+', height='+$workerScroll.Height) }
        if ($workerSettings.Parent -eq $workerRight -and $workerSettings.Bottom -gt $workerRight.ClientSize.Height) { throw 'Worker action area is clipped.' }
        if ($form.Width -eq 900 -and $workerSettings.Parent -ne $workerBody) { throw 'Compact window must scroll settings together with details.' }
        if ($workerSave.Bottom -gt $workerActions.ClientSize.Height -or $workerRun.Bottom -gt $workerActions.ClientSize.Height) { throw 'Worker buttons are clipped.' }
        if ($workerFields.Bottom -gt $workerSettings.ClientSize.Height) { throw 'Worker settings fields clipped.' }
        if ($workerActions.Top -lt $workerFields.Bottom) { throw ('Worker actions overlap fields: heading='+$workerSettingsTitle.Top+'..'+$workerSettingsTitle.Bottom+' fields='+$workerFields.Top+'..'+$workerFields.Bottom+' actions='+$workerActions.Top+'..'+$workerActions.Bottom+' panel='+$workerSettings.Height) }
        if ($workerFields.Top -lt $workerSettingsTitle.Bottom) { throw ('Worker controls overlap the heading: '+$workerSettingsTitle.Top+'..'+$workerSettingsTitle.Bottom+' fields='+$workerFields.Top+'..'+$workerFields.Bottom) }
        if ($case.Key -eq 'sync' -and ($workerSave.Enabled -or $workerRun.Enabled)) { throw 'Sync actions must remain disabled.' }
        if ($case.Key -ne 'sync' -and (!$workerSave.Enabled -or !$workerRun.Enabled)) { throw 'Owner controls did not enable.' }
        if ($case.Key -eq 'names' -and $script:workerProgressPercent -ne 100) { throw ('Progress bar expected 100, got '+$script:workerProgressPercent) }
        if ($workerInfo.Text -match '(nextActions|nextRun|logPath|\\\\|C:\\phong)') { throw 'Raw technical data leaked into Worker panel.' }
        $dir=Join-Path $script:root '.agents/runtime'
        [void][IO.Directory]::CreateDirectory($dir)
        $bmp=New-Object Drawing.Bitmap($form.Width,$form.Height)
        try {
            $form.DrawToBitmap($bmp,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)))
            $bmp.Save((Join-Path $dir ('workers-ui-'+$case.Name+'.png')),[Drawing.Imaging.ImageFormat]::Png)
        } finally { $bmp.Dispose() }
        $script:workerSmokeResults.Add(($case.Name+': '+$case.Key+', controls '+$workerSettingsTitle.Bottom+'/'+$workerFields.Top+'/'+$workerFields.Bottom+'/'+$workerActions.Top+'/'+$workerActions.Bottom))
        $script:csrf=$null
        $script:workerSmokeIndex++
    } catch {
        $script:workerSmokeErrors.Add($_.Exception.Message)
        $script:workerSmokeTimer.Stop(); $form.Close()
    }
})
$form.Add_Shown({
    $timer.Stop(); $portTimer.Stop()
    $tabs.SelectedTab=$script:pages.Workers
    $script:workerSmokeTimer.Start()
})
[System.Windows.Forms.Application]::Run($form)
$script:workerSmokeTimer.Dispose()
foreach($line in $script:workerSmokeResults) { Write-Output $line }
if($script:workerSmokeErrors.Count) { throw ($script:workerSmokeErrors -join '; ') }
'@
Invoke-Expression ($source.Substring(0,$source.Length-$entry.Length)+$injected)
