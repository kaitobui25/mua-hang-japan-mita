# Starts only the local llama.cpp Vulkan server and independent 05:15 JST detail worker.
# Model/runtime live OUTSIDE Git, under C:\phong\AI\web\mita-japan.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
$runtime = Join-Path $root '.agents/runtime'
$assets = (Resolve-Path (Join-Path $root '..')).Path
$binary = Join-Path $assets 'tools/llama.cpp-vulkan/llama-server.exe'
$model = Join-Path $assets 'models/Index-Translate-2B.Q4_K_M.gguf'

if (!(Test-Path -LiteralPath $binary) -or !(Test-Path -LiteralPath $model)) {
  Write-Warning 'Local detail translator unavailable: llama.cpp Vulkan or GGUF model not installed.'
  return
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Save-LocalPid([string]$name, $process) {
  @{ Id = $process.Id; StartedAt = $process.StartTime.ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime "$name.pid.json") -Encoding UTF8
}

$server = Get-CimInstance Win32_Process -Filter "name='llama-server.exe'" |
  Where-Object { $_.CommandLine -match [regex]::Escape($model) } | Select-Object -First 1
if ($server) {
  Write-Host "Local llama.cpp Vulkan already running PID=$($server.ProcessId)"
} else {
  $occupied = Test-NetConnection -ComputerName 127.0.0.1 -Port 8080 -InformationLevel Quiet -WarningAction SilentlyContinue
  if ($occupied) { throw 'Port 8080 occupied by another process; refusing to replace or connect to it.' }
  # Index-Translate-2B supports non-thinking generation; limit thinking to zero.
  $env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = '{"enable_thinking":false}'
  $args = @('-m', $model, '-a', 'Index-Translate-2B', '--host', '127.0.0.1', '--port', '8080',
    '-c', '4096', '-t', '12', '-ngl', '99', '--temp', '0', '--reasoning-budget', '0', '--jinja', '-np', '1')
  $process = Start-Process -FilePath $binary -ArgumentList $args -WorkingDirectory (Split-Path $binary) -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'llama.out.log') `
    -RedirectStandardError (Join-Path $runtime 'llama.err.log') -PassThru
  Save-LocalPid 'llama' $process
  Write-Host "Local llama.cpp Vulkan started PID=$($process.Id)"
}

# The worker registers pg-boss cron 15 5 * * *; startup never triggers inference.
$worker = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]detail-translator\.ts daily' } | Select-Object -First 1
if ($worker) {
  Write-Host "Daily detail translator already running PID=$($worker.ProcessId)"
} else {
  $env:LLAMA_BASE_URL = 'http://127.0.0.1:8080/v1'
  $env:LLAMA_MODEL = 'Index-Translate-2B'
  $process = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'worker:translate:details:daily') `
    -WorkingDirectory $backend -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'detail-translator.out.log') `
    -RedirectStandardError (Join-Path $runtime 'detail-translator.err.log') -PassThru
  Save-LocalPid 'detail-translator' $process
  Write-Host "Daily detail translator started PID=$($process.Id)"
}
