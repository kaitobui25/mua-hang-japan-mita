# Desktop-only presentation. API captures a single read-only PC/VPS snapshot per refresh.
$script:diagnosticSnapshotId=$null
$script:diagnosticSources=$null
$script:diagnosticStatus='Chưa kiểm tra'

$productsBar.Height=105
$productSource=New-Object System.Windows.Forms.ComboBox
$productSource.DropDownStyle='DropDownList'; $productSource.Width=110
$productSource.Items.AddRange([object[]]@('PC','VPS'))
$productSource.SelectedIndex=0
$productSource.AccessibleName='Nguồn dữ liệu sản phẩm: PC hoặc VPS'
$productsBar.Controls.Add($productSource)
$script:sourceProductNames=@{}
$null=Add-Button $productsBar 'Tên gốc' {
    $row=$script:views.Products.CurrentRow
    if (!$row) { Set-Status 'Chọn một sản phẩm để xem tên Amazon.'; return }
    $asin=[string]$row.Cells['asin'].Value
    $sourceName=[string]$script:sourceProductNames[$asin]
    if (!$sourceName) { Set-Status 'Nguồn được chọn không có sản phẩm này.'; return }
    [void][System.Windows.Forms.MessageBox]::Show($form,$sourceName,"Tên gốc Amazon | $asin",'OK','Information')
}
$differentOnly=New-Object System.Windows.Forms.CheckBox
$differentOnly.Text='Chỉ khác biệt'; $differentOnly.AutoSize=$true
$differentOnly.ForeColor=[System.Drawing.Color]::White
$productsBar.Controls.Add($differentOnly)
$productComparisonStatus=New-Object System.Windows.Forms.Label
$productComparisonStatus.AutoSize=$true; $productComparisonStatus.MaximumSize=New-Object System.Drawing.Size(490,44)
$productComparisonStatus.Text='Chưa so sánh PC/VPS'; $productComparisonStatus.ForeColor=[System.Drawing.Color]::Silver
$productsBar.Controls.Add($productComparisonStatus)

$logsBar=New-Object System.Windows.Forms.FlowLayoutPanel
$logsBar.Dock='Top'; $logsBar.Height=50
$logsBar.Padding=New-Object System.Windows.Forms.Padding(8,7,8,0)
$script:pages.Logs.Controls.Add($logsBar); $logsBar.SendToBack()
$logsSource=New-Object System.Windows.Forms.ComboBox
$logsSource.DropDownStyle='DropDownList'; $logsSource.Width=100
$logsSource.Items.AddRange([object[]]@('PC + VPS','PC','VPS')); $logsSource.SelectedIndex=0
$logsSource.AccessibleName='Nguồn nhật ký'; $logsBar.Controls.Add($logsSource)
$logsSeverity=New-Object System.Windows.Forms.ComboBox
$logsSeverity.DropDownStyle='DropDownList'; $logsSeverity.Width=120
$logsSeverity.Items.AddRange([object[]]@('Mọi mức độ','Thông tin','Cảnh báo','Lỗi'))
$logsSeverity.SelectedIndex=0; $logsBar.Controls.Add($logsSeverity)
$logsHours=New-Object System.Windows.Forms.ComboBox
$logsHours.DropDownStyle='DropDownList'; $logsHours.Width=125
$logsHours.Items.AddRange([object[]]@('24 giờ gần nhất','7 ngày gần nhất'))
$logsHours.SelectedIndex=0; $logsBar.Controls.Add($logsHours)
$null=Add-Button $logsBar 'Lọc nhật ký' { Load-DesktopLogs }

function Get-DifferenceCaption($entry) {
    $reasons=@()
    foreach ($kind in @($entry.differences)) {
        switch ($kind) {
            'presence' { $reasons+= if (!$entry.pc) { 'Chỉ có trên VPS' } else { 'Chỉ có trên PC' } }
            'fullVietnameseName' { $reasons+='Khác tên Việt' }
            'shortVietnameseName' { $reasons+='Khác tên ngắn' }
            'originalName' { $reasons+='Khác tên gốc' }
            'images' { $reasons+='Khác ảnh' }
        }
    }
    return ($reasons -join ', ')
}

function Request-DesktopSnapshot {
    $script:diagnosticSnapshotId=$null
    $script:diagnosticSources=$null
    $script:pageNumbers.Products=1
    $script:diagnosticStatus='Đang kiểm tra PC/VPS...'
    $script:overviewCompare="`r`n`r`nĐối chiếu PC/VPS: Đang kiểm tra; chưa có kết quả mới."
    if ($systemDetails) { $systemDetails.Text=[string]$script:overviewBase + $script:overviewCompare }
    $productComparisonStatus.Text=$script:diagnosticStatus
    if ($tabs.SelectedTab.Name -eq 'Products') { $script:views.Products.DataSource=$null }
    if ($tabs.SelectedTab.Name -eq 'Logs') { $script:views.Logs.Clear() }
    Start-Api 'GET' '/desktop/snapshot' $null {
        param($value)
        $script:diagnosticSnapshotId=[string]$value.snapshotId
        $script:diagnosticSources=$value.sources
        $script:diagnosticStatus=if ($value.comparisonStatus -eq 'available') { 'Đã so sánh PC/VPS' } else { 'VPS hoặc PC không khả dụng; chưa thể so sánh' }
        switch ($tabs.SelectedTab.Name) {
            'Products' { Load-DesktopProducts }
            'Overview' { Load-BaseOverview }
            'Logs' { Load-DesktopLogs }
        }
    }
}

