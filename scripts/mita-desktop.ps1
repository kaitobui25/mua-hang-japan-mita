# Windows PowerShell 5.1. No services are started and no credentials are persisted.
# All HTTP work uses asynchronous .NET tasks, polled on the UI thread.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Data
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:origin = 'http://127.0.0.1:4000'
$script:root = Split-Path $PSScriptRoot -Parent
$script:backendDesktopSession = [guid]::NewGuid().ToString('N')
$script:csrf = $null
$script:pending = $null
$script:nextRefresh = [datetime]::Now
$script:nextNotifications = [datetime]::Now
$script:role = $null
$script:pricingDirty = $false
$script:loadingPricing = $false
$script:unread = 0
$script:relayStatus = 'unknown'

function New-Client {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $handler.CookieContainer = New-Object System.Net.CookieContainer
    $script:cookieJar = $handler.CookieContainer
    $script:client = New-Object System.Net.Http.HttpClient($handler)
    # Desktop diagnostics may verify PC and VPS in parallel (bounded at 15s).
    $script:client.Timeout = [timespan]::FromSeconds(20)
}
New-Client

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MITA JAPAN | Điều hành'
$form.Size = New-Object System.Drawing.Size(1150, 760)
$form.MinimumSize = New-Object System.Drawing.Size(900, 600)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::Black
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Consolas', 10)
$top = New-Object System.Windows.Forms.FlowLayoutPanel
$top.Dock = 'Top'; $top.Height = 110; $top.Padding = New-Object System.Windows.Forms.Padding(8, 8, 8, 0); $top.WrapContents = $true
$brand = New-Object System.Windows.Forms.Label
$brand.Text = 'MITA JAPAN  |  ADMIN TERMINAL'; $brand.AutoSize = $true; $brand.Margin = New-Object System.Windows.Forms.Padding(3, 8, 16, 0); $top.Controls.Add($brand)
$username = New-Object System.Windows.Forms.TextBox
$username.Width = 135; $username.MaxLength = 128
$userLabel = New-Object System.Windows.Forms.Label; $userLabel.Text = 'Tài khoản'; $userLabel.AutoSize = $true; $userLabel.Margin = New-Object System.Windows.Forms.Padding(3, 8, 3, 0); $top.Controls.Add($userLabel); $top.Controls.Add($username)
$passLabel = New-Object System.Windows.Forms.Label; $passLabel.Text = 'Mật khẩu'; $passLabel.AutoSize = $true; $passLabel.Margin = New-Object System.Windows.Forms.Padding(3, 8, 3, 0); $top.Controls.Add($passLabel)
$form.Controls.Add($top)
function Add-Button($parent, $text, $action) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.AutoSize = $true; $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderColor = [System.Drawing.Color]::DimGray; $b.Padding = New-Object System.Windows.Forms.Padding(5, 2, 5, 2); $b.BackColor = [System.Drawing.Color]::Black
    $b.ForeColor = [System.Drawing.Color]::White
    $b.Add_Click($action); $parent.Controls.Add($b)
    return $b
}
$password = New-Object System.Windows.Forms.TextBox
$password.UseSystemPasswordChar = $true; $password.Width = 140; $password.MaxLength = 128
$top.Controls.Add($password)
$login = Add-Button $top 'Đăng nhập' {
    if ($script:pending) { return }
    Set-AuthFeedback 'Đang xác thực...' 'pending'
    $body = @{password=$password.Text}; if ($username.Text.Trim()) { $body.username = $username.Text.Trim() }; $password.Clear()
    Start-Api 'POST' '/login' $body {
        param($value)
        $script:csrf = $value.csrfToken
        $password.Enabled = $false; $username.Enabled = $false; $login.Enabled = $false
        Start-Api 'GET' '/session' $null {
            param($session)
            if ($session.role -notin @('owner','staff')) { Clear-Session; Set-Status 'Không xác định được vai trò phiên đăng nhập.'; return }
            $script:role = $session.role; Update-WriteControls
            $roleName=if ($session.role -eq 'owner') { 'Owner' } else { 'Staff' }
            Set-AuthFeedback "Đã đăng nhập: $roleName" 'success'
            Set-Status "Đăng nhập thành công: $roleName."
            $script:nextNotifications = [datetime]::MinValue; Refresh-View
        }
    }
    $body.Clear()
}
$password.Add_KeyDown({
    param($sender,$e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
        $e.Handled=$true; $e.SuppressKeyPress=$true
        if ($login.Enabled) { $login.PerformClick() }
    }
})
$script:authStatus=New-Object System.Windows.Forms.Label
$authStatus.Text='Chưa đăng nhập'; $authStatus.AutoSize=$false
$authStatus.Width=260; $authStatus.Height=27
$authStatus.Margin=New-Object System.Windows.Forms.Padding(9,6,3,0)
$authStatus.ForeColor=[System.Drawing.Color]::Silver
$authStatus.AccessibleName='Trạng thái xác thực Owner hoặc Staff'
$top.Controls.Add($authStatus)
$refresh = Add-Button $top 'Làm mới' { Refresh-View -ForceComparison }
$logout = Add-Button $top 'Đăng xuất' {
    if (!$script:pending -and $script:csrf) {
        Start-Api 'POST' '/logout' @{} { param($value) Clear-Session; Set-Status 'Logged out.' }
    }
}
$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'; $status.Height = 52; $status.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 0); $status.BorderStyle = 'FixedSingle'
$status.Text = 'Chưa đăng nhập  |  API: http://127.0.0.1:4000  |  Không khởi chạy workers.'
$form.Controls.Add($status)
$sourceStatus = New-Object System.Windows.Forms.Label
$sourceStatus.Dock = 'Top'; $sourceStatus.Height = 28
$sourceStatus.Padding = New-Object System.Windows.Forms.Padding(10, 3, 0, 0)
$sourceStatus.Text = 'NGUỒN API: 127.0.0.1:4000  |  VPS: chưa xác định'
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'; $form.Controls.Add($tabs); $tabs.BringToFront()
$script:pages = @{}; $script:views = @{}
$script:pageLabels = @{Overview='Tổng quan'; Notifications='Thông báo [0]'; Orders='Đơn hàng'; Products='Sản phẩm'; Pricing='Cấu hình giá'; Workers='Workers'; Ports='Cổng'; Logs='Nhật ký'}
$tabs.DrawMode = 'OwnerDrawFixed'; $tabs.SizeMode = 'Fixed'; $tabs.ItemSize = New-Object System.Drawing.Size(118, 32)
$tabs.Add_DrawItem({ param($sender, $e)
    $rect = $sender.GetTabRect($e.Index); $selected = $e.Index -eq $sender.SelectedIndex
    $brush = if ($selected) { [System.Drawing.Brushes]::DimGray } else { [System.Drawing.Brushes]::Black }
    $e.Graphics.FillRectangle($brush, $rect); $e.Graphics.DrawRectangle([System.Drawing.Pens]::Gray, $rect)
    [System.Windows.Forms.TextRenderer]::DrawText($e.Graphics, $sender.TabPages[$e.Index].Text, $sender.Font, $rect, [System.Drawing.Color]::White, ([System.Windows.Forms.TextFormatFlags]::HorizontalCenter -bor [System.Windows.Forms.TextFormatFlags]::VerticalCenter -bor [System.Windows.Forms.TextFormatFlags]::EndEllipsis))
})
foreach ($name in @('Overview','Notifications','Orders','Products','Pricing','Workers','Ports','Logs')) {
    $page = New-Object System.Windows.Forms.TabPage
    $page.Text = $script:pageLabels[$name]; $page.Name = $name; $page.BackColor = [System.Drawing.Color]::Black
    $page.ForeColor = [System.Drawing.Color]::White; $tabs.TabPages.Add($page)
    $script:pages[$name] = $page
}
function Update-TabWidths {
    if ($tabs.TabCount -le 0) { return }
    $size=[Math]::Max(96,[Math]::Min(118,[Math]::Floor(($tabs.ClientSize.Width - 16) / $tabs.TabCount)))
    if ($tabs.ItemSize.Width -ne $size) { $tabs.ItemSize=New-Object System.Drawing.Size([int]$size,32) }
}
$tabs.Add_Resize({ Update-TabWidths })
Update-TabWidths
function Add-TextView($name) {
    $v = New-Object System.Windows.Forms.TextBox
    $v.Multiline = $true; $v.ReadOnly = $true; $v.ScrollBars = 'Both'
    $v.WordWrap = $false; $v.Dock = 'Fill'
    $v.BorderStyle = 'FixedSingle'; $v.BackColor = [System.Drawing.Color]::Black; $v.ForeColor = [System.Drawing.Color]::White
    $script:pages[$name].Controls.Add($v); $script:views[$name] = $v
}
foreach ($name in @('Pricing','Logs')) { Add-TextView $name }
. (Join-Path $PSScriptRoot 'mita-desktop-workers.ps1')
. (Join-Path $PSScriptRoot 'mita-desktop-ports.ps1')
Initialize-PortTab $script:pages.Ports

