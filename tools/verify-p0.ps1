# P0 自证脚本（谁都能跑，输出即证据）
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-p0.ps1
#
# 2026-11-09 修订：上一版有三处度量缺陷，这一版改掉并补一条判据。
#   · 判据 1 原来只扫 com\mflixtv\app\*.kt（不递归），且统计"行数"不是"出现次数"
#     -> 改为整个 android\app\src\main 递归，按出现次数统计，同时列出命中文件数
#   · 判据 2 原来 archived 靠 isArchived 子串命中（字段删光了照样 HIT）
#     -> 改为词边界匹配，archived 与 isArchived 分开计数
#   · 新增判据 4：两端排序键必须逐键相同（这是"同一关键词两端顺序一致"的前提，
#     旧脚本只查"词在不在"，三个多余的键照样全绿）
param(
    [string]$Apk = 'D:\Build\Releases\最新\MFlixTV-Android.apk'
)

$repo     = Split-Path $PSScriptRoot -Parent
$srcRoot  = Join-Path $repo 'android\app\src\main'
$kt       = Join-Path $srcRoot 'java\com\mflixtv\app'
$pcSort   = Join-Path $repo 'app\src\lib\search-sort.ts'
$ktSources = Join-Path $kt 'Sources.kt'

function Read-Text([string]$p) { [System.IO.File]::ReadAllText($p) }

Write-Host '== 0. 当前版本 ==' -ForegroundColor Cyan
Push-Location $repo
$head = (git log --oneline -1) -join ''
Pop-Location
Write-Host ('commit  : ' + $head)
$gradle = Get-Content (Join-Path $repo 'android\app\build.gradle.kts') -Raw
$vc = [regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value
$vn = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
Write-Host ("android : versionCode $vc / versionName $vn")

Write-Host ''
Write-Host '== 1. 源码出现次数（android\app\src\main 递归，含 assets 之外的 .kt）==' -ForegroundColor Cyan
$words = 'dateSource', 'archived', 'isArchived', 'recencyYear', 'latestEpisodeDate', 'formatRemarks', 'titleRank'
$ktFiles = Get-ChildItem -Path $srcRoot -Recurse -Filter *.kt -File
Write-Host ("扫描文件: {0} 个 .kt" -f $ktFiles.Count)
$ok1 = $true
foreach ($w in $words) {
    # 词边界：archived 不再把 isArchived 算进来
    $pat = '(?<![A-Za-z0-9_])' + [regex]::Escape($w) + '(?![A-Za-z0-9_])'
    $occ = 0; $filesHit = 0
    foreach ($f in $ktFiles) {
        $m = [regex]::Matches((Read-Text $f.FullName), $pat).Count
        if ($m -gt 0) { $occ += $m; $filesHit++ }
    }
    if ($occ -eq 0) { $ok1 = $false }
    '{0,-18} 出现 {1,3} 次 / {2} 个文件' -f $w, $occ, $filesHit
}

Write-Host ''
Write-Host '== 2. 出包后 classes.dex 字符串 ==' -ForegroundColor Cyan
if (-not (Test-Path $Apk)) {
    Write-Host ('APK 不存在：' + $Apk) -ForegroundColor Red
    $ok2 = $false
}
else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $item = Get-Item $Apk
    'apk       : {0}  {1:N0} B  {2}' -f $item.Name, $item.Length, (Get-FileHash $item.FullName -Algorithm SHA256).Hash
    $z = [System.IO.Compression.ZipFile]::OpenRead($Apk)
    $e = $z.Entries | Where-Object { $_.Name -eq 'classes.dex' }
    $ms = New-Object System.IO.MemoryStream
    $s = $e.Open(); $s.CopyTo($ms); $s.Close()
    $bytes = $ms.ToArray(); $ms.Close(); $z.Dispose()
    Write-Host ('classes.dex: {0:N0} B' -f $bytes.Length)
    $txt = [System.Text.Encoding]::ASCII.GetString($bytes)
    $ok2 = $true
    foreach ($k in 'dateSource', 'archived', 'archivedCount', 'recencyYear', 'latestEpisodeDate', 'isArchived', 'titleRank', 'yearLabel', 'freshLabel') {
        # 同样用词边界，archived 不能靠 isArchived 混过去
        $pat = '(?<![A-Za-z0-9_])' + [regex]::Escape($k) + '(?![A-Za-z0-9_])'
        $n = [regex]::Matches($txt, $pat).Count
        if ($n -eq 0) { $ok2 = $false }
        '{0,-18} {1} ({2})' -f $k, $(if ($n -gt 0) { 'HIT' } else { 'MISS' }), $n
    }
}

