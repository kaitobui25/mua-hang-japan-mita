# Dot-sourced at script scope by mita-desktop.ps1. All event state lives in
# $script:portTopology; handlers never capture Initialize-PortTab local variables.
# Probe I/O runs only in mita-desktop-probes.ps1 on a separate runspace.
function Initialize-PortTab($page) {
    $script:portTopology = @{ Nodes=@(); Edges=@(); Selected='pc-web'; Buttons=@{}; Items=@{}; Updating=$false }
    $t = $script:portTopology
    # ID, host, port, service, protocol, source, group, graph X/Y.
    $definitions = @(
        @('pc-web','PC','3000','Web','HTTP','scripts/start-local.ps1','PC / Mita',20,40),
        @('pc-api','PC','4000','API','HTTP','scripts/mita-backend-control.ps1','PC / Mita',200,40),
        @('pc-db','PC','5433','PostgreSQL Mita','PostgreSQL / TCP','scripts/start-local.ps1','PC / Mita',380,40),
        @('supervisor','PC','19978','Supervisor','TCP status; không phải HTTP','scripts/start-mita-supervisor.ps1','PC / Mita',20,170),
        @('gateway','PC','8080','Gateway','HTTP','docs/mita-workers-runbook.md','PC / Mita',380,170),
        @('gguf','PC','8081','GGUF (theo nhu cầu)','HTTP; on-demand','docs/mita-workers-runbook.md','PC / Mita',560,170),
        @('tunnel','PC','15432','Tunnel tạm','PostgreSQL qua SSH; có điều kiện','scripts/nightly-vps-sync.ps1','PC / Mita',560,300),
        @('vps-web','VPS','3100','Web','HTTP','docs/hermes-vps-runbook.md','VPS / Mita',780,40),
        @('vps-api','VPS','4100','API','HTTP','docs/hermes-vps-runbook.md','VPS / Mita',780,170),
        @('vps-db','VPS','5432','PostgreSQL','PostgreSQL / TCP','docs/hermes-vps-runbook.md','VPS / Mita',780,300),
        @('workers','PC','—','Workers (tiến trình)','Gọi gateway qua HTTP','docs/mita-workers-runbook.md','Tiến trình / không phải cổng',200,170),
        @('sync','PC','—','Sync (tiến trình)','Đọc PC DB; ghi VPS DB qua tunnel','scripts/nightly-vps-sync.ps1','Tiến trình / không phải cổng',380,300),
        @('monitor','PC','—','SSH monitoring','SSH; chỉ giám sát, không phải sync','Topology được duyệt cho tab Cổng','Tiến trình / không phải cổng',560,430),
        @('ssh','VPS','22','SSH','SSH / TCP','docs/hermes-vps-runbook.md','Hạ tầng chung / chỉ đọc',780,430),
        @('http','VPS','80','HTTP công khai','HTTP / TCP','Topology được duyệt; docs/hermes-vps-runbook.md','Hạ tầng chung / chỉ đọc',20,430),
        @('https','VPS','443','HTTPS công khai','HTTPS / TCP','docs/hermes-vps-runbook.md','Hạ tầng chung / chỉ đọc',200,430),
        @('neo','PC','9010','Neo','MCP / HTTP','Topology được duyệt cho tab Cổng','Hạ tầng chung / chỉ đọc',380,430)
    )
    foreach ($d in $definitions) {
        $t.Nodes += [pscustomobject]@{ Id=$d[0]; Host=$d[1]; Port=$d[2]; Service=$d[3]; Protocol=$d[4]; Source=$d[5]; Group=$d[6]; X=[int]$d[7]; Y=[int]$d[8]; State='unknown'; LastProbed=$null; Reason='Chưa kiểm tra'; ProbeSource='Chưa có' }
    }
    # Kind expresses relationship semantics, not observed connectivity/traffic.
    foreach ($d in @(
        @('pc-web','pc-api','application','HTTP: Web gọi API'),
        @('pc-api','pc-db','application','PostgreSQL: API truy vấn DB'),
        @('supervisor','workers','control','Quản lý vòng đời workers (phụ thuộc tiến trình)'),
        @('workers','gateway','application','HTTP: workers gọi gateway'),
        @('gateway','gguf','conditional','HTTP: khởi tạo / gọi GGUF theo nhu cầu'),
        @('sync','pc-db','application','PostgreSQL: tiến trình sync đọc DB PC'),
        @('sync','tunnel','conditional','PostgreSQL: sync ghi qua tunnel tạm'),
        @('tunnel','vps-db','conditional','SSH forward 15432 -> VPS loopback 5432 (qua SSH 22)'),
        @('tunnel','ssh','control','SSH 22 vận chuyển tunnel; khác với monitoring'),
        @('vps-web','vps-api','application','HTTP: Web gọi API'),
        @('vps-api','vps-db','application','PostgreSQL: API truy vấn DB'),
        @('monitor','ssh','control','SSH: giám sát từ PC; không biểu diễn dữ liệu sync')
    )) { $t.Edges += [pscustomobject]@{ From=$d[0]; To=$d[1]; Kind=$d[2]; Description=$d[3] } }

    $bar = New-Object System.Windows.Forms.FlowLayoutPanel
    $bar.Dock='Top'; $bar.Height=42; $bar.Padding=New-Object System.Windows.Forms.Padding(6)
    $bar.BackColor=[System.Drawing.Color]::Black; $bar.ForeColor=[System.Drawing.Color]::White
    $label = New-Object System.Windows.Forms.Label
    $label.Text='Bố cục (&B):'; $label.AutoSize=$true; $label.Margin=New-Object System.Windows.Forms.Padding(3,5,3,0)
    $label.ForeColor=[System.Drawing.Color]::White
    $bar.Controls.Add($label)
    $t.Layout = New-Object System.Windows.Forms.ComboBox
    $t.Layout.DropDownStyle='DropDownList'; $t.Layout.Width=225
    $t.Layout.AccessibleName='Bố cục Cổng'; $t.Layout.TabIndex=0
    $t.Layout.Items.AddRange([object[]]@('Mạng nhện','Danh sách PC/VPS')); $t.Layout.SelectedIndex=0
    $bar.Controls.Add($t.Layout)
    $pollLabel=New-Object System.Windows.Forms.Label
    $pollLabel.Text='Chu kỳ (giây):'; $pollLabel.AutoSize=$true; $bar.Controls.Add($pollLabel)
    $pollLabel.ForeColor=[System.Drawing.Color]::White
    $t.Interval=New-Object System.Windows.Forms.NumericUpDown
    $t.Interval.Minimum=15; $t.Interval.Maximum=300; $t.Interval.Value=15; $t.Interval.Width=60
    $t.Interval.AccessibleName='Chu kỳ giám sát Cổng (giây)'; $bar.Controls.Add($t.Interval)
    $t.Motion=New-Object System.Windows.Forms.CheckBox
    $t.Motion.AutoSize=$true; $t.Motion.Text='Mũi tên minh họa'; $t.Motion.Checked=$true
    $t.Motion.BackColor=[System.Drawing.Color]::Black; $t.Motion.ForeColor=[System.Drawing.Color]::White
    $t.Motion.AccessibleName='Bật hoặc tắt hoạt ảnh minh họa quan hệ kết nối'
    $bar.Controls.Add($t.Motion); $t.MotionPhase=[single]0
    $t.DetailToggle=New-Object System.Windows.Forms.Button
    $t.DetailToggle.Text='Chi tiết >'; $t.DetailToggle.Width=108; $t.DetailToggle.Height=28
    $t.DetailToggle.FlatStyle='Flat'; $t.DetailToggle.BackColor=[System.Drawing.Color]::Black
    $t.DetailToggle.ForeColor=[System.Drawing.Color]::White
    $t.DetailToggle.AccessibleName='Mở hoặc thu gọn chi tiết node'
    $t.DetailToggle.Add_Click({ Set-PortDetailsVisible ([bool]$script:portTopology.Split.Panel2Collapsed) })
    $bar.Controls.Add($t.DetailToggle)
    $t.NextPoll=[datetime]::MinValue; $t.Job=$null; $t.Closing=$false
    $t.BackendJob=$null; $t.BackendSession=$null; $t.BackendClosing=$false
    $t.TunnelJob=$null; $t.TunnelSession=$null; $t.TunnelClosing=$false
    $t.SyncJob=$null
    $t.Interval.Add_ValueChanged({ $script:portTopology.NextPoll=[datetime]::Now.AddSeconds([double]$script:portTopology.Interval.Value) })
    $t.Control=New-Object System.Windows.Forms.Button
    $t.Control.Text='Điều khiển PC'; $t.Control.AutoSize=$true; $t.Control.Enabled=$false
    $t.Control.FlatStyle='Flat'; $t.Control.BackColor=[System.Drawing.Color]::Black; $t.Control.ForeColor=[System.Drawing.Color]::White
    $t.Control.AccessibleName='Yêu cầu bật hoặc dừng dịch vụ Mita thuộc PC'; $bar.Controls.Add($t.Control)
    $t.ActionJob=$null
    $t.Control.Add_Click({
        $state=$script:portTopology
        if ($script:role -ne 'owner' -or $state.ActionJob -or $script:pending) { return }
        $service=switch ($state.Selected) { 'gateway' { 'gateway' } 'supervisor' { 'supervisor' } default { return } }
        $node=@($state.Nodes | Where-Object Id -eq $state.Selected)[0]
        $action=switch ($node.State) { 'online' { 'stop' } 'offline' { 'start' } default { return } }
        $description=if ($action -eq 'stop') { 'Yêu cầu dừng hợp tác, đợi inference hoặc workers hoàn tất. Không kill PID.' }
            else { 'Chỉ khởi động đúng tiến trình Mita đã xác minh; nếu thiếu phụ thuộc sẽ từ chối.' }
        $message="PC Windows / $($node.Port) / $($node.Service) / $action" + [Environment]::NewLine + $description +
            [Environment]::NewLine + 'Có ghi nhật ký kiểm soát trên PC. Chỉ owner được thực hiện.'
        $timer.Stop(); $portTimer.Stop()
        try {
            $confirmed=[System.Windows.Forms.MessageBox]::Show($form,$message,'Xác nhận điều khiển cổng Mita','YesNo','Warning','Button2')
        } finally { $timer.Start(); $portTimer.Start() }
        if ($confirmed -ne [System.Windows.Forms.DialogResult]::Yes -or !$script:csrf) { return }
        # Confirmation may have remained open until the owner session expired.
        # Recheck server authorization AFTER confirmation, immediately before
        # dispatching the local action; fail closed if API 4000 is unavailable.
        $script:portPlannedControl=@{ Service=$service; Action=$action }
        Start-Api 'GET' '/session' $null {
            param($session)
            $plan=$script:portPlannedControl; $script:portPlannedControl=$null
            if (!$plan -or $session.role -ne 'owner') { Set-Status 'Phiên owner không hợp lệ; không điều khiển PC.'; return }
            Start-PortControlAction $plan.Service $plan.Action
        }
    })

    $t.Detail = New-Object System.Windows.Forms.TextBox
    $t.Detail.Dock='Fill'; $t.Detail.Multiline=$true; $t.Detail.ReadOnly=$true
    $t.Detail.ScrollBars='Vertical'; $t.Detail.BackColor=[System.Drawing.Color]::Black; $t.Detail.ForeColor=[System.Drawing.Color]::White
    $t.Detail.AccessibleName='Chi tiết cổng và quan hệ'; $t.Detail.TabIndex=2
    # Both layouts share this control strip; merely choosing a node changes nothing.
    $t.BackendBar=New-Object System.Windows.Forms.FlowLayoutPanel
    $t.BackendBar.Dock='Bottom'; $t.BackendBar.Height=48
    $t.BackendBar.Padding=New-Object System.Windows.Forms.Padding(6,4,4,4)
    $t.BackendBar.BackColor=[System.Drawing.Color]::Black
    $t.BackendBar.Visible=$false
    $modeLabel=New-Object System.Windows.Forms.Label
    $modeLabel.Text='Backend 4000:'; $modeLabel.AutoSize=$true
    $modeLabel.ForeColor=[System.Drawing.Color]::White
    $modeLabel.Margin=New-Object System.Windows.Forms.Padding(3,10,5,0)
    $t.BackendBar.Controls.Add($modeLabel)
    $t.BackendMode=New-Object System.Windows.Forms.ComboBox
    $t.BackendMode.DropDownStyle='DropDownList'; $t.BackendMode.Width=125
    $t.BackendMode.AccessibleName='Chế độ backend 4000'
    $t.BackendMode.Items.AddRange([object[]]@('Dev','Start'))
    $t.BackendMode.SelectedIndex=0
    $t.BackendBar.Controls.Add($t.BackendMode)
    foreach ($entry in @(@('Start','Chạy'),@('Stop','Dừng'),@('Restart','Restart'))) {
        $button=New-Object System.Windows.Forms.Button
        $button.Name='Backend'+$entry[0]
        $button.Text=$entry[1]; $button.Width=88; $button.Height=30
        $button.FlatStyle='Flat'; $button.BackColor=[System.Drawing.Color]::Black
        $button.ForeColor=[System.Drawing.Color]::White
        $button.FlatAppearance.BorderColor=[System.Drawing.Color]::DimGray
        # System disabled-button text is nearly black on the monochrome black
        # background. Paint a readable silver caption without enabling action.
        $button.Add_Paint({
            param($sender,$e)
            if (!$sender.Enabled) {
                $flags=[System.Windows.Forms.TextFormatFlags]::HorizontalCenter -bor
                    [System.Windows.Forms.TextFormatFlags]::VerticalCenter -bor
                    [System.Windows.Forms.TextFormatFlags]::SingleLine
                [System.Windows.Forms.TextRenderer]::DrawText($e.Graphics,$sender.Text,$sender.Font,
                    $sender.ClientRectangle,[System.Drawing.Color]::Silver,$flags)
            }
        })
        $button.Tag=$entry[0].ToLowerInvariant()
        $button.AccessibleName="$($entry[1]) backend Mita 4000"
        $button.Add_Click({param($sender,$e) Request-BackendAction ([string]$sender.Tag)})
        $t.BackendBar.Controls.Add($button)
        $t['Backend'+$entry[0]]=$button
    }
    $t.TunnelBar=New-Object System.Windows.Forms.FlowLayoutPanel
    $t.TunnelBar.Dock='Bottom'; $t.TunnelBar.Height=44
    $t.TunnelBar.BackColor=[System.Drawing.Color]::Black
    $t.TunnelBar.Padding=New-Object System.Windows.Forms.Padding(6,4,4,4)
    $t.TunnelBar.Visible=$false
    $t.TunnelHint=New-Object System.Windows.Forms.Label
    $t.TunnelHint.Text='Tunnel chẩn đoán (5 phút)'; $t.TunnelHint.AutoSize=$true
    $t.TunnelHint.ForeColor=[System.Drawing.Color]::Silver
    $t.TunnelHint.Margin=New-Object System.Windows.Forms.Padding(3,9,6,0)
    $t.TunnelBar.Controls.Add($t.TunnelHint)
    $t.TunnelStart=New-Object System.Windows.Forms.Button
    $t.TunnelStart.Text='Mở tunnel'; $t.TunnelStart.Width=110
    $t.TunnelStop=New-Object System.Windows.Forms.Button
    $t.TunnelStop.Text='Đóng tunnel'; $t.TunnelStop.Width=110
    foreach ($control in @($t.TunnelStart,$t.TunnelStop)) {
        $control.Height=30; $control.FlatStyle='Flat'
        $control.BackColor=[System.Drawing.Color]::Black; $control.ForeColor=[System.Drawing.Color]::White
        $control.FlatAppearance.BorderColor=[System.Drawing.Color]::DimGray
        $t.TunnelBar.Controls.Add($control)
    }
    $t.TunnelStart.Add_Click({ Request-TunnelAction 'Start' })
    $t.TunnelStop.Add_Click({ Request-TunnelAction 'Stop' })
    $t.SyncBar=New-Object System.Windows.Forms.FlowLayoutPanel
    $t.SyncBar.Dock='Bottom'; $t.SyncBar.Height=44
    $t.SyncBar.Padding=New-Object System.Windows.Forms.Padding(6,4,4,4)
    $t.SyncBar.BackColor=[System.Drawing.Color]::Black; $t.SyncBar.Visible=$false
    $t.SyncHint=New-Object System.Windows.Forms.Label
    $t.SyncHint.Text='Sync chỉ chạy khi an toàn'; $t.SyncHint.ForeColor=[System.Drawing.Color]::Silver
    $t.SyncHint.AutoSize=$true; $t.SyncHint.Margin=New-Object System.Windows.Forms.Padding(3,9,6,0)
    $t.SyncBar.Controls.Add($t.SyncHint)
    $t.SyncNow=New-Object System.Windows.Forms.Button
    $t.SyncNow.Text='Đồng bộ ngay'; $t.SyncNow.Width=128; $t.SyncNow.Height=30
    $t.SyncNow.FlatStyle='Flat'; $t.SyncNow.BackColor=[System.Drawing.Color]::Black
    $t.SyncNow.ForeColor=[System.Drawing.Color]::White
    $t.SyncNow.FlatAppearance.BorderColor=[System.Drawing.Color]::DimGray
    $t.SyncNow.Add_Click({ Request-SyncNow })
    $t.SyncBar.Controls.Add($t.SyncNow)
    $t.Body = New-Object System.Windows.Forms.Panel
    $t.Body.Dock='Fill'; $t.Body.TabIndex=1
    $t.Split=New-Object System.Windows.Forms.SplitContainer
    $t.Split.Dock='Fill'; $t.Split.Orientation='Vertical'
    $t.Split.BackColor=[System.Drawing.Color]::Black
    $t.Split.SplitterWidth=6; $t.Split.Panel2Collapsed=$true
    $t.DetailWidth=350
    $t.Split.Add_SplitterMoved({
        if (!$script:portTopology.Split.Panel2Collapsed) {
            $script:portTopology.DetailWidth=$script:portTopology.Split.Panel2.Width
        }
    })
    $t.Split.AccessibleName='Sơ đồ và khung chi tiết kéo thay đổi chiều rộng'
    $t.Scroll = New-Object System.Windows.Forms.Panel
    $t.Scroll.Dock='Fill'; $t.Scroll.AutoScroll=$true
    $t.Graph = New-Object System.Windows.Forms.Panel
    $t.Graph.Size=New-Object System.Drawing.Size(960,520)
    $t.Graph.BackColor=[System.Drawing.Color]::Black
    $t.Scroll.Controls.Add($t.Graph)
    $t.List = New-Object System.Windows.Forms.ListView
    $t.List.Dock='Fill'; $t.List.View='Details'; $t.List.FullRowSelect=$true; $t.List.MultiSelect=$false
    $t.List.HideSelection=$false; $t.List.BackColor=[System.Drawing.Color]::Black; $t.List.ForeColor=[System.Drawing.Color]::White
    $t.List.AccessibleName='Danh sách cổng PC và VPS'; $t.List.Visible=$false
    foreach ($c in @(@('Host',60),@('Cổng',65),@('Dịch vụ',230),@('Trạng thái',145),@('Giao thức',300))) { $null=$t.List.Columns.Add($c[0],[int]$c[1]) }
    $groups=@{}
    foreach ($node in $t.Nodes) {
        if (!$groups.ContainsKey($node.Group)) { $groups[$node.Group]=$t.List.Groups.Add($node.Group,$node.Group) }
        $item=New-Object System.Windows.Forms.ListViewItem($node.Host)
        $item.Tag=$node.Id; $item.Group=$groups[$node.Group]
        $item.SubItems.AddRange([string[]]@($node.Port,$node.Service,'Chưa kiểm tra',$node.Protocol))
        $null=$t.List.Items.Add($item); $t.Items[$node.Id]=$item
        $button=New-Object System.Windows.Forms.Button
        $button.Location=New-Object System.Drawing.Point($node.X,$node.Y)
        $button.Size=New-Object System.Drawing.Size(160,76)
        $button.FlatStyle='Flat'; $button.BackColor=[System.Drawing.Color]::Black; $button.ForeColor=[System.Drawing.Color]::White
        $button.Font=New-Object System.Drawing.Font('Consolas',8.5)
        $button.Tag=$node.Id; $button.AccessibleName="$($node.Host) $($node.Port) $($node.Service)"
        $button.Add_Paint({
            param($sender,$e)
            $id=[string]$sender.Tag
            $node=@($script:portTopology.Nodes | Where-Object Id -eq $id)[0]
            $brush=if ($node.State -eq 'online') { [System.Drawing.Brushes]::White }
                elseif ($node.State -eq 'idle') { [System.Drawing.Brushes]::Gray }
                else { [System.Drawing.Brushes]::DimGray }
            $e.Graphics.FillEllipse($brush,143,8,9,9)
        })
        $button.Add_Click({ param($sender,$e) Select-PortNode ([string]$sender.Tag) -ShowDetails })
        $button.Add_Enter({
            param($sender,$e)
            # Focus alone can be assigned during initial window layout.
            Select-PortNode ([string]$sender.Tag)
            $script:portTopology.Scroll.ScrollControlIntoView($sender)
        })
        $button.Add_KeyDown({
            param($sender,$e)
            if ($e.KeyCode -in @([System.Windows.Forms.Keys]::Enter,[System.Windows.Forms.Keys]::Space)) {
                Select-PortNode ([string]$sender.Tag) -ShowDetails
            }
        })
        $t.Graph.Controls.Add($button); $t.Buttons[$node.Id]=$button
    }
    $t.Graph.Add_Paint({ param($sender,$e) Draw-PortTopology $e.Graphics })
    $t.List.Add_SelectedIndexChanged({
        $state=$script:portTopology
        if (!$state.Updating -and $state.List.SelectedItems.Count -eq 1) { Select-PortNode ([string]$state.List.SelectedItems[0].Tag) -ShowDetails }
    })
    $t.Layout.Add_SelectedIndexChanged({
        $state=$script:portTopology
        $state.Scroll.Visible=($state.Layout.SelectedIndex -eq 0); $state.List.Visible=!$state.Scroll.Visible
        Select-PortNode $state.Selected
    })
    $t.Body.Controls.Add($t.Scroll); $t.Body.Controls.Add($t.List)
    $t.Split.Panel1.Controls.Add($t.Body)
    $t.Split.Panel2.Controls.Add($t.Detail)
    $page.Controls.Add($t.Split); $page.Controls.Add($t.BackendBar); $page.Controls.Add($t.TunnelBar); $page.Controls.Add($t.SyncBar); $page.Controls.Add($bar)
    $t.Split.BringToFront(); $t.BackendBar.SendToBack(); $t.TunnelBar.SendToBack(); $t.SyncBar.SendToBack(); $bar.SendToBack()
    Refresh-PortTopology
}

