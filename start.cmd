@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS from https://nodejs.org/ first.
  pause
  exit /b 1
)
node scripts/local-start.mjs
if errorlevel 1 pause
