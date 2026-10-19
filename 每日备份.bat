@echo off
title WSMS Daily Backup
cd /d "%~dp0"

rem docker CLI may not be in PATH on this machine (found at C:\Docker)
set "PATH=C:\Program Files\Docker\Docker\resources\bin;C:\Docker\resources\bin;%PATH%"

"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\backup.ps1"
exit /b %ERRORLEVEL%
