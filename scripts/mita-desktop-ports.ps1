# Dot-sourced at script scope by mita-desktop.ps1. All event state lives in
# $script:portTopology; handlers never capture Initialize-PortTab local variables.
# Static display only: no timers, sockets, HTTP, commands or service controls.
function Initialize-PortTab($page) {
    $script:portTopology = @{ Nodes=@(); Edges=@(); Selected='pc-web'; Buttons=@{}; Items=@{}; Updating=$false }
    $t = $script:portTopology
    # ID, host, port, service, protocol, source, group, graph X/Y.
    $definitions = @(
        @('pc-web','PC','3000','Web','HTTP','scripts/start-local.ps1','PC / Mita',20,40),
        @('pc-api','PC','4000','API','HTTP','scripts/start-local.ps1','PC / Mita',200,40),
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
        $t.Nodes += [pscustomobject]@{ Id=$d[0]; Host=$d[1]; Port=$d[2]; Service=$d[3]; Protocol=$d[4]; Source=$d[5]; Group=$d[6]; X=[int]$d[7]; Y=[int]$d[8]; State='unknown'; LastProbed=$null }
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
    $label = New-Object System.Windows.Forms.Label
    $label.Text='Bố cục (&B):'; $label.AutoSize=$true; $label.Margin=New-Object System.Windows.Forms.Padding(3,5,3,0)
    $bar.Controls.Add($label)
    $t.Layout = New-Object System.Windows.Forms.ComboBox
    $t.Layout.DropDownStyle='DropDownList'; $t.Layout.Width=225
    $t.Layout.AccessibleName='Bố cục Cổng'; $t.Layout.TabIndex=0
    $t.Layout.Items.AddRange([object[]]@('Mạng nhện','Danh sách PC/VPS')); $t.Layout.SelectedIndex=0
    $bar.Controls.Add($t.Layout)
    $note = New-Object System.Windows.Forms.Label
    $note.Text='10 cổng Mita + hạ tầng chỉ đọc'; $note.AutoSize=$true; $note.Margin=New-Object System.Windows.Forms.Padding(12,5,0,0)
    $bar.Controls.Add($note)

    $legend = New-Object System.Windows.Forms.Label
    $legend.Dock='Top'; $legend.Height=52; $legend.Padding=New-Object System.Windows.Forms.Padding(8,2,8,0)
    $legend.Text="Sơ đồ quan hệ, không phải lưu lượng thực`r`nLiền → ứng dụng | Đứt → có điều kiện | Chấm → điều khiển/giám sát`r`nCấu hình/giao thức đã biết; chưa kiểm tra kết nối. Tab / phím mũi tên để chọn."
    $legend.Font=New-Object System.Drawing.Font('Consolas',9)
    $t.Detail = New-Object System.Windows.Forms.TextBox
    $t.Detail.Dock='Bottom'; $t.Detail.Height=148; $t.Detail.Multiline=$true; $t.Detail.ReadOnly=$true
    $t.Detail.ScrollBars='Vertical'; $t.Detail.BackColor=[System.Drawing.Color]::Black; $t.Detail.ForeColor=[System.Drawing.Color]::White
    $t.Detail.AccessibleName='Chi tiết cổng và quan hệ'; $t.Detail.TabIndex=2
    $t.Body = New-Object System.Windows.Forms.Panel
    $t.Body.Dock='Fill'; $t.Body.TabIndex=1
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
        $button.Add_Click({ param($sender,$e) Select-PortNode ([string]$sender.Tag) })
        $button.Add_Enter({
            param($sender,$e)
            Select-PortNode ([string]$sender.Tag)
            $script:portTopology.Scroll.ScrollControlIntoView($sender)
        })
        $t.Graph.Controls.Add($button); $t.Buttons[$node.Id]=$button
    }
    $t.Graph.Add_Paint({ param($sender,$e) Draw-PortTopology $e.Graphics })
    $t.List.Add_SelectedIndexChanged({
        $state=$script:portTopology
        if (!$state.Updating -and $state.List.SelectedItems.Count -eq 1) { Select-PortNode ([string]$state.List.SelectedItems[0].Tag) }
    })
    $t.Layout.Add_SelectedIndexChanged({
        $state=$script:portTopology
        $state.Scroll.Visible=($state.Layout.SelectedIndex -eq 0); $state.List.Visible=!$state.Scroll.Visible
        Select-PortNode $state.Selected
    })
    $t.Body.Controls.Add($t.Scroll); $t.Body.Controls.Add($t.List)
    $page.Controls.Add($t.Body); $page.Controls.Add($t.Detail); $page.Controls.Add($legend); $page.Controls.Add($bar)
    # Explicit z-order keeps docked header/detail outside the scrollable canvas.
    $t.Body.BringToFront(); $t.Detail.SendToBack(); $legend.SendToBack(); $bar.SendToBack()
    Refresh-PortTopology
}

function Get-PortStateText([string]$state) {
    switch ($state) {
        'reachable' { 'Có phản hồi' }
        'unreachable' { 'Không có phản hồi' }
        'error' { 'Lỗi kiểm tra' }
        default { 'Chưa kiểm tra' }
    }
}

# Future read-only monitoring calls this on the UI thread with an actual probe
# timestamp. This function itself performs no I/O and never invents a probe time.
function Set-PortStatus {
    param([string]$Id, [ValidateSet('unknown','reachable','unreachable','error')][string]$State='unknown', [Nullable[datetime]]$LastProbed=$null)
    $node=$script:portTopology.Nodes | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if (!$node) { throw "Unknown topology node: $Id" }
    if ($State -ne 'unknown' -and $null -eq $LastProbed) { throw 'A checked state requires LastProbed.' }
    $node.State=$State; $node.LastProbed=$LastProbed
    Refresh-PortTopology
}

function Refresh-PortTopology {
    $t=$script:portTopology
    foreach ($node in $t.Nodes) {
        $state=Get-PortStateText $node.State
        $t.Buttons[$node.Id].Text="$($node.Host) : $($node.Port)`r`n$($node.Service)`r`n$state"
        $t.Items[$node.Id].SubItems[3].Text=$state
    }
    Select-PortNode $t.Selected
}

function Select-PortNode([string]$Id) {
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
        "Kiểm tra gần nhất: $last", "Giao thức: $($node.Protocol)", "Nguồn tĩnh: $($node.Source)", "Nhóm: $($node.Group)")
    foreach ($edge in $relations) {
        $from=$t.Nodes | Where-Object { $_.Id -eq $edge.From } | Select-Object -First 1
        $to=$t.Nodes | Where-Object { $_.Id -eq $edge.To } | Select-Object -First 1
        $kind=switch ($edge.Kind) { 'application' { 'Ứng dụng' } 'conditional' { 'Có điều kiện' } default { 'Điều khiển/giám sát' } }
        $lines += "$($from.Service):$($from.Port) -> $($to.Service):$($to.Port) | $kind | $($edge.Description)"
    }
    if (!$relations.Count) { $lines += 'Hạ tầng chung chỉ đọc; không suy diễn thêm quan hệ ứng dụng.' }
    $t.Detail.Text=$lines -join "`r`n"
    $t.Graph.Invalidate()
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
            }
        } finally { $pen.Dispose(); $cap.Dispose() }
    }
}
