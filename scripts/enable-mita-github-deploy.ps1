# Owner-run, one-time GitHub secret activation. Requires GitHub CLI authenticated.
# The private key is read locally and uploaded only to this repository's Actions
# encrypted secret; it is never printed or committed.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$key = Join-Path $repoRoot '.agents/runtime/mita-ci-ed25519'
$public = "$key.pub"
if (!(Test-Path -LiteralPath $key) -or !(Test-Path -LiteralPath $public)) {
  throw 'Dedicated Mita CI key not found. See deploy/mita/ci-deploy.md.'
}
if (!(Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh.exe) is not installed.'
}
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not authenticated. Run gh auth login.' }

# cmd.exe's input redirection passes the OpenSSH file unchanged (binary-safe);
# do not use -b to pass secrets as command-line arguments.
$cmd = 'gh secret set MITA_DEPLOY_SSH_KEY -R kaitobui25/mua-hang-japan-mita < "' + $key + '"'
& cmd.exe /D /C $cmd
if ($LASTEXITCODE -ne 0) { throw 'GitHub refused MITA_DEPLOY_SSH_KEY.' }
Write-Output 'Mita GitHub Actions SSH deploy key is configured.'
Write-Output 'Use a HEAD commit message with [deploy], then git push origin main.'