function Get-PortStateText([string]$state) {
    switch ($state) {
        'online' { 'Online' }
        'idle' { 'Không chạy' }
        'offline' { 'Offline' }
        'warning' { 'Warning' }
        default { 'Chưa kiểm tra' }
    }
}

# Read-only monitoring calls this on the UI thread with an actual probe
# timestamp. This function itself performs no I/O and never invents a probe time.
function Set-PortStatus {
    param([string]$Id, [ValidateSet('unknown','online','idle','offline','warning')][string]$State='unknown', [Nullable[datetime]]$LastProbed=$null,
        [string]$Reason='Chưa kiểm tra', [string]$ProbeSource='Chưa có', [switch]$DeferRefresh)
    $node=$script:portTopology.Nodes | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if (!$node) { throw "Unknown topology node: $Id" }
    if ($State -ne 'unknown' -and $null -eq $LastProbed) { throw 'A checked state requires LastProbed.' }
    $node.State=$State; $node.LastProbed=$LastProbed; $node.Reason=$Reason; $node.ProbeSource=$ProbeSource
    if (!$DeferRefresh) { Refresh-PortTopology }
}

function Refresh-PortTopology {
    $t=$script:portTopology
    foreach ($node in $t.Nodes) {
        $state=Get-PortStateText $node.State
        $t.Buttons[$node.Id].Text="$($node.Host) : $($node.Port)`r`n$($node.Service)`r`n$state"
        $t.Items[$node.Id].SubItems[3].Text=$state
        $t.Buttons[$node.Id].Invalidate()
    }
    Select-PortNode $t.Selected
}

