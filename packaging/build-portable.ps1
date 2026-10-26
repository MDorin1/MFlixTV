# 组装 Windows 便携目录（stage）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File packaging\build-portable.ps1 -Out D:\Build\MFlixTV\stage
#
# 产物结构（Inno Setup 用它打包）：
#   stage/
#     app/             Next.js 生产产物（.next + node_modules + public + .env）
#     hongguo/         短剧内核（server/src + web）
#     runtime/         node.exe + ffmpeg
#     tools/           update.ps1
#     Launcher.cs → MFlixTV.exe（需另编译，见 packaging\README.md）
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

# --- 1) 在 stage\app 里从零构建 ---
#
# 关键：构建用的 next 与运行用的 next 必须是同一个版本。
# 之前是「拷 live 的 .next + 按 lock 重装依赖」，而 lock 里 pin 的 next 版本与
# live 里实际装的版本不一致（15.5.26 vs 15.5.28），导致运行期每个动态路由 500，
# 浏览器表现为「该网页无法正常运作」。改为在 stage 内 npm ci → next build → prune，
# 版本天然一致。
$copyList = @('src','public','package.json','package-lock.json','tsconfig.json',
              'tailwind.config.ts','postcss.config.mjs','next-env.d.ts','next.config.ts','eslint.config.mjs')
foreach ($item in $copyList) {
  $from = Join-Path $AppDir $item
  if (-not (Test-Path $from)) { throw "缺少源码：$from" }
  Copy-Item $from (Join-Path "$Out\app" $item) -Recurse -Force
}

$npm = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'

# 跑外部命令：npm 会往 stderr 写 warn，而本脚本全局 ErrorActionPreference=Stop 时
# PowerShell 5.1 会把 stderr 当终止性错误，所以这里临时放开，只看退出码
function Invoke-Native {
    param([string]$Exe, [string[]]$ArgList, [string]$Tag)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host "    $_" }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

Push-Location "$Out\app"
Write-Host "==> npm ci（含 devDependencies，构建需要 tailwind/typescript）"
if ((Invoke-Native $npm @('ci','--no-audit','--no-fund') 'npm-ci') -ne 0) { Pop-Location; throw "npm ci 失败" }

Write-Host "==> next build"
if ((Invoke-Native $NodeExe @('node_modules\next\dist\bin\next','build') 'next-build') -ne 0) { Pop-Location; throw "next build 失败" }
$builtNext = (Get-Content 'node_modules\next\package.json' -Raw | ConvertFrom-Json).version

# 运行时用 mjs：安装版没有 TypeScript，留 .ts 会让 Next 试图自动装 typescript 再失败
Copy-Item (Join-Path $repo 'packaging\next.config.mjs') "$Out\app\next.config.mjs" -Force
Remove-Item "$Out\app\next.config.ts" -Force -ErrorAction SilentlyContinue

Write-Host "==> npm prune --omit=dev（去掉构建期依赖，版本不变）"
if ((Invoke-Native $npm @('prune','--omit=dev','--no-audit','--no-fund') 'npm-prune') -ne 0) { Pop-Location; throw "npm prune 失败" }
$runNext = (Get-Content 'node_modules\next\package.json' -Raw | ConvertFrom-Json).version
Pop-Location

# 运行时配置：安装版必须自带 .env，否则页面会提示「必须设置 PASSWORD」
# （曾经漏过这一步，用户装完直接卡死）
$envSrc = Join-Path $AppDir '.env'
if (-not (Test-Path $envSrc)) { $envSrc = Join-Path $AppDir '.env.example' }
if (-not (Test-Path $envSrc)) { throw "找不到 .env / .env.example，无法生成运行时配置" }
$envText = [IO.File]::ReadAllText($envSrc, [Text.Encoding]::UTF8)
$envText = [regex]::Replace($envText, '(?m)^PASSWORD=.*$', 'PASSWORD=MFlixTV')
$envText = [regex]::Replace($envText, '(?m)^PROXY_SECRET=.*$', 'PROXY_SECRET=MFlixTV-secret')
if ($envText -notmatch '(?m)^PASSWORD=') { $envText = "PASSWORD=MFlixTV`n" + $envText }
if ($envText -notmatch '(?m)^PROXY_SECRET=') { $envText = "PROXY_SECRET=MFlixTV-secret`n" + $envText }
[IO.File]::WriteAllText("$Out\app\.env", $envText, (New-Object Text.UTF8Encoding($false)))
# 版本号：以仓库里的 app/package.json 为准，避免打包用的开发目录版本号漂掉
$repoPkg = Join-Path $repo 'app\package.json'
if (Test-Path $repoPkg) {
  $repoVer = (Get-Content $repoPkg -Raw | ConvertFrom-Json).version
  $outPkg = Join-Path "$Out\app" 'package.json'
  $pkgText = [IO.File]::ReadAllText($outPkg, [Text.Encoding]::UTF8)
  $pkgText = [regex]::Replace($pkgText, '"version":\s*"[^"]+"', ('"version": "' + $repoVer + '"'), 1)
  [IO.File]::WriteAllText($outPkg, $pkgText, (New-Object Text.UTF8Encoding($false)))
  Write-Host "==> app 版本号对齐为 $repoVer"
}
Write-Host "==> 已写入 app\.env（PASSWORD=MFlixTV）"

Remove-Item "$Out\app\.next\cache" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "==> next 版本：构建 $builtNext / 运行 $runNext"
if ($builtNext -ne $runNext) { throw "next 版本不一致（构建 $builtNext / 运行 $runNext），安装后会 500" }
# --- 2) 短剧内核 ---
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

# 许可与第三方声明（AGPL / MIT / GPL 义务：源码与许可文本随二进制一同提供）
Copy-Item (Join-Path $repo 'LICENSE') "$Out\LICENSE" -Force
Copy-Item (Join-Path $repo 'NOTICE.md') "$Out\NOTICE.md" -Force
Copy-Item (Join-Path $repo 'LICENSES') "$Out\LICENSES" -Recurse -Force
Copy-Item (Join-Path $repo 'docs\合规与免责.md') "$Out\合规与免责.md" -Force

$size = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)

# HARD-GUARD: 安装包必须带默认点播源，否则装完就是空列表（历史事故）
$envFile = Join-Path $Out 'app\.env'
if (-not (Test-Path $envFile)) { throw "HARD-GUARD: 缺少 app\.env，打包中止" }
$envText2 = [IO.File]::ReadAllText($envFile, [Text.Encoding]::UTF8)
if ($envText2 -notmatch '(?m)^DEFAULT_SOURCES=\s*\[\s*\{') { throw "HARD-GUARD: app\.env 里没有 DEFAULT_SOURCES，打包中止（装完会是空源）" }
if ($envText2 -notmatch '(?m)^PASSWORD=\s*\S+') { throw "HARD-GUARD: app\.env 里没有 PASSWORD，打包中止" }
foreach ($req in @('app\.next\BUILD_ID', 'app\node_modules\next\dist\bin\next', 'runtime\node.exe')) {
  if (-not (Test-Path (Join-Path $Out $req))) { throw "HARD-GUARD: 缺少 $req，打包中止" }
}
Write-Host "==> HARD-GUARD 通过：.env 有源与密码、.next 与 next 可执行、runtime 就位"

Write-Host "==> 完成，$Out （$size MB）"
Write-Host "下一步：编译 MFlixTV.exe 并用 Inno Setup 打包，见 packaging\README.md"
