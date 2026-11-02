# Windows PowerShell 5.1. UI only: opening this tab never starts a worker.
$script:workerNames = [ordered]@{ amazon='Amazon'; names='Dịch tên'; detail='Dịch chi tiết'; sync='Đồng bộ VPS' }
$script:workerSelected = 'names'
$script:workerApi = $null
$script:workerSnapshot = $null
$script:workerTiles = @{}
$workerPage = $script:pages.Workers
$workerSplit = New-Object System.Windows.Forms.SplitContainer
$workerSplit.Dock = 'Fill'
$workerSplit.Size = New-Object System.Drawing.Size(1000,600)
$workerSplit.SplitterDistance = 270
$workerSplit.FixedPanel = 'Panel1'
$workerPage.Controls.Add($workerSplit)
$workerLeft = New-Object System.Windows.Forms.FlowLayoutPanel
$workerLeft.Dock='Fill'; $workerLeft.FlowDirection='TopDown'
$workerLeft.WrapContents=$false; $workerLeft.AutoScroll=$true
$workerLeft.Padding=New-Object System.Windows.Forms.Padding(12)
$workerSplit.Panel1.Controls.Add($workerLeft)
$workerTitle=New-Object System.Windows.Forms.Label
$workerTitle.Text='Workers'; $workerTitle.Width=240; $workerTitle.Height=55
$workerTitle.Font=New-Object System.Drawing.Font('Segoe UI',19,[System.Drawing.FontStyle]::Bold)
$workerLeft.Controls.Add($workerTitle)
foreach ($key in @('amazon','names','detail','sync')) {
    $tile=New-Object System.Windows.Forms.Button
    $tile.Width=230; $tile.Height=80; $tile.Tag=$key
    $tile.Text=$script:workerNames[$key] + [Environment]::NewLine + 'Không rõ'
    $tile.Font=New-Object System.Drawing.Font('Segoe UI',11)
    $tile.TextAlign='MiddleLeft'; $tile.Padding=New-Object System.Windows.Forms.Padding(15,0,0,0)
    $tile.FlatStyle='Flat'; $tile.FlatAppearance.BorderColor=[System.Drawing.Color]::DimGray
    $tile.ForeColor=[System.Drawing.Color]::White; $tile.BackColor=[System.Drawing.Color]::FromArgb(23,23,23)
    $tile.AccessibleName='Chọn worker ' + $script:workerNames[$key]
    $tile.Add_Click({ param($sender,$event) $script:workerSelected=[string]$sender.Tag; Show-WorkerPanel })
    $workerLeft.Controls.Add($tile)
    $script:workerTiles[$key]=$tile
}
$workerRight=New-Object System.Windows.Forms.Panel
$workerRight.Dock='Fill'; $workerRight.Padding=New-Object System.Windows.Forms.Padding(14)
$workerSplit.Panel2.Controls.Add($workerRight)
$workerHeading=New-Object System.Windows.Forms.Label
$workerHeading.Dock='Top'; $workerHeading.Height=55
$workerHeading.Font=New-Object System.Drawing.Font('Segoe UI',18,[System.Drawing.FontStyle]::Bold)
$workerRight.Controls.Add($workerHeading)
$workerControls=New-Object System.Windows.Forms.FlowLayoutPanel
$workerControls.Dock='Bottom'; $workerControls.Height=136
$workerControls.WrapContents=$true
$workerRight.Controls.Add($workerControls)
$workerInfo=New-Object System.Windows.Forms.TextBox
$workerInfo.Dock='Fill'; $workerInfo.Multiline=$true; $workerInfo.ReadOnly=$true
$workerInfo.WordWrap=$true; $workerInfo.ScrollBars='Vertical'
$workerInfo.Font=New-Object System.Drawing.Font('Segoe UI',11)
$workerInfo.BackColor=[System.Drawing.Color]::Black
$workerInfo.ForeColor=[System.Drawing.Color]::Gainsboro
$workerInfo.BorderStyle='None'
$workerRight.Controls.Add($workerInfo); $workerInfo.BringToFront()
$workerControls.Padding=New-Object System.Windows.Forms.Padding(0,12,0,4)
$workerHint=New-Object System.Windows.Forms.Label
$workerHint.Text='Engine dịch tên  /  Giờ chạy JST  /  Số sản phẩm khi chạy tay'
$workerHint.ForeColor=[System.Drawing.Color]::Silver
$workerHint.Width=475; $workerHint.Height=25
$workerControls.Controls.Add($workerHint)
$workerEngine=New-Object System.Windows.Forms.ComboBox
$workerEngine.DropDownStyle='DropDownList'; $workerEngine.Width=125
$workerEngine.Items.AddRange(@('OpenRouter','Codex CLI')); $workerEngine.SelectedIndex=0
$workerControls.Controls.Add($workerEngine)
$workerSchedule=New-Object System.Windows.Forms.DateTimePicker
$workerSchedule.Format='Custom'; $workerSchedule.CustomFormat='HH:mm'
$workerSchedule.ShowUpDown=$true; $workerSchedule.Width=83
$workerControls.Controls.Add($workerSchedule)
$workerCount=New-Object System.Windows.Forms.NumericUpDown
$workerCount.Minimum=1; $workerCount.Maximum=300; $workerCount.Value=20
$workerCount.Width=65; $workerControls.Controls.Add($workerCount)
$workerSave=Add-Button $workerControls 'Lưu lịch và engine' {
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
$workerSave.BackColor=[System.Drawing.Color]::FromArgb(50,50,50)
$workerSave.AutoSize=$false; $workerSave.Width=155; $workerSave.Height=34
$workerRun=Add-Button $workerControls 'Chạy ngay' {
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
$workerRun.BackColor=[System.Drawing.Color]::FromArgb(50,50,50)
$workerRun.AutoSize=$false; $workerRun.Width=110; $workerRun.Height=34
function Set-WorkerControls {
    $owner=$script:role -eq 'owner'
    $ready=$null -ne $script:workerApi -and $null -ne $script:workerApi.settings
    $editable=$owner -and $ready -and $script:workerSelected -ne 'sync'
    foreach ($control in @($workerSave,$workerRun,$workerSchedule,$workerCount)) { $control.Enabled=$editable }
    $workerEngine.Enabled=$editable -and $script:workerSelected -eq 'names'
}
function Show-WorkerPanel {
    $key=$script:workerSelected
    $workerHeading.Text=$script:workerNames[$key]
    foreach ($entry in $script:workerTiles.GetEnumerator()) {
        $selected=$entry.Key -eq $key
        $entry.Value.BackColor=if ($selected) { [System.Drawing.Color]::FromArgb(44,44,44) } else { [System.Drawing.Color]::FromArgb(23,23,23) }
        $entry.Value.FlatAppearance.BorderColor=if ($selected) { [System.Drawing.Color]::White } else { [System.Drawing.Color]::DimGray }
    }
    $day=[datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd')
    $file=Join-Path $script:root ('.agents/runtime/mita-daily-' + $day + '.json')
    $job=$null
    if ($script:workerSnapshot) {
        $job=if ($key -eq 'sync') { $script:workerSnapshot.sync } else { $script:workerSnapshot.jobs.$key }
    }
    $state=if ($job -and $job.state) { [string]$job.state } else { 'Không xác định' }
    $updated=if ($job -and $job.updatedAt) { [string]$job.updatedAt } else { 'Chưa rõ' }
    $schedule=if ($key -eq 'sync') { 'Sau 3 worker và rào chắn sync' } else { @{ amazon='04:00';names='05:00';detail='05:15' }[$key] }
    $more=@()
    if ($script:workerApi -and $script:workerApi.settings) {
        $settings=$script:workerApi.settings
        if ($key -ne 'sync' -and $settings.schedules.$key) { $schedule=[string]$settings.schedules.$key }
        if ($settings.engine -eq 'codex') { $workerEngine.SelectedIndex=1 } else { $workerEngine.SelectedIndex=0 }
        if ($key -ne 'sync' -and $schedule -match '^[0-2][0-9]:[0-5][0-9]$') {
            $workerSchedule.Value=[datetime]::Today.AddHours([int]$schedule.Substring(0,2)).AddMinutes([int]$schedule.Substring(3,2))
        }
        $summary=$script:workerApi.workers.$key
        if ($summary) {
            if ($summary.coverage) {
                $unit=if ($key -eq 'detail') { 'slot chi tiết' } else { 'sản phẩm' }
                $more += ('Tiến độ toàn hệ thống: ' + $summary.coverage.translated + '/' + $summary.coverage.total + ' ' + $unit)
            }
            if ($key -eq 'names' -and $summary.rotation) {
                $more += ('Chu kỳ Codex: ' + $summary.rotation.completed + '/' + $summary.rotation.total + ' sản phẩm, còn lỗi quá số lần thử: ' + $summary.rotation.exhausted)
            }
            if ($key -eq 'names' -and $summary.lastResult) {
                $result=$summary.lastResult
                $more += ('Lượt Codex gần nhất: ' + $result.state + ', ' + $result.trigger + ', ' + $result.started_at)
                $more += ('Đã dịch: ' + $result.translated + '; thất bại: ' + $result.failed + '; cảnh báo: ' + $result.warnings)
                if ($result.reason) { $more += ('Nguyên nhân: ' + $result.reason) }
            }
            if ($key -eq 'names' -and $summary.warningAsinsTotal -gt 0) {
                $more += ('ASIN có vấn đề trong lượt gần nhất: ' + $summary.warningAsinsTotal)
                foreach ($item in @($summary.warningAsins)) {
                    $more += ('  ' + $item.asin + ': ' + (($item.issues | ConvertTo-Json -Compress -Depth 3)))
                }
            }
            foreach ($field in @('nextRun','reason','logPath','nextActions')) {
                if ($null -ne $summary.$field) { $more += ($field + ': ' + ($summary.$field | ConvertTo-Json -Depth 3 -Compress)) }
            }
        }
    }
    $lines=@(
        ('Trạng thái theo bản ghi: ' + $state),
        ('Cập nhật: ' + $updated),
        ('Lịch dự kiến JST: ' + $schedule),
        '',
        'Không đồng nhất trạng thái completed với số lượng đã dịch.',
        'Thông số không đủ bằng chứng được để ở trạng thái chưa xác định.',
        '',
        'Đường dẫn nhật ký:',
        $file,
        (Join-Path $script:root '.agents/runtime/mita-supervisor.jsonl'),
        (Join-Path $script:root '.agents/runtime/translation-warnings.jsonl'),
        (Join-Path $script:root ('.agents/runtime/' + $key + '.out.log'))
    ) + $more
    if (!$script:workerApi) { $lines += @('','API Workers chưa sẵn sàng: mọi thao tác ghi bị khóa.','Snapshot không chứng minh tiến trình đang sống.') }
    $workerInfo.Text=$lines -join [Environment]::NewLine
    Set-WorkerControls
}
function Refresh-Workers {
    $script:workerSnapshot=$null
    $day=[datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd')
    $file=Join-Path $script:root ('.agents/runtime/mita-daily-' + $day + '.json')
    try {
        $info=Get-Item -LiteralPath $file -ErrorAction Stop
        if ($info.Length -gt 1MB) { throw 'Status too large' }
        $script:workerSnapshot=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { }
    foreach ($key in @('amazon','names','detail','sync')) {
        $job=if ($script:workerSnapshot) { if ($key -eq 'sync') { $script:workerSnapshot.sync } else { $script:workerSnapshot.jobs.$key } } else { $null }
        $state=if ($job -and $job.state) { [string]$job.state } else { 'Không rõ' }
        $script:workerTiles[$key].Text=$script:workerNames[$key] + [Environment]::NewLine + $state
    }
    Show-WorkerPanel
    if ($script:csrf -and !$script:pending) {
        Start-Api 'GET' '/workers' $null {
            param($data)
            $script:workerApi=$data
            foreach ($key in @('amazon','names','detail','sync')) {
                $summary=$data.workers.$key
                if ($summary) {
                    $title=$script:workerNames[$key] + [Environment]::NewLine + [string]$summary.state
                    if ($summary.coverage) { $title += ('  ' + $summary.coverage.translated + '/' + $summary.coverage.total) }
                    $script:workerTiles[$key].Text=$title
                }
            }
            Show-WorkerPanel
            Set-Status 'Đã tải thông tin Workers từ API xác thực.'
        }
    }
}
Show-WorkerPanel