function Set-PortDetailsVisible([bool]$Visible) {
    $t=$script:portTopology
    if (!$t -or !$t.Split) { return }
    if ($Visible -and $t.Split.Panel2Collapsed) {
        $available=$t.Split.ClientSize.Width
        if ($available -gt (300+235+$t.Split.SplitterWidth)) {
            $t.Split.Panel2Collapsed=$false
            $width=[Math]::Min([int]$t.DetailWidth,[Math]::Max(235,$available-300-$t.Split.SplitterWidth))
            $t.Split.SplitterDistance=$available-$width-$t.Split.SplitterWidth
            $t.Split.Panel1MinSize=300; $t.Split.Panel2MinSize=235
        }
    } elseif (!$Visible) { $t.Split.Panel2Collapsed=$true }
    $t.DetailToggle.Text=if ($t.Split.Panel2Collapsed) { 'Chi tiết >' } else { 'Thu gọn <' }
}

function Select-PortNode([string]$Id,[switch]$ShowDetails) {
    $t=$script:portTopology
    $node=$t.Nodes | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if (!$node) { return }
    $t.Selected=$Id; $adjacent=@()
    $relations=@($t.Edges | Where-Object { $_.From -eq $Id -or $_.To -eq $Id })
    foreach ($edge in $relations) { $adjacent += $edge.From; $adjacent += $edge.To }
    foreach ($entry in $t.Nodes) {
        $selected=$entry.Id -eq $Id; $near=$entry.Id -in $adjacent
        $color=if ($selected) { [System.Drawing.Color]::White } elseif ($near) { [System.Drawing.Color]::Silver } else { [System.Drawing.Color]::DimGray }
        $t.Buttons[$entry.Id].FlatAppearance.BorderColor=$color
        $t.Buttons[$entry.Id].FlatAppearance.BorderSize=if ($selected) { 2 } else { 1 }
        $t.Buttons[$entry.Id].BackColor=if ($selected) { [System.Drawing.Color]::FromArgb(55,55,55) } else { [System.Drawing.Color]::Black }
        $t.Items[$entry.Id].ForeColor=$color
    }
    $t.Updating=$true
    try {
        foreach ($item in @($t.List.SelectedItems)) { if ($item.Tag -ne $Id) { $item.Selected=$false } }
        $t.Items[$Id].Selected=$true; $t.Items[$Id].Focused=$true
        if ($t.List.Visible) { $t.Items[$Id].EnsureVisible() }
    } finally { $t.Updating=$false }
    $last=if ($null -eq $node.LastProbed) { 'Chưa kiểm tra' } else { ([datetime]$node.LastProbed).ToString('yyyy-MM-dd HH:mm:ss K') }
    $lines=@("$($node.Host) | $($node.Service) | Cổng: $($node.Port) | $(Get-PortStateText $node.State)",
        "Kiểm tra gần nhất: $last", "Lý do: $($node.Reason)", "Nguồn probe: $($node.ProbeSource)", "Giao thức: $($node.Protocol)", "Nguồn tĩnh: $($node.Source)", "Nhóm: $($node.Group)")
    foreach ($edge in $relations) {
        $from=$t.Nodes | Where-Object { $_.Id -eq $edge.From } | Select-Object -First 1
        $to=$t.Nodes | Where-Object { $_.Id -eq $edge.To } | Select-Object -First 1
        $kind=switch ($edge.Kind) { 'application' { 'Ứng dụng' } 'conditional' { 'Có điều kiện' } default { 'Điều khiển/giám sát' } }
        $lines += "$($from.Service):$($from.Port) -> $($to.Service):$($to.Port) | $kind | $($edge.Description)"
    }
    if (!$relations.Count) { $lines += 'Hạ tầng chung chỉ đọc; không suy diễn thêm quan hệ ứng dụng.' }
    $t.Detail.Text=$lines -join "`r`n"
    if ($ShowDetails) { Set-PortDetailsVisible $true }
    $t.Graph.Invalidate()
    Update-PortControlAvailability
    Update-BackendControlAvailability
    Update-TunnelControlAvailability
    Update-SyncControlAvailability
}

