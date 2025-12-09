@echo off
echo Starting Chrome in Debug Mode...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\LENOVO\temp\chrome-session"

echo Waiting for Chrome to initialize...
timeout /t 2 >nul

echo Starting Node.js Backend Server...
cd /d "C:\Users\LENOVO\Documents\Playwright_chrome_debugport\backend"
start "" cmd /k "node server.js"

echo Everything started successfully!
pause
