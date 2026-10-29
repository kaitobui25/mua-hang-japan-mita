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
$script:csrf = $null
$script:pending = $null
$script:nextRefresh = [datetime]::Now

function New-Client {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $handler.CookieContainer = New-Object System.Net.CookieContainer
    $script:client = New-Object System.Net.Http.HttpClient($handler)
    $script:client.Timeout = [timespan]::FromSeconds(12)
}
New-Client

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Mita Japan - Owner desktop'
$form.Size = New-Object System.Drawing.Size(1150, 760)
$form.MinimumSize = New-Object System.Drawing.Size(900, 600)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::Black
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Consolas', 10)
$top = New-Object System.Windows.Forms.FlowLayoutPanel
$top.Dock = 'Top'; $top.Height = 44
$form.Controls.Add($top)
function Add-Button($parent, $text, $action) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.AutoSize = $true; $b.BackColor = [System.Drawing.Color]::Black
    $b.ForeColor = [System.Drawing.Color]::White
    $b.Add_Click($action); $parent.Controls.Add($b)
    return $b
}
$password = New-Object System.Windows.Forms.TextBox
$password.UseSystemPasswordChar = $true; $password.Width = 220; $password.MaxLength = 128
$top.Controls.Add($password)
$login = Add-Button $top 'Owner login' {
    if ($script:pending) { return }
    $body = @{password=$password.Text}; $password.Clear()
    Start-Api 'POST' '/login' $body {
        param($value)
        $script:csrf = $value.csrfToken
        $password.Enabled = $false; $login.Enabled = $false
        Refresh-View
    }
    $body.Clear()
}
$refresh = Add-Button $top 'Refresh' { Refresh-View }
$logout = Add-Button $top 'Logout' {
    if (!$script:pending -and $script:csrf) {
        Start-Api 'POST' '/logout' @{} { param($value) Clear-Session; Set-Status 'Logged out.' }
    }
}
$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'; $status.Height = 48
$status.Text = 'Enter owner password. API: http://127.0.0.1:4000. No workers are started.'
$form.Controls.Add($status)
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'; $form.Controls.Add($tabs); $tabs.BringToFront()
$script:pages = @{}; $script:views = @{}
foreach ($name in @('Overview','Orders','Products','Pricing','Workers','Logs')) {
    $page = New-Object System.Windows.Forms.TabPage
    $page.Text = $name; $page.BackColor = [System.Drawing.Color]::Black
    $page.ForeColor = [System.Drawing.Color]::White; $tabs.TabPages.Add($page)
    $script:pages[$name] = $page
}
function Add-TextView($name) {
    $v = New-Object System.Windows.Forms.TextBox
    $v.Multiline = $true; $v.ReadOnly = $true; $v.ScrollBars = 'Both'
    $v.WordWrap = $false; $v.Dock = 'Fill'
    $v.BackColor = [System.Drawing.Color]::Black; $v.ForeColor = [System.Drawing.Color]::White
    $script:pages[$name].Controls.Add($v); $script:views[$name] = $v
}
foreach ($name in @('Overview','Pricing','Workers','Logs')) { Add-TextView $name }
foreach ($name in @('Orders','Products')) {
    $grid = New-Object System.Windows.Forms.DataGridView
    $grid.Dock = 'Fill'; $grid.ReadOnly = $true; $grid.AllowUserToAddRows = $false
    $grid.AllowUserToDeleteRows = $false; $grid.MultiSelect = $false
    $grid.SelectionMode = 'FullRowSelect'; $grid.AutoSizeColumnsMode = 'DisplayedCells'
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
    $bar.Dock = 'Top'; $bar.Height = 70
    $script:pages[$name].Controls.Add($bar); $bar.BringToFront()
    return $bar
}
$ordersBar = Add-Toolbar 'Orders'
$orderAction = New-Object System.Windows.Forms.ComboBox
$orderAction.DropDownStyle = 'DropDownList'; $orderAction.Width = 230
$orderAction.Items.AddRange(@('confirmed','purchasing','purchased','shipping','completed','cancelled'))
$orderAction.SelectedIndex = 0; $ordersBar.Controls.Add($orderAction)
$null = Add-Button $ordersBar 'Change selected order state' {
    if (!(Can-Write)) { return }
    $row = $script:views.Orders.CurrentRow
    if (!$row) { Set-Status 'Select an order first.'; return }
    $script:writeId = [string]$row.Cells['id'].Value
    $script:writeState = [string]$orderAction.SelectedItem
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
$null = Add-Button $productsBar 'Toggle selected visibility' {
    if (!(Can-Write)) { return }
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
$script:searches = @{}
foreach ($name in @('Orders','Products')) {
    $bar = if ($name -eq 'Orders') { $ordersBar } else { $productsBar }
    $search = New-Object System.Windows.Forms.TextBox
    $search.Width = 180; $search.MaxLength = 200; $bar.Controls.Add($search)
    $script:searches[$name] = $search
    $null = Add-Button $bar 'Search' { $script:pageNumbers[$tabs.SelectedTab.Text] = 1; Refresh-View }
    $null = Add-Button $bar '< Page' { $n=$tabs.SelectedTab.Text; if ($script:pageNumbers[$n] -gt 1) { $script:pageNumbers[$n]--; Refresh-View } }
    $null = Add-Button $bar 'Page >' { $n=$tabs.SelectedTab.Text; if ($script:pageNumbers[$n] -lt 100000) { $script:pageNumbers[$n]++; Refresh-View } }
}
$pricingBar = Add-Toolbar 'Pricing'
$fx = New-Object System.Windows.Forms.NumericUpDown
$fx.DecimalPlaces = 4; $fx.Minimum = [decimal]0.0001; $fx.Maximum = 10000; $fx.Width = 140
$fee = New-Object System.Windows.Forms.NumericUpDown
$fee.DecimalPlaces = 2; $fee.Maximum = 100; $fee.Width = 100
foreach ($entry in @(@('JPY/VND',$fx),@('Fee %',$fee))) {
    $label = New-Object System.Windows.Forms.Label; $label.Text=$entry[0]; $label.AutoSize=$true
    $pricingBar.Controls.Add($label); $pricingBar.Controls.Add($entry[1])
}
$null = Add-Button $pricingBar 'Save pricing' {
    if (!(Can-Write)) { return }
    if (!$script:pricing) { Set-Status 'Refresh pricing first.'; return }
    $script:proposal = @{version=$script:pricing.version; fxJpyToVnd=[double]$fx.Value; serviceFeePercent=[double]$fee.Value}
    Start-Api 'GET' '/pricing' $null {
        param($current)
        if ($current.version -ne $script:proposal.version) { Set-Status 'Pricing changed elsewhere. Refresh and enter your changes again.'; return }
        if (Confirm-Write "Pricing v$($current.version): FX $($current.fxJpyToVnd) -> $($script:proposal.fxJpyToVnd); fee $($current.serviceFeePercent)% -> $($script:proposal.serviceFeePercent)%") {
            Start-Api 'PUT' '/pricing' $script:proposal { param($value) Write-Completed }
        }
    }
}

function Set-Status([string]$message) { $status.Text = $message }
function Clear-Session {
    $script:csrf=$null; $script:pricing=$null
    $script:client.Dispose(); New-Client
    $password.Clear(); $password.Enabled=$true; $login.Enabled=$true
    foreach ($name in @('Orders','Products')) { $script:views[$name].DataSource=$null }
    foreach ($name in @('Overview','Pricing','Workers','Logs')) { $script:views[$name].Clear() }
}
function Can-Write {
    if ($script:pending) { return $false }
    if (!$script:csrf) { Set-Status 'Owner login required.'; return $false }
    return $true
}
function Confirm-Write([string]$message) {
    # A modal dialog pumps Windows messages; pause polling to prevent a nested refresh.
    $timer.Stop()
    try {
        return [System.Windows.Forms.MessageBox]::Show($form, "$message`r`n`r`nRequest origin: $script:origin`r`nTarget: $script:origin/api/admin`r`nApply this change?", 'Confirm owner action', 'YesNo', 'Warning', 'Button2') -eq 'Yes'
    } finally { $timer.Start() }
}
function Start-Api($method, $path, $body, [scriptblock]$done) {
    if ($script:pending) { return }
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($method), ($script:origin + '/api/admin' + $path))
    $null = $request.Headers.TryAddWithoutValidation('Origin', $script:origin)
    if ($script:csrf) { $null = $request.Headers.TryAddWithoutValidation('X-CSRF-Token', $script:csrf) }
    if ($null -ne $body) { $request.Content = New-Object System.Net.Http.StringContent(($body | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8, 'application/json') }
    try {
        $script:pending = @{task=$script:client.SendAsync($request); request=$request; response=$null; phase='send'; done=$done}
    } catch {
        $request.Dispose()
        Set-Status 'Could not start local API request. Check backend availability and refresh.'
        return
    }
    $top.Enabled=$false; $tabs.Enabled=$false
    Set-Status 'Contacting local authenticated Admin API...'
}
function Write-Completed {
    $script:views.Logs.AppendText("$([datetime]::Now.ToString('s')) Owner write accepted by API; refreshing.`r`n")
    Refresh-View
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
}
function Refresh-View {
    if ($script:pending) { return }
    $script:nextRefresh=[datetime]::Now.AddSeconds(30)
    if (!$script:csrf) { Set-Status 'Owner login required. API must already be running.'; return }
    $name=$tabs.SelectedTab.Text
    if ($name -eq 'Workers') {
        try {
            $day=[datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd')
            $file=Join-Path $script:root ".agents/runtime/mita-daily-$day.json"
            $info=Get-Item -LiteralPath $file
            if ($info.Length -gt 1MB) { throw 'Status too large' }
            $value=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
            $lines=@("JST day: $day; file modified: $($info.LastWriteTime.ToString('s'))", 'Snapshot only; does not prove that any process is alive.', '')
            foreach ($job in $value.jobs.PSObject.Properties) { $lines += "$($job.Name): $($job.Value.state); updated $($job.Value.updatedAt)" }
            $lines += "Sync: $($value.sync.state)"
            $script:views.Workers.Text=$lines -join "`r`n"
            Set-Status 'Read local supervisor snapshot. No process controls.'
        } catch { $script:views.Workers.Text='No readable current-JST-day supervisor status. Workers may be offline or status unavailable.'; Set-Status 'Worker snapshot unavailable.' }
        return
    }
    if ($name -eq 'Logs') { Set-Status 'Session-only activity. Raw worker logs are intentionally not loaded (may contain secrets).'; return }
    $path='/' + $name.ToLowerInvariant()
    if ($name -in @('Orders','Products')) { $path += '?limit=50&page=' + $script:pageNumbers[$name] + '&q=' + [uri]::EscapeDataString($script:searches[$name].Text) }
    Start-Api 'GET' $path $null {
        param($value)
        $name=$tabs.SelectedTab.Text
        switch ($name) {
            'Orders' { Show-Table $name $value.items @('id','created_at','customer_name','status','payment_status','merchandise_vnd','item_count') }
            'Products' { Show-Table $name $value.items @('asin','name','hiddenAt') }
            'Overview' { $script:views.Overview.Text=$value | ConvertTo-Json -Depth 12 }
            'Pricing' {
                $script:pricing=$value
                $script:views.Pricing.Text=$value | ConvertTo-Json
                $fx.Value=[decimal]$value.fxJpyToVnd; $fee.Value=[decimal]$value.serviceFeePercent
            }
        }
        if ($name -in @('Orders','Products')) { Set-Status "API current: $name page $($value.page); $($value.total) total. Refresh every 30 seconds." }
        else { Set-Status "API current: $name at $([datetime]::Now.ToString('T')). Refresh every 30 seconds." }
    }
}
$tabs.Add_SelectedIndexChanged({ Refresh-View })
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
                if ($code -eq 401) { Clear-Session }
                # Do not echo arbitrary response bodies, request bodies, cookies or exceptions.
                Set-Status "Admin API HTTP $code. 400: invalid input; 401: login required; 403: session/origin rejected; 409: conflict, refresh; 429: wait 15 minutes; 5xx: backend error. No write retry."
            } else {
                $value=$text | ConvertFrom-Json
                & $p.done $value
            }
        } catch {
            $script:pending=$null; $top.Enabled=$true; $tabs.Enabled=$true
            Set-Status 'API unavailable, timed out, or returned invalid data. Check the existing backend at 127.0.0.1:4000, then Refresh. Write outcome may be unknown; inspect current state before retrying.'
        } finally {
            if ($script:pending -ne $p) {
                if ($p.response) { $p.response.Dispose() }; $p.request.Dispose()
            }
        }
    } elseif ($script:csrf -and [datetime]::Now -ge $script:nextRefresh) { Refresh-View }
})
$form.Add_FormClosed({
    $timer.Stop(); $timer.Dispose()
    $script:client.CancelPendingRequests(); $script:client.Dispose()
    $password.Clear(); $script:csrf=$null
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
