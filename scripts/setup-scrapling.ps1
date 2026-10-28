param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$venv = Join-Path $repo 'backend/.venv-scrapling'
if (-not (Test-Path (Join-Path $venv 'Scripts/python.exe'))) {
  python -m venv $venv
  if ($LASTEXITCODE) { throw 'Python virtualenv creation failed' }
}
& (Join-Path $venv 'Scripts/python.exe') -m ensurepip --upgrade
if ($LASTEXITCODE) { throw 'Virtualenv pip bootstrap failed' }
& (Join-Path $venv 'Scripts/python.exe') -m pip install -r (Join-Path $repo 'backend/python/requirements.txt')
if ($LASTEXITCODE) { throw 'Scrapling dependency install failed' }
& (Join-Path $PSScriptRoot 'check-scrapling.ps1')
