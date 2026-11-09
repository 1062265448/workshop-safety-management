' 开机自启看门狗（隐藏窗口）：本文件置于启动文件夹，登录后自动拉起 watchdog.ps1
Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = "D:\workshop_programs\wssm"
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1", 0, False
