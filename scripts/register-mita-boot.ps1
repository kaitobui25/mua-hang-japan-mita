# Dry-run by default. Apply only with explicit -Apply under the owner account.
# AtLogOn preserves access to the owner's DPAPI and ssh-agent credentials.
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$name='MitaJapan-LocalWorkers'
$path=(Resolve-Path (Join-Path $PSScriptRoot 'start-mita-on-boot.ps1')).Path
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  throw "Task $name already exists. Inspect it manually before replacing any task."
}
$command=(Get-Command powershell.exe).Source
$arguments="-NoProfile -ExecutionPolicy Bypass -File "+'"'+$path+'"'
Write-Host "Task: $name"
Write-Host "User: $user; trigger: AtLogOn; executable: $command"
Write-Host "Script: $path"
if (!$Apply) { Write-Host 'Dry-run only. Re-run with -Apply to register.'; return }
if ($PSCmdlet.ShouldProcess($name,'Register Mita Task Scheduler logon task')) {
  $action=New-ScheduledTaskAction -Execute $command -Argument $arguments
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable:$false -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
  Write-Host "Registered $name (no missed job catch-up)."
}
