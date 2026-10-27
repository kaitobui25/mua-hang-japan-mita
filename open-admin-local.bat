@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\open-admin-local.ps1"
if errorlevel 1 (
  echo.
  echo Admin local could not be opened. See the error above.
  pause
  exit /b 1
)
