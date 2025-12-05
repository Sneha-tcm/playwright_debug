@echo off
mkdir "%USERPROFILE%\temp\chrome-session" 2>nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\temp\chrome-session"
echo Chrome debugging ready on port 9222. Login to your sites, then run: node server.js
pause