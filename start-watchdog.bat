@echo off
rem 拉起 WSMS 后端看门狗（隐藏窗口）；机器重启后双击本文件恢复看门狗
powershell -NoProfile -Command "Start-Process -FilePath 'E:\programs\kimi\resources\resources\runtime\node.exe' -ArgumentList 'watchdog.js' -WorkingDirectory 'D:\workshop_programs\wssm' -WindowStyle Hidden"