Write-Host ''
Write-Host '== 3. /api/sources/health 字段（运行态，需设备）==' -ForegroundColor Cyan
$web = Join-Path $kt 'WebServer.kt'
$healthKt = Join-Path $kt 'SourceHealth.kt'
(Select-String -Path $web -Pattern '"/api/sources/health"').Line
Select-String -Path $healthKt -Pattern 'put\("dateSource"|put\("archived"' | ForEach-Object {
    'SourceHealth.kt:{0}: {1}' -f $_.LineNumber, $_.Line.Trim()
}
Write-Host '运行态取数：设备上 curl http://127.0.0.1:8080/api/sources/health 看每个源是否带 dateSource / archived'

Write-Host ''
Write-Host '== 4. 两端排序键逐键一致（安卓 Sources.kt vs 电脑端 search-sort.ts）==' -ForegroundColor Cyan
$ktText = Read-Text $ktSources
$pcText = Read-Text $pcSort

# --- 安卓：抓 sortedWith( ... ) 整段，再按出现顺序映射成规范键名
$mBlock = [regex]::Match($ktText, 'val sorted = out\.sortedWith\((?<body>[\s\S]*?)\n\s*\)')
if (-not $mBlock.Success) { Write-Host '找不到安卓排序块（val sorted = out.sortedWith(...)）' -ForegroundColor Red; $ktKeys = @() }
else {
    $body = $mBlock.Groups['body'].Value
    $ktKeys = @()
    $ktPat = 'Freshness\.titleRank|thenByDescending\s*\{\s*it\.optInt\("recencyYear"|thenBy\([A-Za-z]+\)\s*\{\s*it\.optString\("name"\)|thenBy\([A-Za-z]+\)\s*\{\s*it\.optString\("srcName"\)'
    foreach ($mm in [regex]::Matches($body, $ktPat)) {
        switch -Regex ($mm.Value) {
            'titleRank' { $ktKeys += 'titleRank' }
            'recencyYear' { $ktKeys += 'recencyYear:desc' }
            'optString\("name"\)' { $ktKeys += 'name:asc' }
            'srcName' { $ktKeys += 'sourceName:asc' }   # 安卓字段叫 srcName，PC 叫 sourceName，同一件事
        }
    }
    if ($body -match 'latestDate') { Write-Host '  安卓排序块里还有 latestDate 键（PC 没有，必须删）' -ForegroundColor Red; $ktKeys += 'latestDate:EXTRA' }
    if ($body -match 'remarks') { Write-Host '  安卓排序块里还有 remarks 键（PC 没有，必须删）' -ForegroundColor Red; $ktKeys += 'remarks:EXTRA' }
}

# --- 电脑端：抓 sortSearchResults 函数体
$mPc = [regex]::Match($pcText, 'export function sortSearchResults\([\s\S]*$')
if (-not $mPc.Success) { Write-Host '找不到 PC sortSearchResults' -ForegroundColor Red; $pcKeys = @() }
else {
    $pcBody = $mPc.Value
    $pcKeys = @()
    $pcPat = 'titleRank\(a\.name|sortYear\(b\)\s*-\s*sortYear\(a\)|localeCompare\(b\.name|localeCompare\(b\.sourceName'
    foreach ($mm in [regex]::Matches($pcBody, $pcPat)) {
        switch -Regex ($mm.Value) {
            'titleRank' { $pcKeys += 'titleRank' }
            'sortYear' { $pcKeys += 'recencyYear:desc' }
            'b\.name' { $pcKeys += 'name:asc' }
            'sourceName' { $pcKeys += 'sourceName:asc' }
        }
    }
}

$ktStr = $ktKeys -join ' > '
$pcStr = $pcKeys -join ' > '
Write-Host ('android : ' + $ktStr)
Write-Host ('PC      : ' + $pcStr)
$ok4 = ($ktKeys.Count -gt 0) -and (($ktKeys -join '|') -eq ($pcKeys -join '|'))
if (-not $ok4) { Write-Host '两端排序键不一致（多键、少键、顺序不同都算不一致）' -ForegroundColor Red }
else { Write-Host '两端排序键逐键一致' -ForegroundColor Green }

Write-Host ''
$pass = $ok1 -and $ok2 -and $ok4
if ($pass) { Write-Host '判据 1、2、4 通过（判据 3 需设备运行态）' -ForegroundColor Green }
else { Write-Host '判据 1 / 2 / 4 中有未通过的' -ForegroundColor Red; exit 1 }