function Update-SyncControlAvailability {
    $t=$script:portTopology
    if (!$t -or !$t.SyncBar) { return }
    $t.SyncBar.Visible=($t.Selected -eq 'sync')
    if (!$t.SyncBar.Visible) { return }
    $sync=@($t.Nodes | Where-Object Id -eq 'sync')[0]
    # The authoritative supervisor/remote-ledger preflight still rejects every
    # unsafe dispatch. These controls never bypass a same-day ledger claim.
    $t.SyncNow.Enabled=($script:role -eq 'owner' -and !$script:pending -and !$t.SyncJob -and
        $sync.State -in @('idle','warning'))
    $t.SyncHint.Text=if ($t.SyncJob) { 'Đang xác minh yêu cầu Sync...' }
        elseif ($sync.State -eq 'online') { 'Sync đang chạy; không thể dừng.' }
        else { 'Chỉ Owner; không chạy lại ledger đã ghi.' }
}

function Request-SyncNow {
    $t=$script:portTopology
    if ($script:role -ne 'owner' -or !$script:csrf -or $t.SyncJob -or $t.Selected -ne 'sync') { return }
    $timer.Stop(); $portTimer.Stop()
    try {
        $yes=[System.Windows.Forms.MessageBox]::Show($form,
            'Yêu cầu đồng bộ catalog PC sang VPS ngay hôm nay (JST). Cần ba worker đã kết thúc, không có lock bận, và ledger chưa được sử dụng. Không dừng Sync đang chạy, không tự retry. Tiếp tục?',
            'Xác nhận đồng bộ dữ liệu VPS','YesNo','Warning','Button2')
    } finally { $timer.Start(); $portTimer.Start() }
    if ($yes -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    # Owner must still have a current API session after the modal is dismissed.
    Start-Api 'GET' '/session' $null {
        param($session)
        if ($session.role -ne 'owner' -or !$script:csrf) { Set-Status 'Owner không hợp lệ; Sync bị từ chối.'; return }
        Start-SyncAction
    }
}

function Start-SyncAction {
    $t=$script:portTopology
    if ($t.SyncJob) { return }
    $cookie=$script:cookieJar.GetCookieHeader([uri]$script:origin)
    $csrf=[string]$script:csrf
    $ps=[powershell]::Create()
    try {
        $file=Join-Path $PSScriptRoot 'mita-sync-control.ps1'
        $null=$ps.AddScript('param($file,$session,$cookie,$csrf); & $file -Action SyncNow -SessionId $session -Confirmed -CookieHeader $cookie -CsrfToken $csrf').
            AddArgument($file).AddArgument($script:backendDesktopSession).AddArgument($cookie).AddArgument($csrf)
        $handle=$ps.BeginInvoke()
        $t.SyncJob=@{PowerShell=$ps;Handle=$handle}
        Set-Status 'Đang xác minh quyền Owner, trạng thái worker, khóa và ledger Sync...'
    } catch {
        $ps.Dispose(); Set-Status 'Không tạo được yêu cầu Sync.'
    } finally { $cookie=$null; $csrf=$null }
    Update-SyncControlAvailability
}

function Update-SyncAction {
    $t=$script:portTopology
    if (!$t -or !$t.SyncJob -or !$t.SyncJob.Handle.IsCompleted) { return }
    $job=$t.SyncJob
    try {
        $result=@($job.PowerShell.EndInvoke($job.Handle))
        if ($job.PowerShell.HadErrors -or $job.PowerShell.Streams.Error.Count -or !$result.Count -or
            $result[-1].state -cne 'accepted' -or $result[-1].owner.sessionId -cne $script:backendDesktopSession) {
            throw 'Sync rejected by supervisor or not verified.'
        }
        Set-Status 'Supervisor đã nhận yêu cầu Sync. Theo dõi trạng thái node và lịch sử; không tự chạy lại.'
        $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Sync accepted by supervisor; monitoring outcome."+[Environment]::NewLine)
    } catch {
        Set-Status 'Sync không được thực hiện: không đủ điều kiện, đã có ledger ngày, hoặc coordinator chưa cập nhật. Kiểm tra nhật ký Supervisor.'
    } finally {
        $job.PowerShell.Dispose(); $t.SyncJob=$null; $t.NextPoll=[datetime]::MinValue
    }
    Update-SyncControlAvailability
}

function Update-TunnelControlAvailability {
    $t=$script:portTopology
    if (!$t -or !$t.TunnelBar) { return }
    $t.TunnelBar.Visible=($t.Selected -eq 'tunnel')
    if (!$t.TunnelBar.Visible) { return }
    $busy=[bool]$t.TunnelJob -or [bool]$t.TunnelClosing
    $owned=[bool]$t.TunnelSession
    $expired=$owned -and ([datetime]::UtcNow -ge [datetime]::Parse($t.TunnelSession.ExpiresAt).ToUniversalTime())
    # Expiry triggers wrapper cleanup but is NOT proof that its SSH child exited.
    # Keep ownership until a verified Stop/Status confirms the exact child gone.
    $t.TunnelStart.Enabled=(!$busy -and !$owned -and $script:role -eq 'owner' -and !$script:pending -and
        (@($t.Nodes | Where-Object Id -eq 'tunnel')[0].State -eq 'idle'))
    $t.TunnelStop.Enabled=(!$busy -and $owned -and $script:role -eq 'owner' -and !$script:pending)
    $t.TunnelHint.Text=if ($expired) { 'Hết hạn: cần xác minh đã đóng' }
        elseif ($owned) { 'Tunnel chẩn đoán của phiên này' } else { 'Tunnel chẩn đoán (5 phút)' }
}

# Owner-only action: the live Admin session is revalidated after confirmation.
# The helper independently checks exact OS/process ownership and refuses foreign listeners.
function Request-TunnelAction([ValidateSet('Start','Stop')][string]$Action,[switch]$OnClose) {
    $t=$script:portTopology
    if ($t.TunnelJob -or (!$OnClose -and ($t.Selected -ne 'tunnel' -or $script:role -ne 'owner'))) { return }
    if ($Action -eq 'Stop' -and !$t.TunnelSession) { return }
    if (!$OnClose) {
        $timer.Stop(); $portTimer.Stop()
        try {
            $description=if ($Action -eq 'Start') {
                'Mở SSH tunnel chẩn đoán 15432 tối đa 5 phút; KHÔNG đồng bộ hoặc ghi VPS. Có thể chặn Sync theo lịch trong thời gian này.'
            } else { 'Đóng chỉ tunnel chẩn đoán do phiên Desktop này tạo; không dừng tunnel Sync.' }
            $choice=[System.Windows.Forms.MessageBox]::Show($form,$description,'Xác nhận Tunnel 15432','YesNo','Warning','Button2')
        } finally { $timer.Start(); $portTimer.Start() }
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes -or !$script:csrf) { return }
        $script:plannedTunnelAction=$Action
        Start-Api 'GET' '/session' $null {
            param($session)
            $planned=$script:plannedTunnelAction; $script:plannedTunnelAction=$null
            if (!$planned -or $session.role -ne 'owner') { Set-Status 'Chỉ Owner đã xác thực được điều khiển tunnel chẩn đoán.'; return }
            Start-TunnelAction $planned
        }
    } else { Start-TunnelAction 'Stop' -OnClose }
}

