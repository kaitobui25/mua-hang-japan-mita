@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
where py.exe >nul 2>nul
if not errorlevel 1 (
  py -3 -X utf8 "%~dp0scripts\mita-gsc-monitor.py" %*
  goto :finished
)
where python.exe >nul 2>nul
if not errorlevel 1 (
  python -X utf8 "%~dp0scripts\mita-gsc-monitor.py" %*
  goto :finished
)
echo Khong tim thay Python 3. Hay cai Python 3 de chay GSC Monitor.
set "MITA_EXIT=1"
goto :end

:finished
set "MITA_EXIT=%ERRORLEVEL%"

:end
if "%~1"=="" (
  echo.
  set /p "MITA_CLOSE=Nhan Enter de thoat... "
)
exit /b %MITA_EXIT%