function Load-DesktopProducts {
    if (!$script:diagnosticSnapshotId) { return }
    $source=if ($productSource.SelectedIndex -eq 1) { 'vps' } else { 'pc' }
    $state=$script:diagnosticSources.$source
    if ($state.status -ne 'available') {
        $script:sourceProductNames=@{}
        $script:views.Products.DataSource=$null; $script:pageTotals.Products=0
        $productComparisonStatus.Text="$($source.ToUpperInvariant()): không khả dụng. Không hiển thị dữ liệu cũ."
        Set-Status 'Nguồn đang chọn không khả dụng; chưa thể kết luận có sản phẩm thiếu.'
        return
    }
    # The comparison endpoint pages the union; never infer missing VPS as zero when offline.
    $id=[uri]::EscapeDataString($script:diagnosticSnapshotId)
    $q=[uri]::EscapeDataString($script:searches.Products.Text.Trim())
    $diff=if ($differentOnly.Checked) { '1' } else { '0' }
    $path="/desktop/products?snapshotId=$id&page=$($script:pageNumbers.Products)&pageSize=50&onlyDifferent=$diff&q=$q"
    Start-Api 'GET' $path $null {
        param($value)
        $selected=if ($productSource.SelectedIndex -eq 1) { 'vps' } else { 'pc' }
        $script:sourceProductNames=@{}
        $items=@(foreach ($entry in $value.items) {
            $product=$entry.$selected
            if ($product) { $script:sourceProductNames[[string]$entry.asin]=[string]$product.originalName }
            $name=if ($product) { [string]$product.displayName } else { '—' }
            $nameNotice=if ($product) { [string]$product.nameNotice } else { '' }
            [pscustomobject]@{asin=[string]$entry.asin; name=$name; reason=(Get-DifferenceCaption $entry);
                notice=$nameNotice; hiddenAt=if ($product) { [string]$product.hiddenAt } else { '' } }
        })
        $script:pageTotals.Products=[int]$value.total
        Show-Table 'Products' $items @('asin','name','reason','notice','hiddenAt')
        $table=$script:views.Products
        foreach ($row in $table.Rows) {
            if ([string]$row.Cells['reason'].Value) {
                $row.DefaultCellStyle.BackColor=[System.Drawing.Color]::FromArgb(52,48,34)
                $row.DefaultCellStyle.ForeColor=[System.Drawing.Color]::White
            }
        }
        $stamp=if ($script:diagnosticSources.vps.capturedAt) { Format-OverviewTime $script:diagnosticSources.vps.capturedAt } else { 'chưa xác định' }
        if ($value.comparisonStatus -eq 'available') {
            $productComparisonStatus.Text="PC/VPS đã so sánh. VPS: $stamp. Dòng khác nhau được đánh dấu."
        } else {
            $productComparisonStatus.Text='Chỉ xem nguồn còn kết nối. Chưa thể so sánh PC/VPS.'
        }
        Set-Status "Sản phẩm $($productSource.Text): trang $($value.page), tổng $($value.total). Chỉ PC được chỉnh sửa."
    }
}

