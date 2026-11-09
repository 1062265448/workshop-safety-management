# WSMS 后端看门狗：每分钟探测 3100 端口，无监听则拉起后端
# 独立 PowerShell 实现，刻意不依赖 node——本机 node 均挂在 Kimi 运行时上，
# Kimi 升级会替换运行时并连带杀死由它拉起的后端进程（2026-11-09 事故根因）。
# 后端以 ELECTRON_RUN_AS_NODE=1 模式由 Kimi.exe 直接托管，与 Kimi Work 进程树无关。
$BackendDir = 'D:\workshop_programs\wssm\backend'
$KimiExe = 'E:\programs\kimi\Kimi.exe'
$Log = 'D:\workshop_programs\wssm\watchdog.log'
$GraceSeconds = 90
$lastStart = [DateTime]::MinValue

function Write-Log($msg) {
  Add-Content -Path $Log -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg)
}

Write-Log '看门狗启动'

while ($true) {
  try {
    # 用 netstat 探测：Get-NetTCPConnection 在本机连接数多时会漏条目（已实测误报）
    $up = netstat -ano | Select-String ':3100\s.*LISTENING'
    if (-not $up) {
      $elapsed = ([DateTime]::Now - $lastStart).TotalSeconds
      if ($elapsed -gt $GraceSeconds) {
        $lastStart = [DateTime]::Now
        Write-Log '3100 无监听，拉起后端'
        $env:ELECTRON_RUN_AS_NODE = '1'
        Start-Process -FilePath $KimiExe -ArgumentList 'dist\main.js' -WorkingDirectory $BackendDir -RedirectStandardOutput "$BackendDir\backend-out.log" -RedirectStandardError "$BackendDir\backend-err.log" -WindowStyle Hidden
      }
    }
  } catch {
    Write-Log ("看门狗异常：" + $_.Exception.Message)
  }
  Start-Sleep -Seconds 60
}
