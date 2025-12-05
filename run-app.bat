@echo off
echo 🚀 Starting AI Form Filler...
start "" start-chrome-debug.bat
timeout /t 8 /nobreak >nul
cd backend
node server.js