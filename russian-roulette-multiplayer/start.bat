@echo off
chcp 65001 >nul
echo ==========================================
echo    Russian Roulette - Multiplayer
echo ==========================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    npm install
    if errorlevel 1 (
        echo Install failed!
        pause
        exit /b 1
    )
)

echo Starting server...
echo.
echo Game URL: http://localhost:3000
echo.
echo Your IP (for friends to connect):
ipconfig | findstr "IPv4"
echo.
echo Press Ctrl+C to stop
echo ==========================================
node server.js

pause
