param([int]$Batch=0,[int]$Index=0)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$cat=if($Batch -eq 0){'supplements'}else{'baby'}
$items=@(Import-Csv -Encoding UTF8 -LiteralPath (Join-Path $root "top20_$cat.csv") | Where-Object { [int]$_.rank -in @(1,10,20) })
$items=@($items | Select-Object -Skip $Index -First 1)
if(!$items.Count){Write-Output 'DONE';exit 0}
$urlsJson=ConvertTo-Json -InputObject @($items | ForEach-Object {$_.url}) -Compress
$code=@'
const p=await browser.page(1);
const urls=__URLS__;
const output=[];
for (const source of urls) {
  try {
    await p.goto(source);
    await p.waitForTime(3000);
    const r=await p.cdp('Runtime.evaluate',JSON.stringify({expression:`(async()=>{
      const nav=performance.getEntriesByType('navigation')[0];
      let lcp=null,cls=0;
      try {const o=new PerformanceObserver(l=>{for(const e of l.getEntries()){lcp=e.startTime;}});o.observe({type:'largest-contentful-paint',buffered:true});await new Promise(r=>setTimeout(r,400));o.disconnect();}catch{}
      try {const o=new PerformanceObserver(l=>{for(const e of l.getEntries()){if(!e.hadRecentInput)cls+=e.value;}});o.observe({type:'layout-shift',buffered:true});await new Promise(r=>setTimeout(r,400));o.disconnect();}catch{}
      return {url:location.href,viewport:innerWidth,ttfbMs:Math.round(nav?.responseStart||0),domContentLoadedMs:Math.round(nav?.domContentLoadedEventEnd||0),loadEventMs:Math.round(nav?.loadEventEnd||0),transferBytes:nav?.transferSize||0,lcpBufferedMs:lcp===null?null:Math.round(lcp),clsBuffered:Math.round(cls*10000)/10000,resourceEntries:performance.getEntriesByType('resource').length};
    })()`,returnByValue:true,awaitPromise:true}));
    output.push({source,...r.result.value});
  }catch(e){output.push({source,error:String(e)});}
  await p.waitForTime(5000);
}
return output;
'@.Replace('__URLS__',$urlsJson)
$env:MCP_SESSION='a35c1407-5490-4f0f-963e-944bfa1e7602'
$c=Join-Path $env:APPDATA 'chat-on-steroids\skills\using-browseros-neo-mcp\mcp_call.ps1'
$json=@{code=$code}|ConvertTo-Json -Compress -Depth 6
$raw=(& $c -Tool run -Args $json) -join "`n"
$obj=$raw|ConvertFrom-Json
if($obj.isError -or !$obj.structuredContent.ok){throw $raw.Substring(0,[Math]::Min(1500,$raw.Length))}
$rows=@($obj.structuredContent.value)
$file=Join-Path $root ("browser-perf-{0}-{1}.csv" -f $cat,$items[0].rank)
$rows|Export-Csv -Encoding UTF8 -NoTypeInformation -LiteralPath $file
$rows|Format-Table -AutoSize|Out-String -Width 200
"SAVED $file"
