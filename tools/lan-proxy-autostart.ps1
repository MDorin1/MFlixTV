# 启动局域网代理桥（给电视/盒子/手机填系统代理用）
# 监听 0.0.0.0:7891 -> 127.0.0.1:7890 (MMC)
$ErrorActionPreference = "SilentlyContinue"

$root = "D:\Backup\Documents\deepseek-harness\default-workspace\lihongguotv-desktop"
$node = if (Test-Path "D:\Tools\nodejs\node.exe") { "D:\Tools\nodejs\node.exe" } else { "node" }
$script = Join-Path $root "tools\lan-proxy.js"
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# 已经在跑就不重复启动
$busy = $null
try {
    $busy = Test-NetConnection -ComputerName 127.0.0.1 -Port 7891 -InformationLevel Quiet -WarningAction SilentlyContinue
} catch {}
if ($busy) {
    Write-Output "bridge already listening on 7891 - nothing to do"
    exit 0
}

Start-Process -FilePath $node `
    -ArgumentList "`"$script`"" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "lan-proxy.out.log") `
    -RedirectStandardError (Join-Path $logDir "lan-proxy.err.log")

Start-Sleep -Seconds 2
$ok = $null
try {
    $ok = (Invoke-WebRequest -Uri "http://127.0.0.1:7891/health" -UseBasicParsing -TimeoutSec 5).StatusCode
} catch {}
if ($ok -eq 200) { Write-Output "bridge started: http://<this-pc-ip>:7891 -> 127.0.0.1:7890" }
else { Write-Output "bridge failed to start, see logs\lan-proxy.err.log" }
