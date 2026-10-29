@echo off
setlocal
start "Mita Japan" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0mita-desktop.ps1"
endlocal
