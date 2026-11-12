@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 (echo Cannot open Mita project directory.& pause& exit /b 1)
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

:menu
echo.
echo ==================================================
echo   MITA JAPAN - LOCAL DEVELOPMENT CONTROL
echo ==================================================
echo   [1] Start local - original full startup
echo   [2] Start local + mobile Cloudflare tunnel
echo   [3] Update / check local website
echo   [4] Show status and mobile URL
echo   [5] Stop mobile tunnel only
echo   [0] Exit - services remain running
echo ==================================================
set "MODE="
set /p "MODE=Choose mode: "
if "%MODE%"=="0" exit /b 0
if "%MODE%"=="1" goto local
if "%MODE%"=="2" goto mobile
if "%MODE%"=="3" goto update
if "%MODE%"=="4" goto status
if "%MODE%"=="5" goto stop
echo Invalid choice.
goto menu

:local
echo Running original local startup (includes DB migration and Supervisor)...
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
if errorlevel 1 goto failed
start "" "http://127.0.0.1:3000"
goto done

:mobile
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mita-mobile.ps1" -Action Start
if errorlevel 1 goto failed
goto done

:update
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mita-mobile.ps1" -Action Update
if errorlevel 1 goto failed
goto done

:status
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mita-mobile.ps1" -Action Status
if errorlevel 1 goto failed
goto done

:stop
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mita-mobile.ps1" -Action Stop
if errorlevel 1 goto failed
goto done

:failed
echo.
echo [FAILED] Review the message above. No automatic retry.
:done
echo.
pause
goto menu
