@echo off
setlocal
chcp 65001 >nul
title Mita Japan - Kiem tra hang ngay
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mita-daily-audit.ps1" %*
set "auditExit=%ERRORLEVEL%"
echo.
set /p "auditPause=Nhan Enter de dong cua so... "
exit /b %auditExit%