function Start-TunnelAction([ValidateSet('Start','Stop')][string]$Action,[switch]$OnClose) {
    $t=$script:portTopology
    if ($t.TunnelJob) { return }
    $ps=[powershell]::Create()
    try {
        $file=Join-Path $PSScriptRoot 'mita-tunnel-diagnostic.ps1'
        $null=$ps.AddScript('param($file,$action,$session); & $file -Action $action -SessionId $session').
            AddArgument($file).AddArgument($Action).AddArgument($script:backendDesktopSession)
        $handle=$ps.BeginInvoke()
        $t.TunnelJob=@{PowerShell=$ps;Handle=$handle;Action=$Action;Closing=[bool]$OnClose}
        Set-Status "Tunnel chẩn đoán: đang $Action; chờ xác minh."
    } catch {
        $ps.Dispose(); $t.TunnelClosing=$false
        Set-Status 'Không tạo được yêu cầu điều khiển tunnel.'
    }
    Update-TunnelControlAvailability
}

function Update-TunnelAction {
    $t=$script:portTopology
    if (!$t -or !$t.TunnelJob -or !$t.TunnelJob.Handle.IsCompleted) { return }
    $job=$t.TunnelJob; $success=$false
    try {
        $result=@($job.PowerShell.EndInvoke($job.Handle))
        if ($job.PowerShell.HadErrors -or $job.PowerShell.Streams.Error.Count) { throw ([string]$job.PowerShell.Streams.Error[0]) }
        if ($job.Action -eq 'Start') {
            if (!$result.Count -or $result[-1].SessionId -cne $script:backendDesktopSession) { throw 'Tunnel owner is not verified.' }
            $t.TunnelSession=$result[-1]
        } else { $t.TunnelSession=$null }
        $success=$true
        Set-Status "Tunnel chẩn đoán $($job.Action) hoàn tất; thời hạn tự đóng 5 phút."
    } catch {
        Set-Status 'Tunnel chẩn đoán bị từ chối hoặc không xác minh được; không can thiệp listener lạ.'
    } finally {
        $job.PowerShell.Dispose(); $t.TunnelJob=$null; $t.TunnelClosing=$false
        $t.NextPoll=[datetime]::MinValue
    }
    Update-TunnelControlAvailability
    if ($job.Closing -and $success) { $form.BeginInvoke([Action]{ $form.Close() }) | Out-Null }
    elseif ($job.Closing) { [void][System.Windows.Forms.MessageBox]::Show($form,'Tunnel chưa xác minh đã đóng; cửa sổ vẫn mở.','Mita Japan','OK','Warning') }
}

