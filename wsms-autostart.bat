@echo off
title WSMS AutoStart (DB + Backend + Tunnel)
set "WSMS=D:\workshop_programs\wssm"
set "DOCKERBIN=C:\Docker\resources\bin"

rem 1. Start Docker Desktop if not running, then wait for the daemon
tasklist | findstr /i "Docker Desktop.exe" >nul
if errorlevel 1 start "" "C:\Docker\Docker Desktop.exe"
echo [1/4] Waiting for Docker daemon...
:waitdocker
"%DOCKERBIN%\docker.exe" info >nul 2>&1
if errorlevel 1 (ping -n 4 127.0.0.1 >nul & goto waitdocker)

rem 2. Database container (starts existing one, never recreates)
echo [2/4] Starting database container...
"%DOCKERBIN%\docker-compose.exe" -p wsms -f "%WSMS%\docker-compose.yml" up -d >nul 2>&1

rem 3. Backend (skip if port 3100 already listening)
netstat -ano | findstr ":3100 " | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [3/4] Starting backend...
    start "WSMS-Backend (DO NOT CLOSE)" /min /d "%WSMS%\backend" cmd /k "npm start"
) else (
    echo [3/4] Backend already running, skipped
)

rem 4. cloudflared tunnel (skip if process exists)
tasklist | findstr /i "cloudflared.exe" >nul
if errorlevel 1 (
    echo [4/4] Starting cloudflared tunnel...
    start "WSMS-Tunnel (DO NOT CLOSE)" /min /d "%USERPROFILE%" cmd /k "cloudflared.exe tunnel run"
) else (
    echo [4/4] Tunnel already running, skipped
)

echo.
echo Done. Local: http://localhost:3100  ^|  Public: https://wsms.jcngcp.xyz
ping -n 3 127.0.0.1 >nul
exit
