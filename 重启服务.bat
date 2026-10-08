@echo off
title 车间安全管理系统 · 一键重启
cd /d "%~dp0"

echo ==========================================
echo    车间安全管理系统 · 一键重启
echo ==========================================
echo.

echo [1/3] 停止旧后端进程（端口 3100）...
set "KILLED="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1 && set "KILLED=1"
)
if defined KILLED (echo     已停止旧进程) else (echo     没有运行中的旧进程)

echo [2/3] 确认数据库容器 wsms-postgres ...
"C:\Program Files\Docker\Docker\resources\bin\docker.exe" start wsms-postgres >nul 2>&1
if errorlevel 1 (
    echo     [警告] 数据库容器启动失败，请先打开 Docker Desktop 再运行本脚本！
) else (
    echo     数据库正常
)

echo [3/3] 启动后端（同时托管前端页面）...
start "车间安全管理系统-后端（勿关闭此窗口）" /d "%~dp0backend" cmd /k "npm start"

echo.
echo 完成！稍等几秒后访问： http://localhost:3100
echo 后端日志在新窗口中显示，关闭那个窗口即停止服务。
echo.
ping -n 6 127.0.0.1 >nul
