@echo off
setlocal
title FBI NDI Auto Gateway

echo.
echo ==========================================
echo   FBI CLIENT FILE STUDIO - NDI GATEWAY
echo   Automatic LAN Discovery
echo ==========================================
echo.
echo No pairing code is required.
echo The gateway scans the local network using
echo native NDI discovery (mDNS).
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found.
  echo Install Python 3.11 or newer, then run this file again.
  pause
  exit /b 1
)

echo Installing/checking NDI gateway dependencies...
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo.
  echo Dependency installation failed.
  pause
  exit /b 1
)

echo.
echo Starting local NDI gateway on http://127.0.0.1:8765
echo Keep this window open while using NDI I/O in FBI Client File Studio.
echo.
python "%~dp0gateway.py" --host 127.0.0.1 --port 8765
pause
