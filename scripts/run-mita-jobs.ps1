[CmdletBinding()]
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
$runtime = Join-Path $root '.agents\runtime\manual-jobs'

function Select-Menu([string]$heading, [string[]]$entries) {
  while ($true) {
    Write-Host ''
    Write-Host $heading -ForegroundColor Cyan
    for ($i=0; $i -lt $entries.Length; $i++) { Write-Host ('  {0}. {1}' -f ($i+1),$entries[$i]) }
    Write-Host '  0. Thoat'
    $answer = (Read-Host 'Chon so').Trim()
    if ($answer -eq '0') { return 0 }
    if ($answer -match '^[1-9][0-9]*$' -and [int]$answer -le $entries.Length) { return [int]$answer }
    Write-Host 'Lua chon khong hop le.' -ForegroundColor Yellow
  }
}

function Read-Limit([int]$default) {
  while ($true) {
    $value = (Read-Host "So san pham toi da (1-300, Enter = $default)").Trim()
    if ($value -eq '') { return $default }
    if ($value -match '^[1-9][0-9]{0,2}$' -and [int]$value -le 300) { return [int]$value }
    Write-Host 'Nhap so nguyen tu 1 den 300.' -ForegroundColor Yellow
  }
}

function Read-Count($result, [string]$property) {
  if ($null -eq $result -or !($result.PSObject.Properties.Name -contains $property) -or $null -eq $result.$property) { return 'khong ro' }
  return [string]$result.$property
}

function Format-FullCategoryBreakdown($result) {
  if (!$result -or !($result.PSObject.Properties.Name -contains 'categoryBreakdown') -or
      !$result.categoryBreakdown) { return @('Chua co thong ke truoc/sau theo danh muc trong bao cao nay.') }
  $labels=[ordered]@{
    'thuc-pham-bo-sung'='THUC PHAM BO SUNG'
    'thuc-pham-cho-be'='THUC PHAM CHO BE'
  }
  $lines=@('========== THONG KE AMAZON FULL THEO DANH MUC ==========')
  foreach ($slug in $labels.Keys) {
    $counts=$result.categoryBreakdown.$slug
    $lines+=('--- '+$labels[$slug]+' ---')
    $lines+=('San pham moi them: '+(Read-Count $counts 'newProducts'))
    $lines+=('San pham cu duoc luu: '+(Read-Count $counts 'existingProducts'))
    $lines+=('  - Ten goc thay doi: '+(Read-Count $counts 'nameChanged'))
    $lines+=('  - Gia JPY thay doi: '+(Read-Count $counts 'priceChanged'))
    $lines+=('  - Bo anh thay doi: '+(Read-Count $counts 'imagesChanged'))
  }
  $lines+='Chi dem gia tri truoc/sau khac nhau tren PostgreSQL local; khong dem viec ghi lai gia tri cu.'
  return $lines
}