function Update-BackendControlAvailability {
    $t=$script:portTopology
    if (!$t -or !$t.BackendBar) { return }
    $selected=$t.Selected -eq 'pc-api'
    $t.BackendBar.Visible=$selected
    if (!$selected) { return }
    $api=@($t.Nodes | Where-Object Id -eq 'pc-api')[0]
    $busy=[bool]$t.BackendJob -or [bool]$t.BackendClosing
    $t.BackendStart.Text=if ($api.State -eq 'online' -or $t.BackendSession) { 'Đang chạy' } else { 'Chạy' }
    # Mode can be changed for the next Restart; it never changes a running job.
    $t.BackendMode.Enabled=(!$busy)
    $t.BackendStart.Enabled=(!$busy -and !$t.BackendSession -and $api.State -eq 'offline')
    $owned=[bool]$t.BackendSession
    $t.BackendStop.Enabled=(!$busy -and $owned)
    $t.BackendRestart.Enabled=(!$busy -and $owned)
}

# Local bootstrap is intentionally independent of the Admin API: when 4000 is
# down, /session is unreachable. Staff is allowed to request this Windows-local
# operation; API write permissions remain unchanged.
function Request-BackendAction([ValidateSet('start','stop','restart')][string]$Action,[switch]$OnClose) {
    $t=$script:portTopology
    if ($t.BackendJob -or (!$OnClose -and $t.Selected -ne 'pc-api')) { return }
    if ($Action -in @('stop','restart') -and !$t.BackendSession) { return }
    if ($Action -eq 'start' -and $t.BackendSession) { return }
    $mode=if ($t.BackendMode.SelectedIndex -eq 0) { 'Dev' } else { 'Start' }
    $install=$false
    if (!$OnClose) {
        $description=switch ($Action) {
            'start' { "Chạy backend Mita trên PC, mode $mode, cổng 4000." }
            'stop' { 'Dừng an toàn backend do cửa sổ này khởi động; không dừng PostgreSQL 5433.' }
            'restart' { "Khởi động lại backend do cửa sổ này quản lý ở mode $mode. Kết nối quản trị có thể gián đoạn." }
        }
        $timer.Stop(); $portTimer.Stop()
        try {
            $yes=[System.Windows.Forms.MessageBox]::Show($form,
                "$description"+[Environment]::NewLine+'Thao tác chỉ ảnh hưởng backend local, không tác động VPS/worker.',
                'Xác nhận backend Mita 4000','YesNo','Warning','Button2')
            if ($yes -ne [System.Windows.Forms.DialogResult]::Yes) { return }
            # Match the helper's full direct-dependency check. Missing a package
            # other than fastify/tsx must still trigger explicit install consent.
            $missingDeps=$false
            if ($Action -in @('start','restart')) {
                $backend=Join-Path $script:root 'backend'
                $package=Get-Content -LiteralPath (Join-Path $backend 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                $missingDeps=!(Test-Path -LiteralPath (Join-Path $backend 'node_modules/.bin/tsx.cmd'))
                foreach ($dependency in @(@($package.dependencies.PSObject.Properties.Name)+@($package.devDependencies.PSObject.Properties.Name))) {
                    if (!(Test-Path -LiteralPath (Join-Path $backend ('node_modules/'+$dependency+'/package.json')))) {
                        $missingDeps=$true; break
                    }
                }
            }
            if ($missingDeps) {
                $answer=[System.Windows.Forms.MessageBox]::Show($form,
                    'Thiếu dependencies backend. Cho phép chạy npm install trong thư mục backend? Không thực hiện migration.',
                    'Xác nhận cài dependencies','YesNo','Warning','Button2')
                if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
                $install=$true
            }
        } finally { $timer.Start(); $portTimer.Start() }
    }
    $ps=[powershell]::Create()
    try {
        $helper=Join-Path $PSScriptRoot 'mita-backend-control.ps1'
        $null=$ps.AddScript('param($file,$action,$mode,$session,$install); & $file -Action $action -Mode $mode -SessionId $session -OnlyIfSessionOwned -InstallDependenciesConfirmed:$install').
            AddArgument($helper).AddArgument($Action).AddArgument($mode).
            AddArgument($script:backendDesktopSession).AddArgument($install)
        $handle=$ps.BeginInvoke()
        $t.BackendJob=@{ PowerShell=$ps; Handle=$handle; Action=$Action; Closing=[bool]$OnClose }
        Set-Status "Backend 4000: đang $Action (mode $mode); chờ xác minh."
        $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Backend 4000 $Action requested ($mode); pending verification."+[Environment]::NewLine)
    } catch {
        $ps.Dispose()
        $t.BackendClosing=$false
        Set-Status 'Không thể tạo tiến trình điều khiển backend 4000.'
    }
    Update-BackendControlAvailability
}

function Update-BackendAction {
    $t=$script:portTopology
    if (!$t.BackendJob -or !$t.BackendJob.Handle.IsCompleted) { return }
    $job=$t.BackendJob
    $success=$false; $message=''
    try {
        $results=@($job.PowerShell.EndInvoke($job.Handle))
        if ($job.PowerShell.HadErrors -or $job.PowerShell.Streams.Error.Count) {
            throw ([string]$job.PowerShell.Streams.Error[0])
        }
        if ($job.Action -eq 'stop') {
            $t.BackendSession=$null
            $message='Backend 4000: yêu cầu dừng hoàn tất; đang làm mới health.'
        } elseif ($results.Count -and $results[-1].State -in @('ready','already-running')) {
            $result=$results[-1]
            if ($result.Owner.SessionId -cne $script:backendDesktopSession) {
                throw 'Backend thuộc phiên khác; không nhận quyền dừng.'
            }
            $t.BackendSession=$result.Owner
            $message="Backend 4000: $($result.State); đang làm mới health."
        } else { throw 'Backend chưa được xác minh sẵn sàng.' }
        $success=$true
    } catch {
        $message='Backend 4000 thất bại hoặc không xác minh được. Xem log .agents/runtime/backend-4000; không kill tiến trình lạ.'
    } finally {
        $job.PowerShell.Dispose()
        $t.BackendJob=$null; $t.BackendClosing=$false
        $t.NextPoll=[datetime]::MinValue
    }
    Set-Status $message
    $auditResult=if ($success) { 'completed' } else { 'not verified; inspect local audit' }
    $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Backend 4000 $($job.Action) $auditResult."+[Environment]::NewLine)
    Update-BackendControlAvailability
    if ($job.Closing -and $success) { $form.BeginInvoke([Action]{ $form.Close() }) | Out-Null }
    elseif ($job.Closing) {
        [void][System.Windows.Forms.MessageBox]::Show($form,
            'Không xác nhận được backend đã dừng an toàn. Cửa sổ vẫn mở để bạn kiểm tra log và thử lại.',
            'Mita Japan','OK','Warning')
    }
}

function Update-PortControlAvailability {
    $t=$script:portTopology
    if (!$t -or !$t.Control) { return }
    $node=@($t.Nodes | Where-Object Id -eq $t.Selected)
    $valid=($node.Count -eq 1 -and $t.Selected -in @('gateway','supervisor'))
    $operation=if ($valid -and $node[0].State -eq 'online') { 'Dừng an toàn' } else { 'Bật' }
    $t.Control.Text=if ($valid) { "$operation $($node[0].Port)" } else { 'Chỉ xem / không điều khiển' }
    $t.Control.Enabled=($valid -and $node[0].State -in @('online','offline') -and
        $script:role -eq 'owner' -and !$script:pending -and !$t.ActionJob)
}

function Start-PortControlAction([string]$service,[string]$action) {
    $t=$script:portTopology
    if ($t.ActionJob -or $script:role -ne 'owner' -or $service -notin @('gateway','supervisor') -or $action -notin @('start','stop')) { return }
    $ps=[powershell]::Create()
    try {
        $file=Join-Path $PSScriptRoot 'mita-port-control.ps1'
        $null=$ps.AddScript('param($file,$service,$action); & $file -Service $service -Action $action').AddArgument($file).AddArgument($service).AddArgument($action)
        $handle=$ps.BeginInvoke()
        $t.ActionJob=@{ PowerShell=$ps; Handle=$handle; Service=$service; Operation=$action }
        Set-Status "Đã gửi tác vụ $action cho $service trên PC; chờ xác nhận thực tế."
    } catch {
        $ps.Dispose()
        Set-Status 'Không khởi chạy được tác vụ điều khiển. Chưa có xác nhận thay đổi dịch vụ.'
    }
    Update-PortControlAvailability
}

function Update-PortControlAction {
    $t=$script:portTopology
    if (!$t.ActionJob -or !$t.ActionJob.Handle.IsCompleted) { return }
    $job=$t.ActionJob; $message='Tác vụ PC chưa được xác nhận.'
    try {
        $output=$job.PowerShell.EndInvoke($job.Handle)
        if ($job.PowerShell.HadErrors -or $job.PowerShell.Streams.Error.Count) { throw 'Control script returned an error' }
        $message=if ($output.Count) { ([string]$output[-1]) } else { 'Không có kết quả điều khiển được xác nhận.' }
        $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Owner PC control $($job.Service)/$($job.Operation) completed; verify observed port state." + [Environment]::NewLine)
    } catch {
        $message='Điều khiển PC bị từ chối hoặc lỗi. Xem nhật ký kiểm soát cục bộ; chưa xác nhận thay đổi.'
        $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Owner PC control $($job.Service)/$($job.Operation) not confirmed." + [Environment]::NewLine)
    } finally {
        $job.PowerShell.Dispose(); $t.ActionJob=$null
        $t.NextPoll=[datetime]::MinValue
    }
    Set-Status $message
    Update-PortControlAvailability
}

# UI timer only inspects completion; never waits for network, native processes or
# runspace Stop/Dispose. One job at a time, even after a watchdog cancellation.
function Update-PortMonitor([bool]$Active) {
    $t=$script:portTopology
    if ($t.Closing) { return }
    if ($t.Job) {
        $job=$t.Job
        if ($job.Handle.IsCompleted -and (!$job.StopHandle -or $job.StopHandle.IsCompleted)) {
            try {
                if ($job.StopHandle) { $job.PowerShell.EndStop($job.StopHandle) }
                $results=$job.PowerShell.EndInvoke($job.Handle)
                if (!$job.Cancelled) {
                    foreach ($r in $results) { Set-PortStatus -Id $r.Id -State $r.State -LastProbed $r.LastProbed -Reason $r.Reason -ProbeSource $r.ProbeSource -DeferRefresh }
                }
            } catch {
                foreach ($node in $t.Nodes) { Set-PortStatus $node.Id unknown $null 'Probe không hoàn tất; chưa xác định.' 'Dedicated monitoring runspace' -DeferRefresh }
            } finally {
                $job.PowerShell.Dispose(); $t.Job=$null
            }
            Refresh-PortTopology
        } elseif (!$job.Cancelled -and [datetime]::Now -ge $job.Deadline) {
            $job.Cancelled=$true
            $job.StopHandle=$job.PowerShell.BeginStop($null,$null)
            foreach ($node in $t.Nodes) { Set-PortStatus $node.Id unknown $node.LastProbed 'Quá hạn probe; chờ worker kết thúc, không chạy chồng.' 'Runspace watchdog (30s)' -DeferRefresh }
            Refresh-PortTopology
        }
    }
    if (!$Active -or $t.Job -or [datetime]::Now -lt $t.NextPoll) { return }
    $t.NextPoll=[datetime]::Now.AddSeconds([double]$t.Interval.Value)
    $ps=[powershell]::Create()
    try {
        $null=$ps.AddScript('param($file); . $file; Invoke-PortProbes').AddArgument((Join-Path $PSScriptRoot 'mita-desktop-probes.ps1'))
        $handle=$ps.BeginInvoke()
        $t.Job=@{ PowerShell=$ps; Handle=$handle; StopHandle=$null; Cancelled=$false; Deadline=[datetime]::Now.AddSeconds(30) }
    } catch {
        $ps.Dispose()
        foreach ($node in $t.Nodes) { Set-PortStatus $node.Id unknown $null 'Không tạo được worker an toàn.' 'Dedicated monitoring runspace' -DeferRefresh }
        Refresh-PortTopology
    }
}

function Close-PortMonitor {
    $t=$script:portTopology; $t.Closing=$true
    if ($t.Job -and !$t.Job.Cancelled) {
        $t.Job.Cancelled=$true
        $t.Job.StopHandle=$t.Job.PowerShell.BeginStop($null,$null)
    }
    # Do not synchronously Dispose a running pipeline during form shutdown.
}

function Draw-PortTopology($graphics) {
    $t=$script:portTopology
    $graphics.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $font=$t.Graph.Font
    $graphics.DrawString('PC / Mita + tiến trình (không phải cổng)', $font, [System.Drawing.Brushes]::Silver, [single]20, [single]12)
    $graphics.DrawString('VPS / Mita', $font, [System.Drawing.Brushes]::Silver, [single]780, [single]12)
    $graphics.DrawString('Hạ tầng chung / chỉ đọc: 80, 443, 9010, 22', $font, [System.Drawing.Brushes]::Silver, [single]20, [single]406)
    foreach ($edge in $t.Edges) {
        $a=$t.Buttons[$edge.From].Bounds; $b=$t.Buttons[$edge.To].Bounds
        $ax=$a.X+$a.Width/2.0; $ay=$a.Y+$a.Height/2.0
        $bx=$b.X+$b.Width/2.0; $by=$b.Y+$b.Height/2.0
        $dx=$bx-$ax; $dy=$by-$ay
        # Intersect center-to-center vector with both rectangular node borders.
        $sx=if ($dx -eq 0) { [double]::PositiveInfinity } else { ($a.Width/2.0)/[Math]::Abs($dx) }
        $sy=if ($dy -eq 0) { [double]::PositiveInfinity } else { ($a.Height/2.0)/[Math]::Abs($dy) }
        $start=[Math]::Min($sx,$sy)
        $ex=if ($dx -eq 0) { [double]::PositiveInfinity } else { ($b.Width/2.0)/[Math]::Abs($dx) }
        $ey=if ($dy -eq 0) { [double]::PositiveInfinity } else { ($b.Height/2.0)/[Math]::Abs($dy) }
        $end=[Math]::Min($ex,$ey)
        $highlight=$edge.From -eq $t.Selected -or $edge.To -eq $t.Selected
        $color=if ($highlight) { [System.Drawing.Color]::White } else { [System.Drawing.Color]::DimGray }
        $pen=New-Object System.Drawing.Pen($color, [single]$(if ($highlight) { 2 } else { 1 }))
        $cap=New-Object System.Drawing.Drawing2D.AdjustableArrowCap(4,5)
        try {
            $pen.DashStyle=switch ($edge.Kind) { 'conditional' { [System.Drawing.Drawing2D.DashStyle]::Dash } 'control' { [System.Drawing.Drawing2D.DashStyle]::Dot } default { [System.Drawing.Drawing2D.DashStyle]::Solid } }
            $pen.CustomEndCap=$cap
            if ($edge.From -eq 'sync' -and $edge.To -eq 'pc-db') {
                # Route the read relation around Gateway; never draw through a
                # third node or imply a DB-to-DB socket.
                $points=[System.Drawing.PointF[]]@(
                    [System.Drawing.PointF]::new(380,338),
                    [System.Drawing.PointF]::new(370,338),
                    [System.Drawing.PointF]::new(370,130),
                    [System.Drawing.PointF]::new(460,130),
                    [System.Drawing.PointF]::new(460,116))
                $graphics.DrawLines($pen,$points)
            } else {
                $graphics.DrawLine($pen,[single]($ax+$dx*$start),[single]($ay+$dy*$start),[single]($bx-$dx*$end),[single]($by-$dy*$end))
                # Moving dashes show a configured route, NOT observed traffic.
                $from=@($t.Nodes | Where-Object Id -eq $edge.From)[0]
                $to=@($t.Nodes | Where-Object Id -eq $edge.To)[0]
                if ($t.Motion.Checked -and $from.State -eq 'online' -and $to.State -eq 'online') {
                    $motionPen=New-Object System.Drawing.Pen([System.Drawing.Color]::White,[single]1)
                    try {
                        $motionPen.DashPattern=[single[]]@(1,6)
                        $motionPen.DashOffset=$t.MotionPhase
                        $graphics.DrawLine($motionPen,[single]($ax+$dx*$start),[single]($ay+$dy*$start),[single]($bx-$dx*$end),[single]($by-$dy*$end))
                    } finally { $motionPen.Dispose() }
                }
            }
        } finally { $pen.Dispose(); $cap.Dispose() }
    }
}
