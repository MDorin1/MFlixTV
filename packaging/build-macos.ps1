<#
.SYNOPSIS
    组装 MFlixTV 的 macOS 便携包（Intel + Apple 芯片通吃），并压成带执行位的 zip。

.DESCRIPTION
    在 Windows 上就能出包，不需要 Mac：
      · app/ 与 hongguo/ 直接复用 Windows 便携目录（packaging\stage）里的那份，
        桌面代码跨平台，Next 构建产物也一样（.next 与 node_modules 都在）；
      · runtime/ 换成 macOS 版 Node 与 ffmpeg，两套架构各放一份，
        由 packaging\启动MFlixTV.command 按 `uname -m` 自己挑；
      · 用 Python 的 zipfile 写 external_attr，保住可执行位
        （Compress-Archive 写出来全是 0，解压后 .command 双击没反应）。

    运行时往哪拿（都能在 Windows 上下）：
      Node    https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-arm64.tar.gz
              https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-x64.tar.gz
      ffmpeg  https://www.osxexperts.net/ffmpeg7arm.zip          (arm64)
              https://www.osxexperts.net/ffmpeg71intel.zip       (x64)
              evermeet.cx 已下线（返回 410），别再用。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File packaging\build-macos.ps1 `
        -Stage packaging\stage -Out D:\Build\mac\root -Dist D:\Build\dist\MFlixTV-macOS.zip `
        -NodeArmDir D:\Build\mac\dl\node-arm -NodeX64Dir D:\Build\mac\dl\node-x64 `
        -FfmpegArm D:\Build\mac\dl\ffmpeg-arm64 -FfmpegX64 D:\Build\mac\dl\ffmpeg-x64
#>
[CmdletBinding()]
param(
    [string]$Stage = (Join-Path $PSScriptRoot 'stage'),
    [string]$Out = 'D:\Build\mac\root',
    [string]$Dist = 'D:\Build\dist\MFlixTV-macOS.zip',
    [Parameter(Mandatory = $true)][string]$NodeArmDir,
    [Parameter(Mandatory = $true)][string]$NodeX64Dir,
    [Parameter(Mandatory = $true)][string]$FfmpegArm,
    [Parameter(Mandatory = $true)][string]$FfmpegX64,
    [string]$Python = 'python',
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Need([string]$p, [string]$what) {
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少$what：$p" }
}

function CopyTree([string]$src, [string]$dst) {
    # robocopy 比 Copy-Item 快一个数量级（一万多个小文件）
    $null = robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败($LASTEXITCODE)：$src -> $dst" }
}

# 1) 输入检查
Need $Stage 'Windows 便携目录'
Need (Join-Path $Stage 'app\.next\BUILD_ID') 'app 构建产物'
Need (Join-Path $Stage 'app\node_modules\next\dist\bin\next') 'next 运行时'
Need (Join-Path $Stage 'app\.env') 'app 配置文件（含 PASSWORD / DEFAULT_SOURCES）'
Need (Join-Path $Stage 'hongguo\server\src\main.js') '短剧内核'
Need (Join-Path $NodeArmDir 'node') 'arm64 版 node（目录里要有名为 node 的文件）'
Need (Join-Path $NodeX64Dir 'node') 'x64 版 node（目录里要有名为 node 的文件）'
Need $FfmpegArm 'arm64 版 ffmpeg'
Need $FfmpegX64 'x64 版 ffmpeg'

Write-Host "[1/4] 清空 $Out"
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out -Force | Out-Null

Write-Host "[2/4] 复制 app / hongguo"
CopyTree (Join-Path $Stage 'app') (Join-Path $Out 'app')
CopyTree (Join-Path $Stage 'hongguo') (Join-Path $Out 'hongguo')

# 平台专用的原生依赖对 mac 没用，白占 170MB
$prune = @(
    'app\node_modules\@next\swc-win32-x64-msvc',
    'app\node_modules\@img\sharp-win32-x64'
)
foreach ($p in $prune) {
    $full = Join-Path $Out $p
    if (Test-Path -LiteralPath $full) {
        Remove-Item -LiteralPath $full -Recurse -Force
        Write-Host "      剪掉 $p"
    }
}

Write-Host "[3/4] 放运行时、启动脚本、说明与许可"
$rt = Join-Path $Out 'runtime'
New-Item -ItemType Directory -Path (Join-Path $rt 'ffmpeg') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $NodeArmDir 'node') -Destination (Join-Path $rt 'node-arm64') -Force
Copy-Item -LiteralPath (Join-Path $NodeX64Dir 'node') -Destination (Join-Path $rt 'node-x64') -Force
Copy-Item -LiteralPath $FfmpegArm -Destination (Join-Path $rt 'ffmpeg\ffmpeg-arm64') -Force
Copy-Item -LiteralPath $FfmpegX64 -Destination (Join-Path $rt 'ffmpeg\ffmpeg-x64') -Force

# .command 必须是 LF：CRLF 会让 macOS 报 /bin/bash^M: bad interpreter
$cmdSrc = Join-Path $PSScriptRoot '启动MFlixTV.command'
$cmd = [System.IO.File]::ReadAllText($cmdSrc) -replace "`r`n", "`n"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $Out '启动MFlixTV.command'), $cmd, $utf8)

Copy-Item -LiteralPath (Join-Path $PSScriptRoot '使用说明-macOS.txt') -Destination (Join-Path $Out '使用说明.txt') -Force
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination $Out -Force
Copy-Item -LiteralPath (Join-Path $repo 'NOTICE.md') -Destination $Out -Force
CopyTree (Join-Path $repo 'LICENSES') (Join-Path $Out 'LICENSES')
Copy-Item -LiteralPath (Join-Path $repo 'docs\合规与免责.md') -Destination $Out -Force

# 4) 打包
$files = (Get-ChildItem -LiteralPath $Out -Recurse -File).Count
$mb = [math]::Round(((Get-ChildItem -LiteralPath $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "[4/4] 载荷 $files 个文件 / $mb MB"
if ($SkipZip) { Write-Host "      -SkipZip：跳过压缩"; return }

& $Python (Join-Path $PSScriptRoot 'zip-macos.py') $Out $Dist 'MFlixTV-macOS'
if ($LASTEXITCODE -ne 0) { throw "zip 失败：$LASTEXITCODE" }

$zip = Get-Item -LiteralPath $Dist
Write-Host ("完成：{0}  {1:N0} 字节  MD5 {2}" -f $zip.Name, $zip.Length, (Get-FileHash -LiteralPath $Dist -Algorithm MD5).Hash)
Write-Host "提醒：发包前用 macOS 实机或云端 mac 验证一次启动（Windows 上只能验结构，不能验运行）。"
