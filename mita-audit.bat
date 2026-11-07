@echo off
setlocal
chcp 65001 >nul
title Mita Japan - Kiểm tra hằng ngày
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mita-daily-audit.ps1" %*
exit /b %ERRORLEVEL%
