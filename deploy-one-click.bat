@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Mita Japan - Push, Data, Deploy, Verify
echo =====================================================
echo   MITA JAPAN - ONE CLICK VPS DEPLOY
echo   Push Git + Sync Data + CI + Website Verification
echo =====================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-one-click.ps1" %*
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
  if /I "%~1"=="-DryRun" (
    echo [SUCCESS] Dry run passed. No deployment was performed.
  ) else if /I "%~1"=="-DataOnly" (
    echo [SUCCESS] VPS data sync verified. Git and website deployment were skipped.
  ) else (
    echo [SUCCESS] Git, VPS data and website verification completed.
  )
) else (
  echo [ERROR] Deployment or verification failed. Exit code: %RESULT%
  echo Please read the error details above.
)
echo.
echo Nhan phim bat ky de dong cua so nay...
pause >nul
exit /b %RESULT%
