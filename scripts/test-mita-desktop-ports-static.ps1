# PS5.1 parser/static checks ONLY. Never dot-source the app or invoke probes.
$ErrorActionPreference='Stop'
function Assert-Static($condition,$message) { if (!$condition) { throw $message } }
$sources=@{}
foreach ($name in @('mita-desktop.ps1','mita-desktop-ports.ps1','mita-desktop-probes.ps1','mita-port-control.ps1')) {
    $path=Join-Path $PSScriptRoot $name
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    Assert-Static ($errors.Count -eq 0) "Parser errors: $name"
    $sources[$name]=[IO.File]::ReadAllText($path)
    $bytes=[IO.File]::ReadAllBytes($path)
    Assert-Static ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) "PS5.1 UTF-8 BOM required: $name"
    if ($name -eq 'mita-desktop-probes.ps1') {
        foreach ($statement in $ast.EndBlock.Statements) {
            Assert-Static ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) 'Probe file must only define functions on load'
        }
        $commands=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst]},$true)
        foreach ($command in $commands) {
            Assert-Static ($command.GetCommandName() -notmatch '^(Start-Process|Stop-Process|Start-Service|Stop-Service|Restart-Service|Invoke-Expression|Set-Content|Add-Content|Out-File)$') 'Unexpected mutating command in probes'
        }
    }
}
$ui=$sources['mita-desktop-ports.ps1']; $probe=$sources['mita-desktop-probes.ps1']; $app=$sources['mita-desktop.ps1']
foreach ($state in @('unknown','online','idle','offline','warning')) {
    Assert-Static ($ui.Contains("'$state'")) "Missing UI state $state"
}
foreach ($required in @('BatchMode=yes','StrictHostKeyChecking=yes','IdentitiesOnly=yes','-F NUL','ConnectTimeout=4','6000','ss -ltnH','pg_isready','Mita supervisor active','/api/health','/admin/login','ProbeSource','LastProbed')) {
    Assert-Static ($probe.Contains($required)) "Missing probe contract $required"
}
Assert-Static ($probe.Contains('$health.ok -is [bool] -and $health.ok -eq $true')) 'API must validate JSON ok:true'
Assert-Static ($ui.Contains('$t.Interval.Value=15')) 'Default interval must be 15 seconds'
Assert-Static ($ui.Contains('$t.Job -or')) 'Missing overlap guard'
Assert-Static ($ui.Contains('.BeginInvoke()') -and $ui.Contains('.BeginStop(')) 'Worker must start/stop asynchronously'
Assert-Static (!$ui.Contains('PowerShell.Stop()') -and !$ui.Contains('WaitForExit') -and !$ui.Contains('Get-NetTCPConnection')) 'UI must not perform blocking probe I/O'
Assert-Static ($app.Contains('$portTimer.Add_Tick({') -and $app.Contains('Update-PortMonitor ($tabs.SelectedTab.Name')) 'Monitoring must use independent timer'
Assert-Static ($app.Contains('$portTimer.Dispose(); Close-PortMonitor')) 'Monitoring shutdown missing'
Assert-Static ($ui.Contains("Start-Api 'GET' '/session'") -and $ui.Contains("session.role -ne 'owner'")) 'Missing fresh owner authorization before PC control'
Assert-Static ($ui.IndexOf('Start-Api ''GET'' ''/session''') -gt $ui.IndexOf('MessageBox]::Show($form,$message')) 'Owner verification must occur after confirmation'
Assert-Static ($ui.Contains('Update-PortControlAction') -and $app.Contains('Update-PortControlAction')) 'Control work must be handled asynchronously'
$control=$sources['mita-port-control.ps1']
Assert-Static ($control.Contains("ValidateSet('gateway','supervisor')") -and $control.Contains("ValidateSet('start','stop')")) 'Local control must be allowlisted'
Assert-Static ($control.Contains('Get-OwnedNode') -and $control.Contains('StartTime') -and $control.Contains('CommandLine')) 'Missing ownership checks'
Assert-Static ($control.Contains('mita-port-control-audit.jsonl') -and $control.Contains('Set-Content -LiteralPath $stopPath')) 'Missing audit or cooperative stop'
Assert-Static (!$control.Contains('Stop-Process') -and $control.Contains('worker|translator|detail-translator')) 'No kill rollback or gateway shutdown with active workers'
Assert-Static (!$control.Contains('Stop-Service') -and !$control.Contains('Invoke-Expression') -and !$control.Contains('Start-Job')) 'Forbidden generic control surface'
Write-Output "PASS: PS $($PSVersionTable.PSVersion) parser/static monitoring contracts; no app or probes executed."
