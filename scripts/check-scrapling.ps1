$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$python = $env:MITA_SCRAPLING_PYTHON
if (!$python) { $python = Join-Path $repo 'backend/.venv-scrapling/Scripts/python.exe' }
if (!(Test-Path -LiteralPath $python)) { throw 'Run scripts/setup-scrapling.ps1 first (Windows Python 3.12+).' }
& $python -B -c "from importlib.metadata import version; assert version('scrapling') == '0.5'; assert version('beautifulsoup4') == '4.15.0'; from scrapling.fetchers import FetcherSession; from bs4 import BeautifulSoup; session = FetcherSession(retries=0, follow_redirects=False); client = session.__enter__(); assert callable(client.get); session.__exit__(None,None,None); print('Scrapling 0.5 + BeautifulSoup 4.15.0 ready; no source request made')"
if ($LASTEXITCODE) { throw 'Scrapling preflight failed; run scripts/setup-scrapling.ps1.' }
