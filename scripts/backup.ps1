# 车间安全管理系统 · 每日自动备份（Windows 版）
# 思路（参照主任系统）：数据库每天一份、保留最近 30 份、导出后先在容器内校验再落盘；
# 另将 backend\uploads 镜像到 backups\uploads。
# 退出码：0 成功；1 容器未运行/docker 不可用；2 导出失败；3 校验失败（已删除坏文件）；4 拷贝/比对失败；5 uploads 镜像失败

$ErrorActionPreference = 'Stop'

$root       = Split-Path -Parent $PSScriptRoot   # 项目根目录（scripts 的上一级）
$backupDir  = Join-Path $root 'backups'
$uploadsSrc = Join-Path $root 'backend\uploads'
$uploadsDst = Join-Path $backupDir 'uploads'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$logFile = Join-Path $backupDir 'backup.log'
function Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# Windows 上 docker CLI 不一定在 PATH，补默认安装路径（本机实测在 C:\Docker）
$dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
if (Test-Path $dockerBin) { $env:Path = "$dockerBin;$env:Path" }
$dockerBinLocal = 'C:\Docker\resources\bin'
if (Test-Path $dockerBinLocal) { $env:Path = "$dockerBinLocal;$env:Path" }

$container = 'wsms-postgres'

# 从 backend\.env 的 DATABASE_URL 解析数据库用户名与库名（取不到则回退默认值）
$dbUser = 'wsms'
$dbName = 'workshop_safety'
$envFile = Join-Path $root 'backend\.env'
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^DATABASE_URL="?postgresql://([^:/]+)(?::[^@]*)?@[^/]+/([^"?]+)' | Select-Object -First 1
    if ($m) {
        $dbUser = $m.Matches[0].Groups[1].Value
        $dbName = $m.Matches[0].Groups[2].Value
    }
}

Log "===== 开始备份（数据库 $dbName，用户 $dbUser，容器 $container）====="

# [1/5] 容器必须在运行
$running = docker ps --filter "name=^${container}$" --format '{{.Names}}' 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne $container) {
    Log "[失败] 容器 $container 未运行或 docker 不可用，请先启动 Docker Desktop 并 docker start $container"
    exit 1
}
Log "[1/5] 数据库容器运行中"

# [2/5] 在容器内导出（自定义格式 -Fc，避免 PowerShell 重定向破坏二进制）
$ts      = Get-Date -Format 'yyyyMMdd-HHmm'
$dumpName = "wsms-$ts.dump"
$dumpPath = Join-Path $backupDir $dumpName
$tmpInContainer = "/tmp/$dumpName"

docker exec $container pg_dump -U $dbUser -d $dbName -Fc -f $tmpInContainer
if ($LASTEXITCODE -ne 0) {
    Log "[失败] pg_dump 导出失败（退出码 $LASTEXITCODE）"
    docker exec $container rm -f $tmpInContainer | Out-Null
    exit 2
}
Log "[2/5] pg_dump 导出完成"

# [3/5] 先在容器内校验：pg_restore --list 能列出目录才算完整
docker exec $container pg_restore --list $tmpInContainer | Out-Null
if ($LASTEXITCODE -ne 0) {
    Log "[失败] 备份校验未通过（pg_restore --list 无法读取），已删除，不落盘"
    docker exec $container rm -f $tmpInContainer | Out-Null
    exit 3
}
Log "[3/5] 校验通过（pg_restore --list 可读取归档目录）"

# [4/5] 拷出到宿主机并比对大小，防止拷贝截断
docker cp "${container}:$tmpInContainer" $dumpPath
if ($LASTEXITCODE -ne 0) {
    Log "[失败] docker cp 拷出失败（退出码 $LASTEXITCODE）"
    docker exec $container rm -f $tmpInContainer | Out-Null
    exit 4
}
$srcSize = [int64](docker exec $container stat -c %s $tmpInContainer)
docker exec $container rm -f $tmpInContainer | Out-Null
$dstSize = (Get-Item $dumpPath).Length
if ($srcSize -ne $dstSize -or $dstSize -le 0) {
    Log "[失败] 落盘文件大小不一致（容器 $srcSize / 本地 $dstSize），已删除"
    Remove-Item -Force $dumpPath -ErrorAction SilentlyContinue
    exit 4
}
Log "[4/5] 已落盘 $dumpPath（$dstSize 字节）"

# 保留最近 30 份，删除更老的
$old = Get-ChildItem $backupDir -Filter 'wsms-*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30
foreach ($f in $old) {
    Remove-Item -Force $f.FullName
    Log "  清理旧备份：$($f.Name)"
}
if ($old) { Log "  已清理 $($old.Count) 份超龄备份（保留最近 30 份）" }

# [5/5] 镜像 backend\uploads 到 backups\uploads（robocopy 退出码 0-7 均为成功）
if (Test-Path $uploadsSrc) {
    robocopy $uploadsSrc $uploadsDst /MIR /NFL /NDL /NJH /NJS /R:2 /W:2 | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) {
        Log "[失败] uploads 镜像失败（robocopy 退出码 $rc）；数据库备份本身已成功"
        exit 5
    }
    Log "[5/5] uploads 已镜像到 $uploadsDst"
} else {
    Log "[5/5] 无 backend\uploads 目录，跳过文件镜像"
}

Log "===== 备份完成：$dumpName ====="
exit 0
