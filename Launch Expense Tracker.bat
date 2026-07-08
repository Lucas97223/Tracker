@echo off
REM Launches the Expense Tracker desktop app.
REM Double-click this file from anywhere — it cd's to the project folder
REM and starts Electron loading the built app from ./dist.

cd /d "%~dp0"

if not exist "dist\index.html" (
  echo dist\index.html not found. Building the app first...
  call npm run build
  if errorlevel 1 (
    echo Build failed. Press any key to close.
    pause
    exit /b 1
  )
)

REM Use the local electron binary; suppress the cmd window after it spawns.
start "" /b "node_modules\electron\dist\electron.exe" .