function Load-DesktopOverview {
    if (!$script:diagnosticSnapshotId) { return }
    $path='/desktop/overview?snapshotId='+[uri]::EscapeDataString($script:diagnosticSnapshotId)
    Start-Api 'GET' $path $null {
        param($value)
        $c=$value.comparison
        if (!$c) {
            $script:overviewCompare="`r`n`r`nSo sánh PC/VPS: Chưa xác định (một nguồn không khả dụng)."
        } else {
            $fields=@(@('presence','Thiếu ASIN'),@('originalName','Tên gốc'),@('fullVietnameseName','Tên Việt'),
                @('shortVietnameseName','Tên ngắn'),@('images','Ảnh'))
            $diff=@($fields | ForEach-Object { "$($_[1]): $($c.productDifferences.($_[0]))" }) -join ' | '
            $onlyPc=@($c.tableDifferences | Where-Object { $_.pc -and !$_.vps }).Count
            $onlyVps=@($c.tableDifferences | Where-Object { $_.vps -and !$_.pc }).Count
            $pcTables=@($c.tableDifferences | Where-Object { $_.pc -and !$_.vps } | ForEach-Object { $_.name })
            $vpsTables=@($c.tableDifferences | Where-Object { $_.vps -and !$_.pc } | ForEach-Object { $_.name })
            $changedTables=@($c.tableDifferences | Where-Object { $_.pc -and $_.vps } | ForEach-Object { $_.name })
            $script:overviewCompare="`r`n`r`nĐỐI CHIẾU PC / VPS ($([datetime]::Now.ToString('HH:mm')))`r`n" +
                "Bảng: $($c.pc.tableCount) / $($c.vps.tableCount) | Cột: $($c.pc.columnCount) / $($c.vps.columnCount)`r`n" +
                "Index: $($c.pc.indexCount) / $($c.vps.indexCount)`r`n" +
                "Sản phẩm: $($c.pc.catalog.products) / $($c.vps.catalog.products)`r`n" +
                "Bản dịch: $($c.pc.catalog.translations) / $($c.vps.catalog.translations) | Ảnh: $($c.pc.catalog.images) / $($c.vps.catalog.images)`r`n" +
                "Bảng chỉ ở PC: $onlyPc | chỉ ở VPS: $onlyVps (chưa chắc là lỗi)`r`n" +
                "Riêng PC: $($pcTables -join ', ')`r`n" +
                "Riêng VPS: $($vpsTables -join ', ')`r`n" +
                "Khác cấu trúc chung: $($changedTables -join ', ')`r`n" +
                "Sản phẩm khác: $diff`r`n" +
                "PC: $(Format-OverviewTime $c.pc.capturedAt) | VPS: $(Format-OverviewTime $c.vps.capturedAt)"
        }
        if ($script:overviewBase) { $systemDetails.Text=$script:overviewBase + $script:overviewCompare }
    }
}

function Load-DesktopLogs {
    if (!$script:diagnosticSnapshotId) { return }
    $hours=if ($logsHours.SelectedIndex -eq 1) { 168 } else { 24 }
    $source=if ($logsSource.SelectedIndex -eq 1) { '&source=pc' } elseif ($logsSource.SelectedIndex -eq 2) { '&source=vps' } else { '' }
    $severity=switch ($logsSeverity.SelectedIndex) { 1 { '&severity=info' } 2 { '&severity=warning' } 3 { '&severity=error' } default { '' } }
    $path="/desktop/logs?snapshotId=$([uri]::EscapeDataString($script:diagnosticSnapshotId))&hours=$hours&limit=500$source$severity"
    Start-Api 'GET' $path $null {
        param($value)
        $lines=@("Nhật ký đã lọc — $($value.hours) giờ gần nhất (mới nhất trước)", 'Chỉ hiển thị sự kiện an toàn; không chứa raw log hoặc dữ liệu khách hàng.', '')
        foreach ($source in @($value.sources)) {
            if ($source.status -ne 'available') { $lines+="Nguồn $($source.source): $($source.status) — không thể khẳng định không có sự kiện." }
            if ($source.source -eq 'pc') {
                if ($source.runtimeLogStatus -ne 'available') { $lines+='PC: nhật ký tiến trình chưa đọc được; kết quả có thể thiếu.' }
                foreach ($stream in @($source.runtimeStreams)) {
                    if ($stream.status -in @('missing','unreadable')) {
                        $lines+="PC / $($stream.id): $($stream.status) — không có dữ liệu xác minh."
                    }
                }
            }
            foreach ($stream in @($source.streams)) {
                if ($stream.status -eq 'missing') { $lines+="$($source.source.ToUpperInvariant()) / $($stream.id): chưa có nguồn sự kiện." }
            }
        }
        foreach ($event in @($value.items)) {
            $time=Format-OverviewTime $event.timestamp
            $lines+="[$time] [$($event.source.ToUpperInvariant())] [$($event.severity)] $($event.title)"
        }
        if (!@($value.items).Count) { $lines+='Không có sự kiện trong phần dữ liệu đọc được.' }
        if ($value.truncated) { $lines+='Kết quả được giới hạn; hãy thu hẹp bộ lọc.' }
        $script:views.Logs.Text=$lines -join "`r`n"
        Set-Status 'Đã tải nhật ký an toàn. Thời gian và nguồn được ghi rõ; thiếu nguồn không đồng nghĩa không có sự kiện.'
    }
}

$productSource.Add_SelectedIndexChanged({
    $script:pageNumbers.Products=1
    $productButton.Enabled=($script:role -eq 'owner' -and $productSource.SelectedIndex -eq 0)
    Load-DesktopProducts
})
$differentOnly.Add_CheckedChanged({ $script:pageNumbers.Products=1; Load-DesktopProducts })
$script:views.Products.Add_SelectionChanged({
    if ($tabs.SelectedTab.Name -ne 'Products' -or !$script:views.Products.CurrentRow) { return }
    $current=$script:views.Products.CurrentRow
    $reason=[string]$current.Cells['reason'].Value
    $asin=[string]$current.Cells['asin'].Value
    if ($asin) {
        $label=if ($reason) { "$asin — $reason" } elseif ($script:diagnosticSources.pc.status -eq 'available' -and
            $script:diagnosticSources.vps.status -eq 'available') { "$asin — Không có khác biệt" }
            else { "$asin — Chưa thể xác định khác biệt" }
        Set-Status $label
    }
})