# Overview is a real, scrollable layout; values remain unknown until an API response arrives.
$overviewPage = $script:pages.Overview
$overviewScroll = New-Object System.Windows.Forms.Panel
$overviewScroll.Dock = 'Fill'; $overviewScroll.AutoScroll = $true
$overviewPage.Controls.Add($overviewScroll)
$overviewPage.Controls.Add($sourceStatus); $sourceStatus.SendToBack()
$overviewBody = New-Object System.Windows.Forms.TableLayoutPanel
$overviewBody.ColumnCount = 1; $overviewBody.RowCount = 3
$overviewBody.Dock = 'Top'; $overviewBody.Padding = New-Object System.Windows.Forms.Padding(20, 12, 20, 16)
$overviewBody.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
foreach ($height in @(72, 110, 310)) { $overviewBody.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, $height))) | Out-Null }
$overviewScroll.Controls.Add($overviewBody)
$heading = New-Object System.Windows.Forms.Panel; $heading.Dock = 'Fill'
$headingTitle = New-Object System.Windows.Forms.Label
$headingTitle.Text = 'Tổng quan'; $headingTitle.Font = New-Object System.Drawing.Font('Segoe UI', 19, [System.Drawing.FontStyle]::Bold)
$headingTitle.Dock = 'Top'; $headingTitle.Height = 39
$headingSubtitle = New-Object System.Windows.Forms.Label
$headingSubtitle.Text = 'Bức tranh điều hành và hoạt động gần đây'; $headingSubtitle.Dock = 'Top'; $headingSubtitle.Height = 24
$headingSubtitle.ForeColor = [System.Drawing.Color]::Silver; $headingSubtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$heading.Controls.Add($headingSubtitle); $heading.Controls.Add($headingTitle)
$overviewBody.Controls.Add($heading, 0, 0)
$metrics = New-Object System.Windows.Forms.TableLayoutPanel
$metrics.Dock = 'Fill'; $metrics.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
$overviewBody.Controls.Add($metrics, 0, 1)
$script:metricValues = @{}
foreach ($entry in @(@('unread','THÔNG BÁO CHƯA XEM','Tổng từ nguồn khả dụng'), @('pending','CHỜ XÁC NHẬN','Trong 5 đơn gần nhất'), @('processing','ĐANG XỬ LÝ','Trong 5 đơn gần nhất'), @('value','GIÁ TRỊ TIỀN HÀNG','Trong 5 đơn gần nhất'))) {
    $tile = New-Object System.Windows.Forms.Panel
    $tile.Dock = 'Fill'; $tile.BorderStyle = 'FixedSingle'; $tile.Padding = New-Object System.Windows.Forms.Padding(12, 8, 8, 6)
    $caption = New-Object System.Windows.Forms.Label; $caption.Text = $entry[1]; $caption.Dock = 'Top'; $caption.Height = 19
    $caption.ForeColor = [System.Drawing.Color]::Silver; $caption.Font = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
    $number = New-Object System.Windows.Forms.Label; $number.Text = '—'; $number.Dock = 'Top'; $number.Height = 34
    $number.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
    $note = New-Object System.Windows.Forms.Label; $note.Text = $entry[2]; $note.Dock = 'Top'; $note.Height = 19
    $note.ForeColor = [System.Drawing.Color]::Gray; $note.Font = New-Object System.Drawing.Font('Segoe UI', 8)
    $tile.Controls.Add($note); $tile.Controls.Add($number); $tile.Controls.Add($caption)
    $tile.Tag = $entry[0]; $script:metricValues[$entry[0]] = $number
    $metrics.Controls.Add($tile)
}
$overviewPanels = New-Object System.Windows.Forms.TableLayoutPanel
$overviewPanels.Dock = 'Fill'; $overviewBody.Controls.Add($overviewPanels, 0, 2)
$recentPanel = New-Object System.Windows.Forms.Panel; $recentPanel.Dock = 'Fill'; $recentPanel.BorderStyle = 'FixedSingle'
$recentHeading = New-Object System.Windows.Forms.Label; $recentHeading.Text = 'HOẠT ĐỘNG ĐƠN GẦN ĐÂY'
$recentHeading.Dock = 'Top'; $recentHeading.Height = 42; $recentHeading.Padding = New-Object System.Windows.Forms.Padding(12, 12, 0, 0)
$recentHeading.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$recentGrid = New-Object System.Windows.Forms.DataGridView
$recentGrid.Dock = 'Fill'; $recentGrid.ReadOnly = $true; $recentGrid.AllowUserToAddRows = $false; $recentGrid.AllowUserToDeleteRows = $false
$recentGrid.RowHeadersVisible = $false; $recentGrid.MultiSelect = $false; $recentGrid.SelectionMode = 'FullRowSelect'
$recentGrid.AutoSizeColumnsMode = 'DisplayedCells'; $recentGrid.BackgroundColor = [System.Drawing.Color]::Black; $recentGrid.BorderStyle = 'None'
$recentGrid.GridColor = [System.Drawing.Color]::DimGray; $recentGrid.EnableHeadersVisualStyles = $false
$recentGrid.DefaultCellStyle.BackColor = [System.Drawing.Color]::Black; $recentGrid.DefaultCellStyle.ForeColor = [System.Drawing.Color]::White
$recentGrid.DefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::DimGray
$recentGrid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.Color]::Black; $recentGrid.ColumnHeadersDefaultCellStyle.ForeColor = [System.Drawing.Color]::White
$recentPanel.Controls.Add($recentGrid); $recentPanel.Controls.Add($recentHeading); $recentHeading.SendToBack()
$script:views.Overview = $recentGrid
$systemPanel = New-Object System.Windows.Forms.Panel; $systemPanel.Dock = 'Fill'; $systemPanel.BorderStyle = 'FixedSingle'; $systemPanel.Padding = New-Object System.Windows.Forms.Padding(12, 0, 12, 8)
$systemHeading = New-Object System.Windows.Forms.Label; $systemHeading.Text = 'TRẠNG THÁI HỆ THỐNG'; $systemHeading.Dock = 'Top'; $systemHeading.Height = 42
$systemHeading.Padding = New-Object System.Windows.Forms.Padding(0, 12, 0, 0); $systemHeading.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$systemDetails = New-Object System.Windows.Forms.TextBox; $systemDetails.Dock = 'Fill'; $systemDetails.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$systemDetails.Multiline=$true; $systemDetails.ReadOnly=$true; $systemDetails.WordWrap=$true; $systemDetails.ScrollBars='Vertical'
$systemDetails.BackColor=[System.Drawing.Color]::Black; $systemDetails.ForeColor=[System.Drawing.Color]::White
$systemDetails.BorderStyle='None'
$systemDetails.Text = 'Đăng nhập để xem trạng thái.'
$systemPanel.Controls.Add($systemDetails); $systemPanel.Controls.Add($systemHeading); $systemHeading.SendToBack()
$overviewPanels.Controls.Add($recentPanel); $overviewPanels.Controls.Add($systemPanel)
function Update-OverviewLayout {
    $narrow = $overviewScroll.ClientSize.Width -lt 1000
    $metrics.SuspendLayout(); $overviewPanels.SuspendLayout(); $overviewBody.SuspendLayout()
    $metrics.ColumnStyles.Clear(); $metrics.RowStyles.Clear()
    $metrics.ColumnCount = if ($narrow) { 2 } else { 4 }; $metrics.RowCount = if ($narrow) { 2 } else { 1 }
    for ($i=0; $i -lt $metrics.ColumnCount; $i++) { $metrics.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, (100 / $metrics.ColumnCount)))) | Out-Null }
    for ($i=0; $i -lt $metrics.RowCount; $i++) { $metrics.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, (100 / $metrics.RowCount)))) | Out-Null }
    for ($i=0; $i -lt 4; $i++) { $metrics.SetCellPosition($metrics.Controls[$i], (New-Object System.Windows.Forms.TableLayoutPanelCellPosition(($i % $metrics.ColumnCount), [int][Math]::Floor($i / $metrics.ColumnCount)))) }
    $overviewPanels.ColumnStyles.Clear(); $overviewPanels.RowStyles.Clear()
    $overviewPanels.ColumnCount = if ($narrow) { 1 } else { 2 }; $overviewPanels.RowCount = if ($narrow) { 2 } else { 1 }
    if ($narrow) {
        $overviewPanels.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
        foreach ($percent in @(55,45)) { $overviewPanels.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, $percent))) | Out-Null }
        $overviewPanels.SetCellPosition($recentPanel, (New-Object System.Windows.Forms.TableLayoutPanelCellPosition(0,0)))
        $overviewPanels.SetCellPosition($systemPanel, (New-Object System.Windows.Forms.TableLayoutPanelCellPosition(0,1)))
    } else {
        foreach ($percent in @(60,40)) { $overviewPanels.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, $percent))) | Out-Null }
        $overviewPanels.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
        $overviewPanels.SetCellPosition($recentPanel, (New-Object System.Windows.Forms.TableLayoutPanelCellPosition(0,0)))
        $overviewPanels.SetCellPosition($systemPanel, (New-Object System.Windows.Forms.TableLayoutPanelCellPosition(1,0)))
    }
    $overviewBody.RowStyles[1].Height = if ($narrow) { 210 } else { 110 }
    $overviewBody.RowStyles[2].Height = if ($narrow) { 500 } else { [Math]::Max(310, $overviewScroll.ClientSize.Height - 210) }
    $overviewBody.Height = [int](28 + $overviewBody.RowStyles[0].Height + $overviewBody.RowStyles[1].Height + $overviewBody.RowStyles[2].Height)
    $overviewBody.ResumeLayout(); $overviewPanels.ResumeLayout(); $metrics.ResumeLayout()
}
$overviewScroll.Add_Resize({ Update-OverviewLayout })
Update-OverviewLayout
foreach ($name in @('Notifications','Orders','Products')) {
    $grid = New-Object System.Windows.Forms.DataGridView
    $grid.Dock = 'Fill'; $grid.ReadOnly = $true; $grid.AllowUserToAddRows = $false
    $grid.AllowUserToDeleteRows = $false; $grid.MultiSelect = $false
    $grid.SelectionMode = 'FullRowSelect'; $grid.AutoSizeColumnsMode = 'DisplayedCells'
    $grid.BorderStyle = 'FixedSingle'; $grid.GridColor = [System.Drawing.Color]::DimGray; $grid.RowHeadersVisible = $false
    $grid.BackgroundColor = [System.Drawing.Color]::Black
    $grid.DefaultCellStyle.BackColor = [System.Drawing.Color]::Black
    $grid.DefaultCellStyle.ForeColor = [System.Drawing.Color]::White
    $grid.DefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::DimGray
    $grid.EnableHeadersVisualStyles = $false
    $grid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.Color]::Black
    $grid.ColumnHeadersDefaultCellStyle.ForeColor = [System.Drawing.Color]::White
    $script:pages[$name].Controls.Add($grid); $script:views[$name] = $grid
}
function Add-Toolbar($name) {
    $bar = New-Object System.Windows.Forms.FlowLayoutPanel
    $bar.Dock = 'Top'; $bar.Height = 76; $bar.Padding = New-Object System.Windows.Forms.Padding(5); $bar.WrapContents = $true
    $script:pages[$name].Controls.Add($bar); $bar.SendToBack()
    $title = New-Object System.Windows.Forms.Label
    $title.Text = $script:pageLabels[$name]; $title.Dock = 'Top'; $title.Height = 36
    $title.Padding = New-Object System.Windows.Forms.Padding(10, 7, 0, 0)
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
    $script:pages[$name].Controls.Add($title); $title.SendToBack()
    return $bar
}
$ordersBar = Add-Toolbar 'Orders'
$notificationsBar = Add-Toolbar 'Notifications'
$ackButton = Add-Button $notificationsBar 'Đánh dấu đã xem' {
    if (!(Can-Write)) { return }
    $row = $script:views.Notifications.CurrentRow
    if (!$row) { Set-Status 'Select a notification first.'; return }
    $noticeId = [string]$row.Cells['id'].Value
    if ($noticeId -notmatch '^(?:vps:)?[1-9][0-9]{0,18}$') {
        Set-Status 'Invalid notification ID.'; return
    }
    if (Confirm-Write "Mark order notification $noticeId as read?") {
        Start-Api 'POST' ('/notifications/' + [uri]::EscapeDataString($noticeId) + '/ack') @{} {
            param($value)
            Write-Completed
        }
    }
}
$orderAction = New-Object System.Windows.Forms.ComboBox
$orderAction.DropDownStyle = 'DropDownList'; $orderAction.Width = 230
$orderAction.Items.AddRange(@('Đã xác nhận','Đang mua','Đã mua','Đang giao','Hoàn thành','Đã hủy'))
$script:orderStates = @('confirmed','purchasing','purchased','shipping','completed','cancelled')
$orderAction.SelectedIndex = 0; $ordersBar.Controls.Add($orderAction)
$orderButton = Add-Button $ordersBar 'Đổi trạng thái đơn' {
    if (!(Can-Write)) { return }
    $row = $script:views.Orders.CurrentRow
    if (!$row) { Set-Status 'Select an order first.'; return }
    $script:writeId = [string]$row.Cells['id'].Value
    $script:writeState = $script:orderStates[$orderAction.SelectedIndex]
    Start-Api 'GET' ( '/orders/' + $script:writeId ) $null {
        param($current)
        $next = @{pending_confirmation=@('confirmed','cancelled'); confirmed=@('purchasing','cancelled'); purchasing=@('purchased','cancelled'); purchased=@('shipping'); shipping=@('completed')}
        if ($script:writeState -notin @($next[$current.status]) -or ($script:writeState -eq 'completed' -and $current.payment_status -ne 'paid')) {
            Set-Status 'Transition unavailable in current API state (or payment required). Refresh and choose again.'; return
        }
        if (Confirm-Write "Order $($current.id): $($current.status) -> $script:writeState") {
            Start-Api 'PATCH' ('/orders/' + $current.id) @{status=$script:writeState} { param($value) Write-Completed }
        }
    }
}
$productsBar = Add-Toolbar 'Products'
$productButton = Add-Button $productsBar 'Đổi hiển thị' {
    if (!(Can-Write)) { return }
    if ($productSource.SelectedIndex -ne 0) { Set-Status 'VPS chỉ cho phép xem; hãy chuyển về PC để chỉnh sửa.'; return }
    $row = $script:views.Products.CurrentRow
    if (!$row) { Set-Status 'Select a product first.'; return }
    $script:writeId = [string]$row.Cells['asin'].Value
    Start-Api 'GET' ('/products?limit=100&q=' + [uri]::EscapeDataString($script:writeId)) $null {
        param($value)
        $matches = @($value.items | Where-Object { $_.asin -eq $script:writeId })
        if ($matches.Count -ne 1) { Set-Status 'Product missing from authoritative response. Refresh.'; return }
        $hidden = !$matches[0].hiddenAt
        if (Confirm-Write "Product $script:writeId : hidden -> $hidden (currently hidden: $([bool]$matches[0].hiddenAt))") {
            Start-Api 'PATCH' ('/products/' + $script:writeId + '/visibility') @{hidden=[bool]$hidden} { param($value) Write-Completed }
        }
    }
}
# Explicit paging/search rather than silently presenting a truncated catalog.
$script:pageNumbers = @{Orders=1; Products=1}
$script:pageTotals = @{Orders=0; Products=0}
$script:searches = @{}
foreach ($name in @('Orders','Products')) {
    $bar = if ($name -eq 'Orders') { $ordersBar } else { $productsBar }
    $search = New-Object System.Windows.Forms.TextBox
    $search.Width = 180; $search.MaxLength = if ($name -eq 'Products') { 120 } else { 200 }; $bar.Controls.Add($search)
    $script:searches[$name] = $search
    $null = Add-Button $bar 'Tìm' { $n=$tabs.SelectedTab.Name; $script:pageNumbers[$n] = 1; if ($n -eq 'Products') { Load-DesktopProducts } else { Refresh-View } }
    $null = Add-Button $bar 'Trang trước' { $n=$tabs.SelectedTab.Name; if ($script:pageNumbers[$n] -gt 1) { $script:pageNumbers[$n]--; if ($n -eq 'Products') { Load-DesktopProducts } else { Refresh-View } } }
    $null = Add-Button $bar 'Trang sau' { $n=$tabs.SelectedTab.Name; if ($script:pageNumbers[$n] * 50 -lt $script:pageTotals[$n]) { $script:pageNumbers[$n]++; if ($n -eq 'Products') { Load-DesktopProducts } else { Refresh-View } } }
}
. (Join-Path $PSScriptRoot 'mita-desktop-diagnostics.ps1')
$pricingBar = Add-Toolbar 'Pricing'
foreach ($name in @('Logs')) {
    $title = New-Object System.Windows.Forms.Label
    $title.Text = $script:pageLabels[$name]; $title.Dock = 'Top'; $title.Height = 40
    $title.Padding = New-Object System.Windows.Forms.Padding(10, 8, 0, 0)
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
    $script:pages[$name].Controls.Add($title); $title.SendToBack()
}
$fx = New-Object System.Windows.Forms.NumericUpDown
$fx.DecimalPlaces = 4; $fx.Minimum = [decimal]0.0001; $fx.Maximum = 10000; $fx.Width = 140
$fee = New-Object System.Windows.Forms.NumericUpDown
$fee.DecimalPlaces = 2; $fee.Maximum = 100; $fee.Width = 100
foreach ($entry in @(@('VND/JPY',$fx),@('Phụ phí %',$fee))) {
    $label = New-Object System.Windows.Forms.Label; $label.Text=$entry[0]; $label.AutoSize=$true
    $pricingBar.Controls.Add($label); $pricingBar.Controls.Add($entry[1])
}
$priceButton = Add-Button $pricingBar 'Lưu cấu hình' {
    if (!(Can-Write)) { return }
    if (!$script:pricing) { Set-Status 'Refresh pricing first.'; return }
    $script:proposal = @{version=$script:pricing.version; fxJpyToVnd=[double]$fx.Value; serviceFeePercent=[double]$fee.Value}
    Start-Api 'GET' '/pricing' $null {
        param($current)
        if ($current.version -ne $script:proposal.version) { Set-Status 'Pricing changed elsewhere. Refresh and enter your changes again.'; return }
        $script:proposal.checkPriceExpiry = [bool]$current.checkPriceExpiry; $script:proposal.priceExpiryDays = [int]$current.priceExpiryDays
        if (Confirm-Write "Pricing v$($current.version): FX $($current.fxJpyToVnd) -> $($script:proposal.fxJpyToVnd); fee $($current.serviceFeePercent)% -> $($script:proposal.serviceFeePercent)%") {
            Start-Api 'PUT' '/pricing' $script:proposal { param($value) $script:pricingDirty=$false; Write-Completed }
        }
    }
}
$null = Add-Button $pricingBar 'Bỏ bản nháp' { $script:pricingDirty=$false; Refresh-View }

