param([int]$Batch = 0, [int]$BatchSize = 12)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = 'https://mitajapanshop.duckdns.org'
$static = @(
  '/', '/san-pham', '/danh-muc/thuc-pham-bo-sung', '/danh-muc/thuc-pham-cho-be',
  '/danh-gia', '/cach-mua-hang', '/gio-hang', '/thanh-toan',
  '/san-pham?sort=reviews&page=2', '/danh-muc/thuc-pham-bo-sung?sort=reviews&page=2',
  '/danh-muc/thuc-pham-cho-be?sort=reviews&page=2'
)
$targets = New-Object System.Collections.Generic.List[object]
for ($i=0; $i -lt $static.Count; $i++) {
  $targets.Add([pscustomobject]@{category='shared';rank=0;asin='';url=($base+$static[$i]);slug=('shared_'+$i)})
}
foreach ($name in @('supplements','baby')) {
  foreach ($item in (Import-Csv -LiteralPath (Join-Path $root "top20_$name.csv") -Encoding UTF8)) {
    $targets.Add([pscustomobject]@{category=$name;rank=[int]$item.rank;asin=$item.asin;url=$item.url;slug=($name+'_'+$item.asin)})
  }
}
$start=$Batch*$BatchSize
$stop=[Math]::Min($targets.Count, $start+$BatchSize)
if($start -ge $targets.Count) { Write-Output "DONE total=$($targets.Count)"; exit 0 }
$htmlDir=Join-Path $root 'html'
New-Item -ItemType Directory -Path $htmlDir -Force | Out-Null
function Attr($tag,$name) {
  $match=[regex]::Match($tag, ('(?i)\b'+[regex]::Escape($name)+'\s*=\s*([\x22\x27])(?<value>.*?)\1'))
  if($match.Success){return [Net.WebUtility]::HtmlDecode($match.Groups['value'].Value)}
  return ''
}
function Meta($html,$key) {
  foreach($tag in [regex]::Matches($html,'(?is)<meta\b[^>]*>')){
    $name=Attr $tag.Value 'name'; $prop=Attr $tag.Value 'property'
    if($name -eq $key -or $prop -eq $key){return (Attr $tag.Value 'content')}
  }
  return ''
}
function Canonical($html){
  foreach($tag in [regex]::Matches($html,'(?is)<link\b[^>]*>')){
    if((Attr $tag.Value 'rel') -eq 'canonical'){return (Attr $tag.Value 'href')}
  }
  return ''
}
$out=New-Object System.Collections.Generic.List[object]
for($i=$start;$i -lt $stop;$i++){
  $x=$targets[$i];$watch=[Diagnostics.Stopwatch]::StartNew()
  $row=[ordered]@{index=$i;category=$x.category;rank=$x.rank;asin=$x.asin;url=$x.url;status='';ms=0;bytes=0;location='';title='';description='';h1='';canonical='';lang='';robots='';ogTitle='';ogImage='';jsonld=0;hrefs=0;images=0;error='';file=''}
  try{
    $r=Invoke-WebRequest -Uri $x.url -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0 -Headers @{'User-Agent'='MitaSEOReadOnlyAudit/1.0 (owner low-rate)'}
    $row.status=[int]$r.StatusCode
    $raw=[string]$r.Content
    $row.bytes=[Text.Encoding]::UTF8.GetByteCount($raw)
    $path=Join-Path $htmlDir ($x.slug+'.html')
    [IO.File]::WriteAllText($path,$raw,[Text.UTF8Encoding]::new($false))
    $row.file=$path
    $title=[regex]::Match($raw,'(?is)<title[^>]*>(.*?)</title>')
    if($title.Success){$row.title=[Net.WebUtility]::HtmlDecode($title.Groups[1].Value).Trim()}
    $h1=[regex]::Match($raw,'(?is)<h1\b[^>]*>(.*?)</h1>')
    if($h1.Success){$row.h1=[Net.WebUtility]::HtmlDecode(([regex]::Replace($h1.Groups[1].Value,'<[^>]+>',' '))).Trim()}
    $row.description=Meta $raw 'description'
    $row.robots=Meta $raw 'robots'
    $row.canonical=Canonical $raw
    $row.ogTitle=Meta $raw 'og:title'
    $row.ogImage=Meta $raw 'og:image'
    $lang=[regex]::Match($raw,'(?is)<html\b[^>]*>')
    if($lang.Success){$row.lang=Attr $lang.Value 'lang'}
    $row.jsonld=([regex]::Matches($raw,'(?i)type=[\x22\x27]application/ld\+json')).Count
    $row.hrefs=([regex]::Matches($raw,'(?i)<a\b[^>]*\bhref=')).Count
    $row.images=([regex]::Matches($raw,'(?i)<img\b')).Count
  }catch{
    $ex=$_.Exception
    if($ex.Response -and $ex.Response.StatusCode){
      $row.status=[int]$ex.Response.StatusCode
      $row.location=[string]$ex.Response.Headers['Location']
    }else{$row.status='ERROR'}
    $row.error=$ex.Message
  }
  $watch.Stop();$row.ms=$watch.ElapsedMilliseconds
  $out.Add([pscustomobject]$row)
  Write-Output ("{0}/{1} {2} {3} {4}ms {5}" -f ($i+1),$targets.Count,$row.status,$x.slug,$row.ms,$row.location)
  if($row.status -eq 'ERROR' -or $row.status -eq 429 -or $row.status -ge 500){break}
  Start-Sleep -Seconds 5
}
$file=Join-Path $root ("http-batch-{0}.csv" -f $Batch)
$out|Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath $file
Write-Output "SAVED $file count=$($out.Count)"
