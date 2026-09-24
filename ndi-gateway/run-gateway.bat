@echo off
setlocal EnableExtensions

title FBI Client File Studio - NDI Auto Gateway

echo.
echo ============================================================
echo        FBI CLIENT FILE STUDIO - NDI AUTO GATEWAY
echo ============================================================
echo.
echo Native NDI LAN discovery is enabled.
echo No pairing code is required.
echo.

set "INSTALL_DIR=%~dp0FBI-NDI-Gateway"
set "GATEWAY=%INSTALL_DIR%\gateway.py"
set "REQUIREMENTS=%INSTALL_DIR%\requirements.txt"
set "GATEWAY_URL=https://raw.githubusercontent.com/ffbios/ffbios-fbi-client-file-studio/main/ndi-gateway/gateway.py?cachebust=20260924"
set "REQUIREMENTS_URL=https://raw.githubusercontent.com/ffbios/ffbios-fbi-client-file-studio/main/ndi-gateway/requirements.txt?cachebust=20260924"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found.
    echo Install Python 3.11 or newer and run this file again.
    pause
    exit /b 1
)

echo Python:
python --version
echo.

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

echo Downloading the LATEST NDI gateway...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Headers @{'Cache-Control'='no-cache'} -Uri '%GATEWAY_URL%' -OutFile '%GATEWAY%'"
if errorlevel 1 (
    echo [ERROR] Could not download gateway.py
    pause
    exit /b 1
)

echo Downloading requirements...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Headers @{'Cache-Control'='no-cache'} -Uri '%REQUIREMENTS_URL%' -OutFile '%REQUIREMENTS%'"
if errorlevel 1 (
    echo [ERROR] Could not download requirements.txt
    pause
    exit /b 1
)

echo.
echo Checking downloaded gateway version...
findstr /C:"VERSION = " "%GATEWAY%"
echo.

echo Installing/checking dependencies...
python -m pip install -r "%REQUIREMENTS%"
if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo Starting FBI NDI Gateway
echo ============================================================
echo Local gateway: http://127.0.0.1:8765
echo Native NDI discovery: ENABLED
echo Pairing code: NOT REQUIRED
echo.
echo Keep this window open while using NDI.
echo ============================================================
echo.

python "%GATEWAY%" --host 127.0.0.1 --port 8765

echo.
echo NDI Gateway stopped.
pause
