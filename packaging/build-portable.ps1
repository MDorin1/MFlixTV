# 组装 Windows 便携目录（stage）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1 -Out D:\Build\lihongguotv\stage
#
# 产物结构（Inno Setup 用它打包）：
#   stage/
#     app/             Next.js 生产产物（.next + node_modules + public + .env）
#     hongguo/         红果内核（server/src + web）
#     runtime/         node.exe + ffmpeg
#     tools/           update.ps1
#     Launcher.cs → lihongguotv.exe（需另编译，见 packaging\README.md）
#     使用说明.txt

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$NodeExe,
  [string]$FfmpegBin,
  [string]$HongguoDir,
  [string]$AppDir
)

$ErrorActionPreference = 'Stop'

# 运行时二进制：没显式指定就从 PATH 里找
if (-not $NodeExe) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if (-not $c) { throw '找不到 node：用 -NodeExe 指定路径，或把 node 加进 PATH' }
  $NodeExe = $c.Source
}
if (-not $FfmpegBin) {
  $c = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $c) { throw '找不到 ffmpeg：用 -FfmpegBin 指定 ffmpeg 所在目录，或把它加进 PATH' }
  $FfmpegBin = Split-Path -Parent $c.Source
}
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $AppDir) { $AppDir = Join-Path $repo 'app' }
if (-not $HongguoDir) { $HongguoDir = Join-Path $repo '..\hongguo-web' }

Write-Host "==> 目标目录 $Out"
# 清空目标目录：node_modules 里有超 260 字符的路径，Remove-Item 会失败，
# 先用 robocopy 空目录镜像（它支持长路径），再删空壳
if (Test-Path $Out) {
  $empty = Join-Path $env:TEMP ("purge-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $empty | Out-Null
  & robocopy $empty $Out /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $empty -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path "$Out\app", "$Out\hongguo", "$Out\runtime\ffmpeg", "$Out\tools", "$Out\launcher" | Out-Null

# --- 1) Next.js 依赖与构建 ---
# 注意：build 需要 devDependencies（tailwind / postcss / typescript），不能 --omit=dev
if (-not (Test-Path "$AppDir\node_modules\next")) {
  Write-Host "==> 安装依赖（npm ci）"
  Push-Location $AppDir
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }
  Pop-Location
}

Write-Host "==> 构建前端（next build）"
Push-Location $AppDir
# 用 node 直接跑 next，不依赖 npx / 全局 PATH
& $NodeExe "$AppDir\node_modules\next\dist\bin\next" build
if ($LASTEXITCODE -ne 0) { throw "next build 失败" }
Pop-Location

Remove-Item "$Out\app\.next" -Recurse -Force -ErrorAction SilentlyContinue
# 用 robocopy：node_modules 里存在超过 260 字符的路径，Copy-Item 会中途失败
& robocopy "$AppDir\.next" "$Out\app\.next" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy .next 失败（exit $LASTEXITCODE）" }
# 编译缓存占一半体积，运行时用不到
Remove-Item "$Out\app\.next\cache" -Recurse -Force -ErrorAction SilentlyContinue
& robocopy "$AppDir\node_modules" "$Out\app\node_modules" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy node_modules 失败（exit $LASTEXITCODE）" }
Copy-Item "$AppDir\public" "$Out\app\public" -Recurse -Force
Copy-Item "$AppDir\package.json" "$Out\app\package.json" -Force
Copy-Item (Join-Path $repo 'packaging\next.config.mjs') "$Out\app\next.config.mjs" -Force

# 运行时配置：密码改成中性默认值
$envSrc = Join-Path $AppDir '.env'
if (-not (Test-Path $envSrc)) { Copy-Item "$AppDir\.env.example" $envSrc }
$env = Get-Content $envSrc -Raw -Encoding UTF8
$env = [regex]::Replace($env, '(?m)^PASSWORD=.*$', 'PASSWORD=lihongguotv')
$env = [regex]::Replace($env, '(?m)^PROXY_SECRET=.*$', 'PROXY_SECRET=lihongguotv-desktop-secret')
[IO.File]::WriteAllText("$Out\app\.env", $env, [Text.UTF8Encoding]::new($false))

# --- 2) 红果内核 ---
if (-not (Test-Path "$HongguoDir\server\src\main.js")) {
  throw "找不到 hongguo-web 源码：$HongguoDir（先 git clone https://github.com/sunnysky123/hongguo-web）"
}
Copy-Item "$HongguoDir\server\src" "$Out\hongguo\server\src" -Recurse -Force
Copy-Item "$HongguoDir\server\config" "$Out\hongguo\server\config" -Recurse -Force
Remove-Item "$Out\hongguo\server\config\apikeys.json" -Force -ErrorAction SilentlyContinue
Copy-Item "$HongguoDir\web" "$Out\hongguo\web" -Recurse -Force
Copy-Item "$HongguoDir\package.json" "$Out\hongguo\package.json" -Force

Write-Host "==> 打 content_type 补丁"
& (Join-Path $repo 'hongguo\patch-content-type.ps1') -Target "$Out\hongguo\server\src\service\client.js"

# --- 3) 运行时 ---
Copy-Item $NodeExe "$Out\runtime\node.exe" -Force
Copy-Item (Join-Path $FfmpegBin 'ffmpeg.exe') "$Out\runtime\ffmpeg\ffmpeg.exe" -Force

# --- 4) 工具与说明 ---
Copy-Item (Join-Path $repo 'tools\update.ps1') "$Out\tools\update.ps1" -Force
Copy-Item (Join-Path $repo 'packaging\Launcher.cs') "$Out\launcher\Launcher.cs" -Force
Copy-Item (Join-Path $repo 'packaging\app.ico') "$Out\launcher\app.ico" -Force
# Inno Setup 的 [Icons] 引用的是 {app}\使用说明.txt，所以这里统一成这个名字
Copy-Item (Join-Path $repo 'packaging\使用说明-Windows.txt') "$Out\使用说明.txt" -Force

$size = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "==> 完成，$Out （$size MB）"
Write-Host "下一步：编译 lihongguotv.exe 并用 Inno Setup 打包，见 packaging\README.md"
