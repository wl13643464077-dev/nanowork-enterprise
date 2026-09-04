@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS and Git, then try again.
  pause
  exit /b 1
)
node scripts/local-start.mjs --sync
if errorlevel 1 pause
