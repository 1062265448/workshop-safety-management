@echo off
title 车间安全管理系统 - 每日备份
cd /d "%~dp0"

rem Windows 上 docker CLI 不一定在 PATH，补默认安装路径
set "PATH=C:\Program Files\Docker\Docker\resources\bin;%PATH%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\backup.ps1"
exit /b %ERRORLEVEL%
