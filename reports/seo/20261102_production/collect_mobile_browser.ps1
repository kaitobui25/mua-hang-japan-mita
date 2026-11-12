param([int]$Batch=0,[int]$BatchSize=5)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$items=@(Import-Csv -LiteralPath (Join-Path $root 'top20_supplements.csv') -Encoding UTF8)+@(Import-Csv -LiteralPath (Join-Path $root 'top20_baby.csv') -Encoding UTF8)
$start=$Batch*$BatchSize
$take=@($items|Select-Object -Skip $start -First $BatchSize)
if(!$take.Count){Write-Output 'DONE';exit 0}
$urlsJson=ConvertTo-Json -InputObject @($take|ForEach-Object {$_.url}) -Compress
$code=@'
const p=await browser.page(1);
const urls=__URLS__;
const output=[];
for (const source of urls) {
  try {
    await p.goto(source);
    const r=await p.cdp('Runtime.evaluate',JSON.stringify({expression:`(() => {
      const main=document.querySelector('main')||document;
      const h1=main.querySelector('h1');
      const imgs=[...main.querySelectorAll('img')];
      const links=[...main.querySelectorAll('a[href]')];
      const clickable=[...main.querySelectorAll('button,a[href]')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
      const narrow=clickable.filter(el=>{const r=el.getBoundingClientRect();return r.width<40||r.height<36;});
      return {finalUrl:location.href,title:document.title,h1:h1?.textContent?.trim().slice(0,180)||'',
        w:innerWidth,scroll:document.documentElement.scrollWidth,bodyScroll:document.body.scrollWidth,
        h1Height:Math.round(h1?.getBoundingClientRect().height||0),
        imageCount:imgs.length,brokenImages:imgs.filter(img=>img.complete&&img.naturalWidth===0).length,
        linkCount:links.length,visibleTargets:clickable.length,smallTargets:narrow.length,
        canonical:document.querySelector('link[rel="canonical"]')?.href||'',
        lang:document.documentElement.lang};
    })()`,returnByValue:true}));
    output.push({source,...r.result.value});
  } catch(e) {output.push({source,error:String(e)});}
  await p.waitForTime(5000);
}
return output;
'@.Replace('__URLS__',$urlsJson)
$env:MCP_SESSION='a35c1407-5490-4f0f-963e-944bfa1e7602'
$call=Join-Path $env:APPDATA 'chat-on-steroids\skills\using-browseros-neo-mcp\mcp_call.ps1'
$argsJson=@{code=$code}|ConvertTo-Json -Compress -Depth 10
$raw=(& $call -Tool 'run' -Args $argsJson) -join "`n"
$result=$raw|ConvertFrom-Json
if($result.isError -or !$result.structuredContent.ok){throw ('BrowserOS run failed: '+$raw.Substring(0,[Math]::Min(1500,$raw.Length)))}
$rows=@($result.structuredContent.value)
if($rows.Count -ne $take.Count){throw "BrowserOS expected $($take.Count) results, got $($rows.Count)"}
$output=Join-Path $root ("mobile-batch-{0}.csv" -f $Batch)
$rows|Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath $output
$rows|ForEach-Object { Write-Output ("MOBILE {0} width={1} scroll={2} broken={3} smallTargets={4} error={5}" -f $_.source,$_.w,$_.scroll,$_.brokenImages,$_.smallTargets,$_.error) }
Write-Output "SAVED $output"
