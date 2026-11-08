# P0 四项自证脚本（谁都能跑，输出即证据）
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-p0.ps1
# 判据（Chief 定）：
#   1) 源码 grep 命中数非 0
#   2) 出包后 classes.dex 里能搜到 dateSource 等字符串
#   3) /api/sources/health 每源带 dateSource / archived（运行态，需设备，本脚本只打印代码路径）
param(
    [string]$Apk = 'D:\Build\Releases\最新\MFlixTV-Android.apk'
)

$repo = Split-Path $PSScriptRoot -Parent
$kt = Join-Path $repo 'android\app\src\main\java\com\mflixtv\app'

Write-Host '== 0. 当前版本 ==' -ForegroundColor Cyan
Push-Location $repo
$head = (git log --oneline -1) -join ''
Pop-Location
Write-Host ("commit  : " + $head)
$gradle = Get-Content (Join-Path $repo 'android\app\build.gradle.kts') -Raw
$vc = [regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value
$vn = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
Write-Host ("android : versionCode $vc / versionName $vn")

Write-Host ''
Write-Host '== 1. 源码命中数（android/app/src/main/java 递归）==' -ForegroundColor Cyan
$words = 'dateSource', 'archived', 'recencyYear', 'latestEpisodeDate', 'isArchived', 'formatRemarks', 'titleRank'
$ok1 = $true
foreach ($w in $words) {
    $n = (Select-String -Path (Join-Path $kt '*.kt') -Pattern $w -AllMatches | Measure-Object).Count
    if ($n -eq 0) { $ok1 = $false }
    '{0,-18} {1}' -f $w, $n
}

Write-Host ''
Write-Host '== 2. 出包后 classes.dex 字符串 ==' -ForegroundColor Cyan
if (-not (Test-Path $Apk)) {
    Write-Host ("APK 不存在：" + $Apk) -ForegroundColor Red
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
    Write-Host ("classes.dex: {0:N0} B" -f $bytes.Length)
    $txt = [System.Text.Encoding]::ASCII.GetString($bytes)
    $ok2 = $true
    foreach ($k in 'dateSource', 'archived', 'archivedCount', 'recencyYear', 'latestEpisodeDate', 'isArchived', 'titleRank', 'yearLabel', 'freshLabel') {
        $hit = $txt.Contains($k)
        if (-not $hit) { $ok2 = $false }
        $label = 'MISS'
        if ($hit) { $label = 'HIT' }
        '{0,-18} {1}' -f $k, $label
    }
}

Write-Host ''
Write-Host '== 3. /api/sources/health 字段（运行态，需设备）==' -ForegroundColor Cyan
$web = Join-Path $kt 'WebServer.kt'
$health = Join-Path $kt 'SourceHealth.kt'
(Select-String -Path $web -Pattern '"/api/sources/health"').Line
Select-String -Path $health -Pattern 'put\("dateSource"|put\("archived"' | ForEach-Object {
    "SourceHealth.kt:{0}: {1}" -f $_.LineNumber, $_.Line.Trim()
}
Write-Host '运行态取数：设备上 curl http://127.0.0.1:8080/api/sources/health 看每个源是否带 dateSource / archived'

Write-Host ''
$pass = $ok1 -and $ok2
if ($pass) { Write-Host '判据 1、2 通过（3 需设备运行态）' -ForegroundColor Green }
else { Write-Host '判据 1 或 2 未通过' -ForegroundColor Red; exit 1 }