$fx.Add_ValueChanged({ if (!$script:loadingPricing) { $script:pricingDirty=$true } })
$fee.Add_ValueChanged({ if (!$script:loadingPricing) { $script:pricingDirty=$true } })
$intervalLabel = New-Object System.Windows.Forms.Label; $intervalLabel.Text='Kiểm tra (giây)'; $intervalLabel.AutoSize=$true; $notificationsBar.Controls.Add($intervalLabel)
$interval = New-Object System.Windows.Forms.NumericUpDown; $interval.Minimum=10; $interval.Maximum=300; $interval.Value=30; $interval.Width=65; $notificationsBar.Controls.Add($interval)
$interval.Add_ValueChanged({ $script:nextNotifications=[datetime]::Now.AddSeconds([double]$interval.Value) })
function Update-WriteControls {
    foreach ($control in @($ackButton,$orderButton,$productButton,$priceButton,$fx,$fee)) { $control.Enabled = ($script:role -eq 'owner') }
    $productButton.Enabled=($script:role -eq 'owner' -and $productSource.SelectedIndex -eq 0)
    Update-PortControlAvailability
    Update-BackendControlAvailability
    Update-TunnelControlAvailability
    Update-SyncControlAvailability
    Set-WorkerControls
}
function Set-AuthFeedback([string]$message,[string]$kind='idle') {
    $authStatus.Text=$message
    $authStatus.ForeColor=switch ($kind) {
        'success' { [System.Drawing.Color]::White }
        'error' { [System.Drawing.Color]::White }
        default { [System.Drawing.Color]::Silver }
    }
}
function Set-Status([string]$message) { $status.Text = $message }
function Clear-Session {
    $script:csrf=$null; $script:pricing=$null; $script:role=$null; $script:pricingDirty=$false; $script:unread=0; $script:relayStatus='unknown'
    $script:diagnosticSnapshotId=$null; $script:diagnosticSources=$null; $script:overviewBase=''; $script:overviewCompare=''
    $productComparisonStatus.Text='Chưa so sánh PC/VPS'
    $script:pages.Notifications.Text='Thông báo [0]'; $tabs.Invalidate(); Update-WriteControls
    $sourceStatus.Text='NGUỒN API: 127.0.0.1:4000  |  VPS: chưa xác định'
    $script:client.Dispose(); New-Client
    $password.Clear(); $password.Enabled=$true; $username.Enabled=$true; $login.Enabled=$true
    Set-AuthFeedback 'Chưa đăng nhập' 'idle'
    foreach ($name in @('Overview','Notifications','Orders','Products')) { $script:views[$name].DataSource=$null }
    foreach ($name in @('Pricing','Logs')) { $script:views[$name].Clear() }
    $script:workerApi=$null; $script:workerSnapshot=$null
    Show-WorkerPanel
    foreach ($key in @('unread','pending','processing','value')) { $script:metricValues[$key].Text='—' }
    $systemDetails.Text='Đăng nhập để xem trạng thái.'
}
function Can-Write {
    if ($script:pending) { return $false }
    if (!$script:csrf -or $script:role -ne 'owner') { Set-Status 'Chỉ chủ cửa hàng được thay đổi dữ liệu.'; return $false }
    return $true
}
function Confirm-Write([string]$message) {
    # A modal dialog pumps Windows messages; pause polling to prevent a nested refresh.
    $timer.Stop()
    try {
        return [System.Windows.Forms.MessageBox]::Show($form, "$message`r`n`r`nNguồn: $script:origin`r`nĐích: $script:origin/api/admin`r`nÁp dụng thay đổi?", 'Xác nhận của chủ cửa hàng', 'YesNo', 'Warning', 'Button2') -eq 'Yes'
    } finally { $timer.Start() }
}
function Start-Api($method, $path, $body, [scriptblock]$done) {
    if ($script:pending) { return }
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($method), ($script:origin + '/api/admin' + $path))
    $null = $request.Headers.TryAddWithoutValidation('Origin', $script:origin)
    if ($script:csrf) { $null = $request.Headers.TryAddWithoutValidation('X-CSRF-Token', $script:csrf) }
    if ($null -ne $body) { $request.Content = New-Object System.Net.Http.StringContent(($body | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8, 'application/json') }
    try {
        $script:pending = @{task=$script:client.SendAsync($request); request=$request; response=$null; phase='send'; done=$done; path=$path}
    } catch {
        $request.Dispose()
        if ($path -eq '/login') { Set-AuthFeedback 'Không kết nối được API local.' 'error'; $password.Focus() }
        Set-Status 'Could not start local API request. Check backend availability and refresh.'
        return
    }
    $top.Enabled=$false; $tabs.Enabled=$false
    Set-Status 'Contacting local authenticated Admin API...'
}
function Write-Completed {
    $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Owner write accepted by API; refreshing.`r`n")
    $script:nextNotifications=[datetime]::MinValue
    Refresh-View -ForceComparison
}
function Show-Table($name, $items, $columns) {
    $table = New-Object System.Data.DataTable
    foreach ($column in $columns) { $null = $table.Columns.Add($column) }
    foreach ($item in $items) {
        $row=$table.NewRow()
        foreach ($column in $columns) { $row[$column]=[string]$item.$column }
        $table.Rows.Add($row)
    }
    $script:views[$name].DataSource=$table
    $headers = @{id='Mã thông báo / đơn'; source='Nguồn'; orderId='Mã đơn theo nguồn'; eventType='Sự kiện'; createdAt='Thời gian'; orderStatus='Trạng thái đơn'; customerName='Khách hàng'; merchandiseVnd='Tiền hàng (VND)'; created_at='Thời gian'; customer_name='Khách hàng'; status='Trạng thái'; payment_status='Thanh toán'; merchandise_vnd='Tiền hàng (VND)'; item_count='Số mặt hàng'; asin='ASIN'; name='Sản phẩm'; reason='Khác biệt PC/VPS'; notice='Tên'; hiddenAt='Ẩn lúc'}
    foreach ($column in $columns) { if ($headers.ContainsKey($column)) { $script:views[$name].Columns[$column].HeaderText=$headers[$column] } }
}
function Format-OverviewTime($value) {
    if (!$value) { return 'Chưa có' }
    try { return ([datetimeoffset]$value).ToLocalTime().ToString('dd/MM/yyyy HH:mm') } catch { return 'Không rõ' }
}
function Show-Overview($value) {
    $relay = switch ([string]$value.relayStatus) {
        'connected' { 'VPS kết nối' } 'unavailable' { 'VPS không khả dụng; số từ VPS chưa tính' }
        'disabled' { 'VPS chưa cấu hình' } default { 'VPS chưa xác định' }
    }
    $sourceStatus.Text = "NGUỒN API: 127.0.0.1:4000  |  $relay"
    $unread = if ($null -ne $value.newOrderAlertCount) { [string]$value.newOrderAlertCount } else { '—' }
    if ($value.relayStatus -eq 'unavailable' -and $unread -ne '—') { $unread += '+' }
    $script:metricValues.unread.Text = $unread
    $recent = @($value.recentOrders | Where-Object { $null -ne $_ })
    if ($null -eq $value.recentOrders) {
        foreach ($key in @('pending','processing','value')) { $script:metricValues[$key].Text='—' }
    } else {
        $knownStates = @($recent | Where-Object { $null -eq $_.status -or [string]::IsNullOrWhiteSpace([string]$_.status) }).Count -eq 0
        $script:metricValues.pending.Text = if ($knownStates) { [string]@($recent | Where-Object { $_.status -eq 'pending_confirmation' }).Count } else { '—' }
        $script:metricValues.processing.Text = if ($knownStates) { [string]@($recent | Where-Object { $_.status -in @('confirmed','purchasing','purchased','shipping') }).Count } else { '—' }
        $total = [decimal]0; $valid = $true
        foreach ($order in $recent) {
            $amount = [decimal]0
            if ($null -eq $order.merchandise_vnd -or ![decimal]::TryParse([string]$order.merchandise_vnd, [ref]$amount)) { $valid=$false; break }
            $total += $amount
        }
        $script:metricValues.value.Text = if ($valid) { $total.ToString('N0') + ' VND' } else { '—' }
    }
    Show-Table 'Overview' $recent @('id','created_at','status','merchandise_vnd')
    $syncState = if ($value.latestSync -and $value.latestSync.state) { [string]$value.latestSync.state } else { 'Chưa có' }
    $syncTime = if ($value.latestSync) { Format-OverviewTime $value.latestSync.started_at } else { 'Chưa có' }
    $expected = Format-OverviewTime $value.expectedSyncAt
    $schedule = if ($null -eq $value.missingScheduledRun) { 'Chưa xác định' } elseif ($value.missingScheduledRun) { 'Chưa hoàn tất' } else { 'Đã hoàn tất' }
    $errors = if ($null -ne $value.syncErrors) { [string]@($value.syncErrors).Count + ' (tối đa 50)' } else { 'Chưa xác định' }
    $script:overviewBase = "Nguồn thông báo: $relay`r`nĐồng bộ gần nhất: $syncState | Bắt đầu: $syncTime`r`nLịch: $expected | $schedule`r`nLỗi đồng bộ gần nhất: $errors"
    $systemDetails.Text=$script:overviewBase + [string]$script:overviewCompare
}
function Load-BaseOverview {
    Start-Api 'GET' '/overview' $null {
        param($value)
        Show-Overview $value
        if ($script:diagnosticSnapshotId) { Load-DesktopOverview }
    }
}
function Refresh-View([switch]$ForceComparison) {
    if ($script:pending) { return }
    $script:nextRefresh=[datetime]::Now.AddSeconds(30)
    if ($tabs.SelectedTab.Name -eq 'Ports') { Refresh-PortTopology; return }
    if (!$script:csrf) { Set-Status 'Owner login required. API must already be running.'; return }
    $name=$tabs.SelectedTab.Name
    if ($name -in @('Products','Logs')) {
        if ($ForceComparison -or !$script:diagnosticSnapshotId) { Request-DesktopSnapshot }
        return
    }
    if ($name -eq 'Overview' -and ($ForceComparison -or !$script:diagnosticSnapshotId)) { Request-DesktopSnapshot; return }
    if ($name -eq 'Workers') {
        Refresh-Workers
        return
    }
    $path='/' + $name.ToLowerInvariant()
    if ($name -in @('Orders','Products')) { $path += '?limit=50&page=' + $script:pageNumbers[$name] + '&q=' + [uri]::EscapeDataString($script:searches[$name].Text) }
    if ($name -eq 'Notifications') { Refresh-Notifications; return }
    Start-Api 'GET' $path $null {
        param($value)
        $name=$tabs.SelectedTab.Name
        if ($name -in @('Orders','Products')) {
            $lastPage = [Math]::Max(1, [Math]::Ceiling([double]$value.total / 50))
            if ($script:pageNumbers[$name] -gt $lastPage) { $script:pageNumbers[$name]=[int]$lastPage; Refresh-View; return }
        }
        switch ($name) {
            'Orders' { $script:pageTotals[$name]=[int]$value.total; Show-Table $name $value.items @('id','created_at','customer_name','status','payment_status','merchandise_vnd','item_count') }
            'Products' { $script:pageTotals[$name]=[int]$value.total; Show-Table $name $value.items @('asin','name','hiddenAt') }
            'Overview' { Show-Overview $value }
            'Pricing' {
                if (!$script:pricingDirty) {
                    $script:pricing=$value
                    $script:views.Pricing.Text="CHÍNH SÁCH GIÁ HIỆN TẠI`r`n`r`nPhiên bản: $($value.version)`r`nTỷ giá: $($value.fxJpyToVnd) VND/JPY`r`nPhụ phí: $($value.serviceFeePercent)%`r`nKiểm tra giá quá hạn: $($value.checkPriceExpiry)`r`nSố ngày quá hạn: $($value.priceExpiryDays)`r`nGiá thử: $($value.exampleVnd) VND"
                    $script:loadingPricing=$true
                    try { $fx.Value=[decimal]$value.fxJpyToVnd; $fee.Value=[decimal]$value.serviceFeePercent } finally { $script:loadingPricing=$false }
                } else { Set-Status 'Bản nháp giá được giữ lại; lưu hoặc đăng xuất để bỏ bản nháp.' }
            }
        }
        if ($name -in @('Orders','Products')) { Set-Status "API: $($script:pageLabels[$name]) | Trang $($value.page) / $([Math]::Max(1,[Math]::Ceiling([double]$value.total / 50))) | Tổng $($value.total)." }
        elseif ($name -ne 'Notifications' -and !($name -eq 'Pricing' -and $script:pricingDirty)) { Set-Status "API current: $name at $([datetime]::Now.ToString('T')). Refresh every 30 seconds." }
    }
}
function Refresh-Notifications {
    if ($script:pending -or !$script:csrf -or !$script:role) { return }
    $script:nextNotifications = [datetime]::Now.AddSeconds([double]$interval.Value)
    Start-Api 'GET' '/notifications?limit=50&unread=1' $null {
        param($value)
        $script:unread = [int]$value.unreadCount; $script:relayStatus = [string]$value.relayStatus
        $suffix = if ($script:relayStatus -eq 'unavailable') { '+' } else { '' }
        $script:pages.Notifications.Text = "Thông báo [$($script:unread)$suffix]"; $tabs.Invalidate()
        Show-Table 'Notifications' $value.items @('id','source','orderId','eventType','createdAt','orderStatus','customerName','merchandiseVnd')
        $source = switch ($script:relayStatus) { 'connected' { 'VPS kết nối' } 'unavailable' { 'VPS không khả dụng; chưa tính số từ VPS' } 'disabled' { 'VPS chưa cấu hình' } default { 'Trạng thái VPS không rõ' } }
        $sourceStatus.Text = "NGUỒN API: 127.0.0.1:4000  |  $source"
        if ($tabs.SelectedTab.Name -eq 'Overview') { $script:metricValues.unread.Text = "$($script:unread)$suffix" }
        Set-Status "Thông báo chưa xem: $($script:unread) | $source | API: $script:origin"
    }
}
Update-WriteControls
$tabs.Add_SelectedIndexChanged({ Refresh-View -ForceComparison })
# Independent of the authenticated API timer and its pending request/early returns.
$portTimer=New-Object System.Windows.Forms.Timer
$portTimer.Interval=250
$portTimer.Add_Tick({
    Update-PortControlAction
    Update-BackendAction
    Update-TunnelAction
    Update-SyncAction
    Update-PortMonitor ($tabs.SelectedTab.Name -eq 'Ports')
    if ($tabs.SelectedTab.Name -eq 'Ports' -and $script:portTopology.Layout.SelectedIndex -eq 0 -and $script:portTopology.Motion.Checked) {
        $script:portTopology.MotionPhase=[single]($script:portTopology.MotionPhase+0.65)
        $script:portTopology.Graph.Invalidate()
    }
})
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=100
$timer.Add_Tick({
    if ($script:pending) {
        $p=$script:pending
        if (!$p.task.IsCompleted) { return }
        try {
            if ($p.phase -eq 'send') {
                $p.response=$p.task.GetAwaiter().GetResult()
                $p.task=$p.response.Content.ReadAsStringAsync(); $p.phase='read'
                return
            }
            $text=$p.task.GetAwaiter().GetResult()
            $code=[int]$p.response.StatusCode
            $script:pending=$null; $top.Enabled=$true; $tabs.Enabled=$true
            if (!$p.response.IsSuccessStatusCode) {
                if ($code -eq 401 -or ($script:csrf -and !$script:role)) { Clear-Session }
                if ($p.path -in @('/login','/session') -and (!$script:role)) {
                    $hint=switch ($code) {
                        401 { 'Không thể đăng nhập. Kiểm tra tài khoản và mật khẩu.' }
                        429 { 'Quá nhiều lần thử. Chờ 15 phút rồi thử lại.' }
                        403 { 'Yêu cầu xác thực bị từ chối.' }
                        default { "Xác thực thất bại (HTTP $code)." }
                    }
                    Set-AuthFeedback $hint 'error'; Set-Status $hint
                    if ($password.Enabled) { $password.Focus() }
                } else {
                    # Never echo server body, credentials or cookies to status/log.
                    Set-Status "Admin API HTTP $code. 400: invalid input; 401: login required; 403: session/origin rejected; 409: conflict, refresh; 429: wait 15 minutes; 5xx: backend error. No write retry."
                }
            } else {
                $value=$text | ConvertFrom-Json
                & $p.done $value
            }
        } catch {
            $script:pending=$null; $top.Enabled=$true; $tabs.Enabled=$true
            if ($script:csrf -and !$script:role) { Clear-Session }
            if ($p.path -in @('/login','/session') -and !$script:role) {
                Set-AuthFeedback 'Không kết nối được hoặc API phản hồi lỗi.' 'error'
                if ($password.Enabled) { $password.Focus() }
            }
            Set-Status 'API unavailable, timed out, or returned invalid data. Check the existing backend at 127.0.0.1:4000, then Refresh. Write outcome may be unknown; inspect current state before retrying.'
        } finally {
            if ($script:pending -ne $p) {
                if ($p.response) { $p.response.Dispose() }; $p.request.Dispose()
            }
        }
    } elseif ($script:csrf -and $script:role -and [datetime]::Now -ge $script:nextNotifications) { Refresh-Notifications }
    elseif ($script:csrf -and $script:role -and [datetime]::Now -ge $script:nextRefresh) { Refresh-View }
})
$form.Add_FormClosing({
    param($sender,$e)
    if ($script:portTopology.SyncJob) {
        $e.Cancel=$true
        Set-Status 'Đang xác minh yêu cầu Sync. Chờ kết quả tiếp nhận để không gửi trùng.'
        return
    }
    if ($script:portTopology.TunnelJob) {
        $e.Cancel=$true
        Set-Status 'Đang xác minh tunnel 15432; hoàn tất thao tác trước khi đóng Desktop.'
        return
    }
    if ($script:portTopology.TunnelSession) {
        $e.Cancel=$true
        $script:portTopology.TunnelClosing=$true
        Request-TunnelAction Stop -OnClose
        return
    }
    if ($script:portTopology.BackendJob) {
        $e.Cancel=$true
        Set-Status 'Đang xử lý backend 4000; hoàn tất thao tác trước khi đóng cửa sổ.'
        return
    }
    if ($script:portTopology.BackendSession) {
        $e.Cancel=$true
        $script:portTopology.BackendClosing=$true
        Request-BackendAction stop -OnClose
        return
    }
    if ($script:portTopology.ActionJob) {
        $e.Cancel=$true
        [void][System.Windows.Forms.MessageBox]::Show($form,'Tác vụ điều khiển PC chưa hoàn tất; kiểm tra trạng thái trước khi đóng.','Mita Japan','OK','Information')
    }
})
$form.Add_FormClosed({
    $portTimer.Stop(); $portTimer.Dispose(); Close-PortMonitor
    $timer.Stop(); $timer.Dispose()
    $script:client.CancelPendingRequests(); $script:client.Dispose()
    $password.Clear(); $script:csrf=$null
})
$timer.Start()
$portTimer.Start()
[System.Windows.Forms.Application]::Run($form)
