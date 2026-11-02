# Hallmark · Workers native WinForms redesign · utilitarian operations screen.
# Native .NET controls use the shared palette below; no CSS/browser markup.
# Windows PowerShell 5.1. UI only: opening this tab never starts a worker.
$script:workerNames = [ordered]@{ amazon='Amazon'; names='Dịch tên'; detail='Dịch chi tiết'; sync='Đồng bộ VPS' }
$script:workerSelected = 'names'
$script:workerApi = $null
$script:workerSnapshot = $null
$script:workerTiles = @{}
$script:workerTheme = @{
    page = [System.Drawing.Color]::FromArgb(15,18,22)
    surface = [System.Drawing.Color]::FromArgb(26,30,35)
    raised = [System.Drawing.Color]::FromArgb(37,43,49)
    text = [System.Drawing.Color]::FromArgb(239,243,245)
    muted = [System.Drawing.Color]::FromArgb(171,182,190)
    accent = [System.Drawing.Color]::FromArgb(95,187,163)
    border = [System.Drawing.Color]::FromArgb(67,76,83)
}
$script:workerFonts = @{
    heading = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold)
    title = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
    number = New-Object System.Drawing.Font('Segoe UI', 23, [System.Drawing.FontStyle]::Bold)
    body = New-Object System.Drawing.Font('Segoe UI', 10)
    label = New-Object System.Drawing.Font('Segoe UI', 9)
}
$workerPage = $script:pages.Workers
$workerPage.BackColor = $script:workerTheme.page
$workerSplit = New-Object System.Windows.Forms.SplitContainer
$workerSplit.Dock = 'Fill'
$workerSplit.Size = New-Object System.Drawing.Size(1000,600)
$workerSplit.SplitterWidth = 1
$workerSplit.Panel1MinSize = 215
$workerSplit.Panel2MinSize = 360
$workerSplit.SplitterDistance = 252
$workerSplit.FixedPanel = 'Panel1'
$workerSplit.IsSplitterFixed = $true
$workerSplit.BackColor = $script:workerTheme.border
$workerPage.Controls.Add($workerSplit)
$workerLeft = New-Object System.Windows.Forms.FlowLayoutPanel
$workerLeft.Dock='Fill'; $workerLeft.FlowDirection='TopDown'
$workerLeft.WrapContents=$false; $workerLeft.AutoScroll=$true
$workerLeft.Padding=New-Object System.Windows.Forms.Padding(12,20,12,12)
$workerLeft.BackColor=$script:workerTheme.page
$workerSplit.Panel1.Controls.Add($workerLeft)
$workerTitle=New-Object System.Windows.Forms.Label
$workerTitle.Text='Tác vụ'; $workerTitle.Width=220; $workerTitle.Height=39
$workerTitle.Font=$script:workerFonts.heading
$workerTitle.ForeColor=$script:workerTheme.text
$workerLeft.Controls.Add($workerTitle)
$workerIntro=New-Object System.Windows.Forms.Label
$workerIntro.Text='Theo dõi và điều khiển'; $workerIntro.Width=220; $workerIntro.Height=37
$workerIntro.Font=$script:workerFonts.label; $workerIntro.ForeColor=$script:workerTheme.muted
$workerLeft.Controls.Add($workerIntro)
foreach ($key in @('amazon','names','detail','sync')) {
    $tile=New-Object System.Windows.Forms.Button
    $tile.Width=222; $tile.Height=82; $tile.Tag=$key
    $tile.Text=$script:workerNames[$key] + [Environment]::NewLine + 'Không rõ'
    $tile.Font=$script:workerFonts.body
    $tile.Margin=New-Object System.Windows.Forms.Padding(0,0,0,9)
    $tile.TextAlign='MiddleLeft'; $tile.Padding=New-Object System.Windows.Forms.Padding(13,0,6,0)
    $tile.FlatStyle='Flat'; $tile.FlatAppearance.BorderColor=$script:workerTheme.border
    $tile.FlatAppearance.BorderSize=1
    $tile.ForeColor=$script:workerTheme.text; $tile.BackColor=$script:workerTheme.surface
    $tile.AccessibleName='Chọn worker ' + $script:workerNames[$key]
    $tile.Add_Click({
        param($sender,$event)
        $script:workerSelected=[string]$sender.Tag
        Show-WorkerPanel
        $workerScroll.AutoScrollPosition=New-Object System.Drawing.Point(0,0)
    })
    $workerLeft.Controls.Add($tile)
    $script:workerTiles[$key]=$tile
}
$workerRight=New-Object System.Windows.Forms.TableLayoutPanel
$workerRight.Dock='Fill'; $workerRight.Padding=New-Object System.Windows.Forms.Padding(24,17,24,16)
$workerRight.BackColor=$script:workerTheme.page
$workerRight.ColumnCount=1; $workerRight.RowCount=3
$null=$workerRight.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent,100)))
$null=$workerRight.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute,56)))
$null=$workerRight.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent,100)))
$null=$workerRight.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute,160)))
$workerSplit.Panel2.Controls.Add($workerRight)
$workerHeader=New-Object System.Windows.Forms.Panel; $workerHeader.Dock='Fill'
$workerRight.Controls.Add($workerHeader,0,0)
$workerHeading=New-Object System.Windows.Forms.Label
$workerHeading.Dock='Top'; $workerHeading.Height=41
$workerHeading.Font=$script:workerFonts.heading
$workerHeading.ForeColor=$script:workerTheme.text
$workerHeader.Controls.Add($workerHeading)
$workerSubtitle=New-Object System.Windows.Forms.Label
$workerSubtitle.Dock='Bottom'; $workerSubtitle.Height=27
$workerSubtitle.ForeColor=$script:workerTheme.muted; $workerSubtitle.Font=$script:workerFonts.label
$workerHeader.Controls.Add($workerSubtitle)
$workerScroll=New-Object System.Windows.Forms.Panel
$workerScroll.Dock='Fill'; $workerScroll.AutoScroll=$true
$workerRight.Controls.Add($workerScroll,0,1)
$workerBody=New-Object System.Windows.Forms.TableLayoutPanel
$workerBody.Dock='Top'; $workerBody.AutoSize=$true
$workerBody.AutoSizeMode='GrowAndShrink'
$workerBody.ColumnCount=1; $workerBody.RowCount=3
$null=$workerBody.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent,100)))
foreach ($height in @(120,72,152)) {
    $null=$workerBody.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute,$height)))
}
$workerScroll.Controls.Add($workerBody)
$workerProgressArea=New-Object System.Windows.Forms.Panel
$workerProgressArea.Dock='Fill'; $workerProgressArea.BackColor=$script:workerTheme.surface
$workerProgressArea.Padding=New-Object System.Windows.Forms.Padding(18,9,18,5)
$workerProgressArea.Margin=New-Object System.Windows.Forms.Padding(0,0,0,8)
$workerBody.Controls.Add($workerProgressArea,0,0)
$workerMetricLabel=New-Object System.Windows.Forms.Label
$workerMetricLabel.Text='Tiến độ'; $workerMetricLabel.Dock='Top'; $workerMetricLabel.Height=22
$workerMetricLabel.Font=$script:workerFonts.label; $workerMetricLabel.ForeColor=$script:workerTheme.muted
$workerProgressArea.Controls.Add($workerMetricLabel)
$workerMetricValue=New-Object System.Windows.Forms.Label
$workerMetricValue.Text='Chưa có số liệu'; $workerMetricValue.Dock='Top'; $workerMetricValue.Height=40
$workerMetricValue.Font=$script:workerFonts.number; $workerMetricValue.ForeColor=$script:workerTheme.text
$workerProgressArea.Controls.Add($workerMetricValue)
$workerMetricNote=New-Object System.Windows.Forms.Label
$workerMetricNote.Text='Số liệu được lấy từ database'; $workerMetricNote.Dock='Bottom'; $workerMetricNote.Height=20
$workerMetricNote.Font=$script:workerFonts.label; $workerMetricNote.ForeColor=$script:workerTheme.muted
$workerProgressArea.Controls.Add($workerMetricNote)
$workerProgress=New-Object System.Windows.Forms.Panel
$workerProgress.Dock='Bottom'; $workerProgress.Height=8
$workerProgress.BackColor=$script:workerTheme.border
$workerProgressFill=New-Object System.Windows.Forms.Panel
$workerProgressFill.Dock='Left'; $workerProgressFill.Width=0
$workerProgressFill.BackColor=$script:workerTheme.accent
$workerProgress.Controls.Add($workerProgressFill)
$workerProgressArea.Controls.Add($workerProgress)
$workerProgressArea.Controls.SetChildIndex($workerMetricValue,0)
$workerProgressArea.Controls.SetChildIndex($workerMetricLabel,1)
$workerTiming=New-Object System.Windows.Forms.TableLayoutPanel
$workerTiming.Dock='Fill'; $workerTiming.ColumnCount=2; $workerTiming.RowCount=1
$workerTiming.Margin=New-Object System.Windows.Forms.Padding(0,0,0,8)
foreach ($pct in @(50,50)) { $null=$workerTiming.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent,$pct))) }
$workerBody.Controls.Add($workerTiming,0,1)
$script:workerTimingValues=@{}
for ($i=0; $i -lt 2; $i++) {
    $cell=New-Object System.Windows.Forms.Panel; $cell.Dock='Fill'
    $cell.BackColor=$script:workerTheme.surface
    $cell.Margin=if($i -eq 0){New-Object System.Windows.Forms.Padding(0,0,6,0)}else{New-Object System.Windows.Forms.Padding(6,0,0,0)}
    $caption=New-Object System.Windows.Forms.Label
    $caption.Text=if($i -eq 0){'Lần cập nhật'}else{'Lịch tiếp theo'}
    $caption.Dock='Top'; $caption.Height=24; $caption.Margin=New-Object System.Windows.Forms.Padding(10,9,10,0)
    $caption.ForeColor=$script:workerTheme.muted; $caption.Font=$script:workerFonts.label
    $value=New-Object System.Windows.Forms.Label
    $value.Dock='Fill'; $value.Text='Chưa rõ'; $value.Padding=New-Object System.Windows.Forms.Padding(10,0,4,0)
    $value.ForeColor=$script:workerTheme.text; $value.Font=$script:workerFonts.body
    $cell.Controls.Add($value); $cell.Controls.Add($caption)
    $workerTiming.Controls.Add($cell,$i,0)
    $timeKey=if($i -eq 0){'updated'}else{'next'}
    $script:workerTimingValues[$timeKey]=$value
}
$workerActivity=New-Object System.Windows.Forms.Panel
$workerActivity.Dock='Fill'; $workerActivity.Padding=New-Object System.Windows.Forms.Padding(0,8,0,0)
$workerBody.Controls.Add($workerActivity,0,2)
$workerActivityTitle=New-Object System.Windows.Forms.Label
$workerActivityTitle.Text='Chi tiết hoạt động'; $workerActivityTitle.Dock='Top'; $workerActivityTitle.Height=31
$workerActivityTitle.Font=$script:workerFonts.title; $workerActivityTitle.ForeColor=$script:workerTheme.text
$workerActivity.Controls.Add($workerActivityTitle)
$workerInfo=New-Object System.Windows.Forms.TextBox
$workerInfo.Dock='Fill'; $workerInfo.Multiline=$true; $workerInfo.ReadOnly=$true
$workerInfo.WordWrap=$true; $workerInfo.ScrollBars='Vertical'; $workerInfo.TabStop=$false
$workerInfo.Font=$script:workerFonts.body
$workerInfo.BackColor=$script:workerTheme.page
$workerInfo.ForeColor=$script:workerTheme.muted
$workerInfo.BorderStyle='None'
$workerActivity.Controls.Add($workerInfo); $workerInfo.BringToFront()
$workerSettings=New-Object System.Windows.Forms.Panel
$workerSettings.Dock='Fill'; $workerSettings.BackColor=$script:workerTheme.surface
$workerSettings.Padding=New-Object System.Windows.Forms.Padding(16,8,16,5)
$workerRight.Controls.Add($workerSettings,0,2)
$workerSettingsTitle=New-Object System.Windows.Forms.Label
$workerSettingsTitle.Text='Điều khiển tác vụ'; $workerSettingsTitle.Dock='Top'; $workerSettingsTitle.Height=29
$workerSettingsTitle.Font=$script:workerFonts.title; $workerSettingsTitle.ForeColor=$script:workerTheme.text
$workerSettings.Controls.Add($workerSettingsTitle)
$workerFields=New-Object System.Windows.Forms.TableLayoutPanel
$workerFields.Dock='Top'; $workerFields.Height=64; $workerFields.RowCount=2; $workerFields.ColumnCount=3
foreach ($pct in @(40,30,30)){ $null=$workerFields.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent,$pct))) }
$null=$workerFields.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute,24)))
$null=$workerFields.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute,40)))
$workerSettings.Controls.Add($workerFields)
foreach ($field in @(@('Engine dịch tên',0),@('Giờ chạy JST',1),@('Số SP chạy tay',2))) {
    $label=New-Object System.Windows.Forms.Label
    $label.Text=[string]$field[0]; $label.Dock='Fill'; $label.Font=$script:workerFonts.label
    $label.ForeColor=$script:workerTheme.muted
    $label.Margin=New-Object System.Windows.Forms.Padding(0,3,8,0)
    $workerFields.Controls.Add($label,[int]$field[1],0)
}
$workerEngine=New-Object System.Windows.Forms.ComboBox
$workerEngine.DropDownStyle='DropDownList'; $workerEngine.Dock='Top'
$workerEngine.Font=$script:workerFonts.body
$workerEngine.Items.AddRange(@('OpenRouter','Codex CLI')); $workerEngine.SelectedIndex=0
$workerEngine.Margin=New-Object System.Windows.Forms.Padding(0,0,10,0)
$workerFields.Controls.Add($workerEngine,0,1)
$workerSchedule=New-Object System.Windows.Forms.DateTimePicker
$workerSchedule.Format='Custom'; $workerSchedule.CustomFormat='HH:mm'
$workerSchedule.ShowUpDown=$true; $workerSchedule.Dock='Top'
$workerSchedule.Font=$script:workerFonts.body
$workerSchedule.Margin=New-Object System.Windows.Forms.Padding(0,0,10,0)
$workerFields.Controls.Add($workerSchedule,1,1)
$workerCount=New-Object System.Windows.Forms.NumericUpDown
$workerCount.Minimum=1; $workerCount.Maximum=300; $workerCount.Value=20
$workerCount.Dock='Top'; $workerCount.Font=$script:workerFonts.body
$workerFields.Controls.Add($workerCount,2,1)
$workerActions=New-Object System.Windows.Forms.FlowLayoutPanel
$workerActions.Dock='Top'; $workerActions.Height=42
$workerActions.WrapContents=$false; $workerActions.AutoScroll=$false
$workerSettings.Controls.Add($workerActions)
$workerSave=Add-Button $workerActions 'Lưu thay đổi' {
    if (!(Can-Write) -or !$script:workerApi -or !$script:workerApi.settings) { Set-Status 'Cấu hình worker chưa khả dụng.'; return }
    $key=$script:workerSelected
    if ($key -eq 'sync') { return }
    $schedules=@{}
    foreach ($name in @('amazon','names','detail')) { $schedules[$name]=[string]$script:workerApi.settings.schedules.$name }
    $schedules[$key]=$workerSchedule.Value.ToString('HH:mm')
    $engine=if ($workerEngine.SelectedIndex -eq 1) { 'codex' } else { 'openrouter' }
    if (Confirm-Write ('Lưu lịch ' + $key + ' lúc ' + $schedules[$key] + ' JST, engine: ' + $engine + '?')) {
        Start-Api 'PUT' '/workers/settings' @{ version=[int]$script:workerApi.settings.version;engine=$engine;schedules=$schedules } {
            param($result)
            Set-Status 'API đã xác nhận cấu hình. Đang làm mới trạng thái.'
            Refresh-View
        }
    }
}
$workerSave.BackColor=$script:workerTheme.raised
$workerSave.Font=$script:workerFonts.body
$workerSave.AutoSize=$false; $workerSave.Width=158; $workerSave.Height=36
$workerSave.Margin=New-Object System.Windows.Forms.Padding(0,3,12,0)
$workerRun=Add-Button $workerActions 'Chạy ngay' {
    if (!(Can-Write)) { return }
    if ($script:workerSelected -eq 'sync') { Set-Status 'Đồng bộ thủ công phải qua tab Cổng và barrier an toàn.'; return }
    if (!$script:workerApi) { Set-Status 'Không có dữ liệu xác thực của worker, từ chối chạy.'; return }
    $key=$script:workerSelected
    $count=[int]$workerCount.Value
    if (Confirm-Write ('Yêu cầu chạy ' + $key + ' tối đa ' + $count + ' sản phẩm?')) {
        Start-Api 'POST' '/workers/run' @{worker=$key;maxProducts=$count;requestId=[guid]::NewGuid().ToString()} {
            param($result)
            Set-Status 'Yêu cầu đã được ghi nhận; kiểm tra trạng thái trước khi thử lại.'
            Refresh-View
        }
    }
}
$workerRun.BackColor=$script:workerTheme.raised
$workerRun.Font=$script:workerFonts.body
$workerRun.AutoSize=$false; $workerRun.Width=124; $workerRun.Height=36
$workerRun.Margin=New-Object System.Windows.Forms.Padding(0,3,0,0)
$workerSettingsHint=New-Object System.Windows.Forms.Label
$workerSettingsHint.Dock='Bottom'; $workerSettingsHint.Height=21
$workerSettingsHint.Font=$script:workerFonts.label
$workerSettingsHint.ForeColor=$script:workerTheme.muted
$workerSettings.Controls.Add($workerSettingsHint)
$workerSettingsHint.Visible=$false
$workerSettings.Controls.SetChildIndex($workerActions,0)
$workerSettings.Controls.SetChildIndex($workerFields,1)
$workerSettings.Controls.SetChildIndex($workerSettingsTitle,2)
function Set-WorkerResponsiveLayout {
    if ($script:workerReflowing) { return }
    $script:workerReflowing=$true
    try {
        # The 900x600 Desktop has little content height after its global chrome.
        # Move the entire settings pane into the same scroll surface, never clip it.
        if ($workerRight.ClientSize.Height -lt 420) {
            if ($workerSettings.Parent -ne $workerBody) {
                $workerRight.SuspendLayout(); $workerBody.SuspendLayout()
                $workerRight.Controls.Remove($workerSettings)
                if ($workerBody.RowCount -lt 4) {
                    $workerBody.RowCount=4
                    $null=$workerBody.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute,192)))
                }
                $workerBody.Controls.Add($workerSettings,0,3)
                $workerRight.RowStyles[2].Height=0
                $workerBody.ResumeLayout(); $workerRight.ResumeLayout()
            }
            if ($workerBody.RowCount -ge 4) { $workerBody.RowStyles[3].Height=192 }
        } elseif ($workerSettings.Parent -ne $workerRight) {
            $workerBody.SuspendLayout(); $workerRight.SuspendLayout()
            $workerBody.Controls.Remove($workerSettings)
            $workerRight.RowStyles[2].Height=160
            $workerRight.Controls.Add($workerSettings,0,2)
            if ($workerBody.RowCount -ge 4) { $workerBody.RowStyles[3].Height=0 }
            $workerBody.ResumeLayout(); $workerRight.ResumeLayout()
        }
    } finally { $script:workerReflowing=$false }
}
$workerRight.Add_SizeChanged({ Set-WorkerResponsiveLayout })
function Set-WorkerControls {
    $owner=$script:role -eq 'owner' -and [bool]$script:csrf -and !$script:pending
    $ready=$null -ne $script:workerApi -and $null -ne $script:workerApi.settings
    $editable=$owner -and $ready -and $script:workerSelected -ne 'sync'
    foreach ($control in @($workerSave,$workerRun,$workerSchedule,$workerCount)) { $control.Enabled=$editable }
    $workerEngine.Enabled=$editable -and $script:workerSelected -eq 'names'
    $workerSettingsTitle.Text=if ($script:workerSelected -eq 'sync') { 'Đồng bộ qua tab Cổng' } else { 'Điều khiển tác vụ' }
    $workerSettingsHint.Text=if ($script:workerSelected -eq 'sync') {
        'Đồng bộ thủ công chỉ thực hiện tại tab Cổng.'
    } elseif (!$ready) {
        'Chưa có dữ liệu API. Các thao tác thay đổi đang khóa.'
    } elseif (!$owner) {
        'Chỉ Owner được phép thay đổi cấu hình hoặc chạy tác vụ.'
    } else {
        'Thay đổi được xác nhận trước khi gửi tới hệ thống.'
    }
}
function Format-WorkerState([string]$state) {
    switch ($state) {
        'completed' { 'Đã kết thúc' }
        'running'   { 'Đang xử lý' }
        'partial'   { 'Một phần' }
        'skipped'   { 'Bỏ qua' }
        'failed'    { 'Có lỗi' }
        'pending'   { 'Chờ chạy' }
        'deferred'  { 'Đã hoãn' }
        default     { 'Chưa xác định' }
    }
}
function Format-WorkerTime($value) {
    if (!$value) { return 'Chưa rõ' }
    try {
        $point=[DateTimeOffset]::Parse([string]$value).ToOffset([TimeSpan]::FromHours(9))
        return $point.ToString('dd/MM/yyyy HH:mm') + ' JST'
    } catch { return 'Chưa rõ' }
}
function Set-WorkerProgress([int]$percent) {
    $script:workerProgressPercent=[Math]::Max(0,[Math]::Min(100,$percent))
    $workerProgressFill.Width=[int][Math]::Round($workerProgress.ClientSize.Width * $script:workerProgressPercent / 100)
}
$workerProgress.Add_Resize({ Set-WorkerProgress ([int]$script:workerProgressPercent) })
function Set-WorkerTile($key,$job,$summary) {
    $state=if ($summary -and $summary.state) { [string]$summary.state } elseif ($job) { [string]$job.state } else { '' }
    $caption=Format-WorkerState $state
    if ($summary -and $summary.coverage -and $null -ne $summary.coverage.total) {
        $coverage=$summary.coverage
        $caption += '  ·  ' + $coverage.translated + '/' + $coverage.total
    }
    $script:workerTiles[$key].Text=$script:workerNames[$key] + [Environment]::NewLine + $caption
}
function Show-WorkerPanel {
    $key=$script:workerSelected
    $workerHeading.Text=$script:workerNames[$key]
    foreach ($entry in $script:workerTiles.GetEnumerator()) {
        $selected=$entry.Key -eq $key
        $entry.Value.BackColor=if ($selected) { $script:workerTheme.raised } else { $script:workerTheme.surface }
        $entry.Value.FlatAppearance.BorderColor=if ($selected) { $script:workerTheme.accent } else { $script:workerTheme.border }
        $entry.Value.FlatAppearance.BorderSize=if ($selected) { 2 } else { 1 }
    }
    $job=$null
    if ($script:workerSnapshot) {
        $job=if ($key -eq 'sync') { $script:workerSnapshot.sync } else { $script:workerSnapshot.jobs.$key }
    }
    $state=if ($job -and $job.state) { [string]$job.state } else { 'unknown' }
    $updated=if ($job -and $job.updatedAt) { $job.updatedAt } elseif($job -and $job.at){$job.at}else{$null}
    $schedule=if ($key -eq 'sync') { 'Theo điều kiện đồng bộ' } else { @{ amazon='04:00';names='05:00';detail='05:15' }[$key] }
    $summary=$null
    $next='Chưa rõ'
    $lines=New-Object 'System.Collections.Generic.List[string]'
    if ($script:workerApi -and $script:workerApi.settings) {
        $settings=$script:workerApi.settings
        if ($key -ne 'sync' -and $settings.schedules.$key) { $schedule=[string]$settings.schedules.$key }
        if ($settings.engine -eq 'codex') { $workerEngine.SelectedIndex=1 } else { $workerEngine.SelectedIndex=0 }
        if ($key -ne 'sync' -and $schedule -match '^[0-2][0-9]:[0-5][0-9]$') {
            $workerSchedule.Value=[datetime]::Today.AddHours([int]$schedule.Substring(0,2)).AddMinutes([int]$schedule.Substring(3,2))
        }
        $summary=$script:workerApi.workers.$key
        if ($summary) {
            if ($summary.state) { $state=[string]$summary.state }
            if ($summary.observedAt) { $updated=$summary.observedAt }
            if ($summary.nextRun) { $next=Format-WorkerTime $summary.nextRun }
            if ($summary.coverage) {
                $workerMetricValue.Text=('{0:N0} / {1:N0}' -f [long]$summary.coverage.translated,[long]$summary.coverage.total)
                $unit=if ($key -eq 'detail') { 'mục chi tiết' } else { 'sản phẩm có tên Việt' }
                $workerMetricNote.Text=$unit + ' · toàn bộ dữ liệu'
                $ratio=if ([long]$summary.coverage.total -gt 0) {
                    [int][Math]::Round(100*[double]$summary.coverage.translated/[double]$summary.coverage.total)
                } else { 0 }
                Set-WorkerProgress $ratio
            }
            if ($key -eq 'names' -and $summary.rotation) {
                $lines.Add(('Chu kỳ Codex: {0}/{1} sản phẩm' -f $summary.rotation.completed,$summary.rotation.total))
                if ($summary.rotation.exhausted) { $lines.Add(('Quá số lần thử: ' + $summary.rotation.exhausted)) }
            }
            if ($key -eq 'names' -and $summary.lastResult) {
                $result=$summary.lastResult
                $lines.Add(('Codex gần nhất: ' + (Format-WorkerState ([string]$result.state)) + ' · ' + (Format-WorkerTime $result.started_at)))
                $lines.Add(('Đã dịch: {0}   Lỗi: {1}   Cảnh báo: {2}' -f $result.translated,$result.failed,$result.warnings))
                if ($result.reason) { $lines.Add(('Nguyên nhân: ' + $result.reason)) }
            }
            if ($key -eq 'names' -and $summary.warningAsinsTotal -gt 0) {
                $lines.Add(('ASIN cảnh báo: ' + $summary.warningAsinsTotal))
                $asins=@($summary.warningAsins | Select-Object -First 8 | ForEach-Object { $_.asin })
                if ($asins.Count) { $lines.Add(($asins -join ', ')) }
            }
            if ($summary.reason) { $lines.Add(('Lý do: ' + $summary.reason)) }
            if ($summary.nextActions) { $lines.Add([string]$summary.nextActions) }
        }
    }
    $workerSubtitle.Text=('Trạng thái: ' + (Format-WorkerState $state) + '   |   ' + $schedule + ' JST')
    if ($key -eq 'sync') { $workerSubtitle.Text='Trạng thái: ' + (Format-WorkerState $state) + '   |   theo rào chắn đồng bộ' }
    $script:workerTimingValues.updated.Text=Format-WorkerTime $updated
    $script:workerTimingValues.next.Text=if($key -eq 'sync'){'Theo rào chắn'}else{$next}
    if ($key -eq 'sync') {
        $workerMetricLabel.Text='Kết quả đồng bộ'
        $workerMetricValue.Text=Format-WorkerState $state
        $workerMetricNote.Text='Không suy ra số bản ghi từ trạng thái'
        Set-WorkerProgress 0
    } elseif ($key -eq 'amazon') {
        $workerMetricLabel.Text='Thu thập Amazon'
        $workerMetricValue.Text='Chưa có số liệu'
        $workerMetricNote.Text='Chưa có chỉ số tổng từ API'
        Set-WorkerProgress 0
    } elseif (!$summary -or !$summary.coverage) {
        $workerMetricLabel.Text='Tiến độ toàn bộ'
        $workerMetricValue.Text='Chưa có số liệu'
        $workerMetricNote.Text='Chờ API cung cấp số liệu'
        Set-WorkerProgress 0
    } else { $workerMetricLabel.Text='Tiến độ toàn bộ' }
    $workerProgress.Visible=([bool]($summary -and $summary.coverage -and $key -in @('names','detail')))
    if ($lines.Count -eq 0) {
        $lines.Add('Chưa có kết quả chi tiết được xác thực cho tác vụ này.')
    }
    if ($state -eq 'completed') { $lines.Add('Đã kết thúc lượt chạy không đồng nghĩa có sản phẩm mới.') }
    if ($key -eq 'sync') { $lines.Add('Đồng bộ thủ công chỉ được yêu cầu từ tab Cổng.') }
    if (!$script:workerApi) { $lines.Add('API chưa sẵn sàng. Các nút thay đổi tạm khóa.') }
    $lines.Add('Trạng thái theo bản ghi; chưa xác minh tiến trình đang sống.')
    $lines.Add(('Nhật ký: .agents/runtime/' + $(if($key -eq 'sync'){'nightly-sync'}else{$key}) + '.out.log'))
    $workerInfo.Text=$lines -join [Environment]::NewLine
    $workerInfo.SelectionStart=0; $workerInfo.ScrollToCaret()
    Set-WorkerControls
}
function Refresh-Workers {
    $script:workerSnapshot=$null
    # Invalidate previous authenticated metrics during each refresh; never keep
    # Owner controls enabled from stale API data after a failed read.
    $script:workerApi=$null
    $day=[datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd')
    $file=Join-Path $script:root ('.agents/runtime/mita-daily-' + $day + '.json')
    try {
        $info=Get-Item -LiteralPath $file -ErrorAction Stop
        if ($info.Length -gt 1MB) { throw 'Status too large' }
        $script:workerSnapshot=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { }
    foreach ($key in @('amazon','names','detail','sync')) {
        $job=if ($script:workerSnapshot) { if ($key -eq 'sync') { $script:workerSnapshot.sync } else { $script:workerSnapshot.jobs.$key } } else { $null }
        Set-WorkerTile $key $job $null
    }
    Show-WorkerPanel
    if ($script:csrf -and !$script:pending) {
        Start-Api 'GET' '/workers' $null {
            param($data)
            $script:workerApi=$data
            foreach ($key in @('amazon','names','detail','sync')) {
                $summary=$data.workers.$key
                $job=if ($script:workerSnapshot) { if ($key -eq 'sync') { $script:workerSnapshot.sync } else { $script:workerSnapshot.jobs.$key } } else { $null }
                Set-WorkerTile $key $job $summary
            }
            Show-WorkerPanel
            Set-Status 'Đã tải thông tin Workers từ API xác thực.'
        }
    }
}
Show-WorkerPanel