if ($SelfTest) {
  $fixture='{"categoryBreakdown":{"thuc-pham-bo-sung":{"newProducts":2,"existingProducts":3,"nameChanged":1,"priceChanged":2,"imagesChanged":1},"thuc-pham-cho-be":{"newProducts":0,"existingProducts":5,"nameChanged":0,"priceChanged":1,"imagesChanged":0}}}' | ConvertFrom-Json
  $formatted=@(Format-FullCategoryBreakdown $fixture)
  if (@($formatted | Where-Object {$_ -eq 'San pham moi them: 2'}).Count -ne 1 -or
      @($formatted | Where-Object {$_ -eq '  - Gia JPY thay doi: 1'}).Count -ne 1 -or
      @($formatted | Where-Object {$_ -eq '  - Ten goc thay doi: 0'}).Count -ne 1) {
    throw 'Amazon full category report self-test failed'
  }
  Write-Output 'PASS: manual Mita menu script loaded without contacting workers/DB.'
  return
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\MitaJapanManualWorkerLauncher')
$hasLock = $false
try {
  try { $hasLock = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $hasLock = $true }
  if (!$hasLock) { throw 'Mot cua so chay job thu cong khac dang hoat dong.' }
  if (!(Test-Path (Join-Path $backend 'node_modules\tsx'))) { throw 'Thieu backend dependencies (tsx). Khong chay job.' }
  $node = Get-Command node.exe -ErrorAction Stop
  $jobChoice = Select-Menu 'MITA JAPAN - CHAY JOB THU CONG' @(
    'Amazon - thu thap du lieu (job 04:00)',
    'Dich ten san pham (job 05:00)',
    'Dich chi tiet GGUF (job 05:15)'
  )
  if (!$jobChoice) { return }
  $job = @('amazon','names','detail')[$jobChoice-1]
  $mode = 'once'
  $limit = 20
  if ($job -eq 'amazon') {
    $modeChoice = Select-Menu 'AMAZON - CHON CHE DO QUET' @(
      'Chi cap nhat gallery anh lon (giu nguyen gia/ten/trang thai)',
      'Chi cap nhat gia JPY (giu nguyen anh/ten/trang thai)',
      'Kiem tra trang san pham Amazon con truy cap duoc (CHI DOC, khong xoa SP)',
      'FULL - nhu job 04:00: listing + anh + gia + trang thai + chi tiet'
    )
    if (!$modeChoice) { return }
    $mode = @('images','price','presence','full')[$modeChoice-1]
    $limit = if ($mode -eq 'full') { 0 } else { Read-Limit 20 }
  } else {
    $limit = Read-Limit $(if ($job -eq 'detail') { 30 } else { 20 })
  }
  Write-Host ''
  Write-Host ('Job={0}; mode={1}; limit={2}' -f $job,$mode,$(if($limit -eq 0){'full daily cap 200/category'}else{$limit})) -ForegroundColor Cyan
  Write-Host 'Chi ghi du lieu tren PostgreSQL LOCAL 127.0.0.1:5433; KHONG sync VPS.' -ForegroundColor Yellow
  Write-Host 'Nguon Amazon bi block/cooldown se dung; khong tu vuot CAPTCHA.' -ForegroundColor Yellow
  $consent = (Read-Host 'Nhap CHAY de bat dau (Enter de huy)').Trim()
  if ($consent -cne 'CHAY') { Write-Host 'Da huy. Khong chay job.'; return }

  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $id=[guid]::NewGuid().ToString('N')
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  $prefix=Join-Path $runtime ("${stamp}-${job}-${mode}-${id}")
  $stdout=$prefix+'.out.log'; $stderr=$prefix+'.err.log'; $report=$prefix+'.json'
  Write-Host ('Bat dau {0}/{1}. Ket qua se xuat khi process ket thuc.' -f $job,$mode)
  # -Wait supplies the final native exit code. Polling HasExited/Refresh alone
  # can leave ExitCode=$null on Windows PowerShell 5.1 even after completion.
  $process=Start-Process -FilePath $node.Source -WorkingDirectory $backend -NoNewWindow -Wait -PassThru `
    -ArgumentList @('--import','tsx','src/manual-jobs.ts',$job,$mode,[string]$limit) `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $exitCode=$process.ExitCode
  $matches=@(Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue | Where-Object { $_.StartsWith('MITA_WORKER_RESULT ') })
  $result=$null
  if ($matches.Count -eq 1) {
    try { $result=$matches[0].Substring('MITA_WORKER_RESULT '.Length) | ConvertFrom-Json -ErrorAction Stop }
    catch { $result=$null }
  }
  $summary=[ordered]@{ startedAt=$stamp;job=$job;mode=$mode;limit=$limit;exitCode=$exitCode;
    state=$(if($result){$result.state}else{'unresolved'});result=$result;stdoutLog=$stdout;stderrLog=$stderr }
  $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $report -Encoding UTF8
  Write-Host ''
  Write-Host '========== KET QUA JOB ==========' -ForegroundColor Cyan
  Write-Host ('Trang thai: {0}; exit code: {1}' -f $summary.state,$exitCode)
  if (!$result) {
    Write-Host 'Khong co MITA_WORKER_RESULT hop le. KHONG duoc coi la thanh cong.' -ForegroundColor Red
  } elseif ($job -eq 'amazon') {
    if ($mode -eq 'full') {
      Write-Host ('Da thu: {0}; luu thanh cong: {1}; that bai: {2}' -f `
        (Read-Count $result 'attempted'),(Read-Count $result 'succeeded'),(Read-Count $result 'failed'))
      Write-Host ('Tong san pham moi: {0}; tong san pham cu duoc luu: {1}' -f `
        (Read-Count $result 'newProducts'),(Read-Count $result 'updated'))
      Write-Host ('Loi nguon: '+(Read-Count $result 'sourceErrors'))
      Write-Host ''
      foreach ($line in @(Format-FullCategoryBreakdown $result)) { Write-Host $line }
    } else {
      Write-Host ('Da thu: {0}; thanh cong: {1}; that bai: {2}; hoan: {3}' -f `
        (Read-Count $result 'attempted'),(Read-Count $result 'succeeded'),(Read-Count $result 'failed'),(Read-Count $result 'deferred'))
      Write-Host ('Du lieu cap nhat: {0}; khong doi: {1}' -f `
        (Read-Count $result 'updated'),(Read-Count $result 'unchanged'))
    }
    if ($mode -eq 'presence') { Write-Host ('Trang xac nhan ton tai: {0}; het hang: {1}; ton kho khong ro: {2}' -f `
      (Read-Count $result 'present'),(Read-Count $result 'outOfStock'),(Read-Count $result 'unknownAvailability')) }
  } elseif ($job -eq 'names') {
    Write-Host ('Da chon: {0}; ten dich luu: {1}; that bai: {2}; bo qua: {3}' -f `
      (Read-Count $result 'selected'),(Read-Count $result 'translated'),(Read-Count $result 'failed'),(Read-Count $result 'skipped'))
    if ($result.reason) { Write-Host ('Ly do hoan: '+$result.reason) }
  } else {
    Write-Host ('Slot dich thanh cong: {0}; slot that bai: {1}; so ASIN co slot thanh cong: {2}; ASIN co slot loi: {3}' -f `
      (Read-Count $result 'translatedSlots'),(Read-Count $result 'failedSlots'),`
      (Read-Count $result 'productsWithTranslatedSlots'),(Read-Count $result 'productsWithFailedSlots'))
  }
  if ($result -and $result.failures) {
    $failures=@($result.failures)
    if ($failures.Count) {
      Write-Host ('Ly do that bai ({0} dong; hien toi da 25):' -f $failures.Count) -ForegroundColor Yellow
      foreach ($failure in @($failures | Select-Object -First 25)) {
        Write-Host (' - {0} [{1}] {2}' -f $(if($failure.asin){$failure.asin}else{'SOURCE'}),`
          $(if($failure.code){$failure.code}else{$failure.outcome}),$(if($failure.detail){$failure.detail}else{$failure.reason}))
      }
    }
  }
  Write-Host ('Bao cao: '+$report)
  Write-Host ('Log stdout: '+$stdout)
  if ($exitCode -ne 0 -or !$result) { Write-Host ('Log stderr: '+$stderr) -ForegroundColor Yellow }
  if ($exitCode -eq 0 -and $result -and $result.state -in @('completed','partial','success')) {
    Write-Host 'Job da ket thuc, doc bao cao de xem cac muc that bai/partial.' -ForegroundColor Green
  } else { Write-Host 'Job khong du dieu kien tuyen bo thanh cong. Kiem tra ly do/log.' -ForegroundColor Yellow }
} catch {
  Write-Host ('Khong chay duoc job: '+$_.Exception.Message) -ForegroundColor Red
} finally {
  if ($hasLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
