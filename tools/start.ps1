<#
.SYNOPSIS
    双击启动「看电影」：把主站(8080)和短剧服务(8000)拉起来，然后打开浏览器。

.DESCRIPTION
    幂等：已经在跑就只打开浏览器，不会重复启动。
    会自动识别三种部署形态：
      1) 安装版      %LOCALAPPDATA%\Programs\lihongguotv\lihongguotv.exe
      2) 便携版      当前目录下有 runtime\node.exe + app\node_modules
      3) 开发目录    本仓库的同级目录里的 LibreTV 应用 + hongguo-web 内核 + D:\Tools\nodejs

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File tools\start.ps1
#>
[CmdletBinding()]
param(
    [int]$WebPort = 8080,
    [int]$HgPort = 8000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# ---------- 路径 ----------
$repo = Split-Path -Parent $PSScriptRoot          # <repo>/tools -> <repo>
$work = Split-Path -Parent $repo                  # 同级目录，放 LibreTV / hongguo-web
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'start.log'

function Say([string]$msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $msg
}

function Test-Port([int]$port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

function Wait-Http([string]$url, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

Say '=== 启动请求 ==='

# ---------- 1) 安装版直接交给托盘程序 ----------
$installed = Join-Path $env:LOCALAPPDATA 'Programs\lihongguotv\lihongguotv.exe'
if (Test-Path $installed) {
    Say "使用安装版：$installed"
    if (-not (Test-Port $WebPort)) {
        Start-Process -FilePath $installed -WorkingDirectory (Split-Path $installed -Parent)
        if (Wait-Http "http://127.0.0.1:$WebPort/" 90) { Say '安装版已就绪' } else { Say '安装版启动超时，看 logs\web.log' }
    } else {
        Say "端口 $WebPort 已在运行，跳过启动"
    }
    if (-not $NoBrowser) { Start-Process "http://localhost:$WebPort/" }
    return
}

# ---------- 2) 找 node 运行时 ----------
$node = $null
foreach ($cand in @(
        (Join-Path $repo 'runtime\node.exe'),
        'D:\Tools\nodejs\node.exe'
    )) {
    if (Test-Path $cand) { $node = $cand; break }
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
    Say '[x] 找不到 node 运行时（试过 runtime\node.exe、D:\Tools\nodejs\node.exe、PATH）'
    [void][System.Windows.Forms.MessageBox]::Show('找不到 Node 运行时，无法启动。请看 logs\start.log', 'lihongguotv')
    return
}
Say "node: $node"

# ---------- 3) 找主站与短剧内核目录 ----------
$appDir = $null
foreach ($cand in @(
        (Join-Path $repo 'app'),
        (Join-Path $work 'LibreTV'),
        (Join-Path $work 'libretv')
    )) {
    if (Test-Path (Join-Path $cand 'node_modules\next\dist\bin\next')) { $appDir = $cand; break }
}
if (-not $appDir) {
    Say '[x] 找不到主站（需要 node_modules\next\dist\bin\next）'
    [void][System.Windows.Forms.MessageBox]::Show('找不到主站目录，无法启动。请看 logs\start.log', 'lihongguotv')
    return
}
Say "主站: $appDir"

$hgDir = $null
foreach ($cand in @(
        (Join-Path $repo 'hongguo'),
        (Join-Path $work 'hongguo-web')
    )) {
    if (Test-Path (Join-Path $cand 'server\src\main.js')) { $hgDir = $cand; break }
}
if ($hgDir) { Say "短剧内核: $hgDir" } else { Say '[!] 没找到短剧内核，短剧专区会打不开（主站仍可用）' }

# 主站如果不在了就补 .env
$envFile = Join-Path $appDir '.env'
if (-not (Test-Path $envFile)) {
    $example = Join-Path $appDir '.env.example'
    if (Test-Path $example) { Copy-Item $example $envFile; Say '已从 .env.example 生成 .env（记得改 PASSWORD）' }
}

# ---------- 4) 起短剧服务 ----------
if ($hgDir -and -not (Test-Port $HgPort)) {
    Say "启动短剧服务 :$HgPort"
    $env:PORT = "$HgPort"
    $env:BIND_HOST = '127.0.0.1'
    $env:HG_OPEN_BROWSER = '0'
    $env:HG_TRANSCODE = '1'
    $env:HG_CACHE_MAX_FILES = '120'
    Start-Process -FilePath $node -ArgumentList 'server/src/main.js' -WorkingDirectory $hgDir -WindowStyle Hidden
    Start-Sleep -Seconds 3
} elseif ($hgDir) {
    Say "短剧服务已在运行 :$HgPort"
}

# ---------- 5) 起主站 ----------
if (-not (Test-Port $WebPort)) {
    Say "启动主站 :$WebPort（首次可能要十几秒）"
    Start-Process -FilePath $node `
        -ArgumentList "`"$appDir\node_modules\next\dist\bin\next`"", 'start', '-p', "$WebPort" `
        -WorkingDirectory $appDir -WindowStyle Hidden
} else {
    Say "主站已在运行 :$WebPort"
}

# ---------- 6) 等它就绪再开浏览器 ----------
if (Wait-Http "http://127.0.0.1:$WebPort/" 90) {
    Say '主站就绪'
    if (-not $NoBrowser) { Start-Process "http://localhost:$WebPort/" }
} else {
    Say '[x] 90 秒内没起来，看 logs\start.log 或 app 目录下的日志'
    [void][System.Windows.Forms.MessageBox]::Show("90 秒内没能启动 $WebPort，请看 logs\start.log", 'lihongguotv')
}
