<#
  MFlixTV 电视桌面壁纸生成器
  ------------------------------------------------------------------
  数据来源：电视上正在跑的 MFlixTV 自己的 /api/home（片库「最近更新」那几排）
  做法：把当天的海报拼成一张马赛克，缩放两次做柔和模糊，再压一层暗渐变，
        出来就是 Netflix / Apple TV 那种「朦胧海报墙」背景。
  每天不重样：按当天日期做种子洗牌 + 换起点偏移，同一天内结果固定（不会乱闪）。

  用法（在电视能连上的电脑上跑）：
    pwsh tools\tv-wallpaper.ps1                       # 生成并推到电视，不设置
    pwsh tools\tv-wallpaper.ps1 -SetBackground       # 生成 + 设为 Projectivy 背景
    pwsh tools\tv-wallpaper.ps1 -Date 2026-11-01     # 指定某天的样子（调试用）

  前置：电视上 MFlixTV 在跑（8080），adb 已连（USB 或 adb connect IP:5555）
#>
[CmdletBinding()]
param(
  [string]$TvIp = "192.168.2.155",
  [int]$Port = 8080,
  [string]$Adb = "C:\Android\sdk\platform-tools\adb.exe",
  [string]$Date = "",
  [string]$OutDir = "D:\Build\launcher",
  [int]$Posters = 36,
  [int]$BlurDown = 16,
  [switch]$SetBackground
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function Log($m) { Write-Host "  $m" }

# ---------- 1. 取片库海报 ----------
$api = "http://${TvIp}:${Port}/api/home"
Write-Host "[1/5] 读取片库 $api"
$feed = Invoke-RestMethod -Uri $api -TimeoutSec 60
$pics = New-Object System.Collections.Generic.List[string]
foreach ($row in $feed.rows) {
  foreach ($it in $row.items) {
    if ($it.pic -and $it.pic -match '^https?://') { $pics.Add([string]$it.pic) }
  }
}
# 顺便把 pool 里的也捞进来（更多片子，墙更密）
foreach ($p in $feed.pool) {
  if ($p.pic -and $p.pic -match '^https?://') { $pics.Add([string]$p.pic) }
}
$pics = $pics | Select-Object -Unique
Log "拿到 $($pics.Count) 张海报地址"

if ($pics.Count -lt 6) { throw "海报太少（$($pics.Count) 张），片库可能没加载完，稍后再试" }

# ---------- 2. 按日期洗牌（每天不重样）----------
$day = if ($Date) { [datetime]$Date } else { Get-Date }
$seed = [int]($day.ToString("yyyyMMdd"))
$rnd = New-Object System.Random $seed
$deck = $pics | Sort-Object { $rnd.Next() }
# 起点也按天偏移，避免「只是换几张」而是整墙重排
$max = [Math]::Max(1, $deck.Count - $Posters)
$offset = $seed % $max
$pick = @()
for ($i = 0; $i -lt $Posters; $i++) { $pick += $deck[($offset + $i) % $deck.Count] }
Write-Host "[2/5] 今日种子 $seed，起点 $offset，取 $($pick.Count) 张"

# ---------- 3. 下载（走电视的 /api/proxy，省得处理防盗链）----------
function Get-Poster([string]$u) {
  # 先直连（电脑上一般最快），不行再让电视的 /api/proxy 代取（顺手绕过防盗链）
  $urls = @($u, "http://${TvIp}:${Port}/api/proxy?url=$([uri]::EscapeDataString($u))")
  foreach ($try in $urls) {
    try {
      $r = Invoke-WebRequest -Uri $try -UseBasicParsing -TimeoutSec 15
      if ($r.StatusCode -eq 200 -and $r.RawContentLength -gt 2000) {
        $ms = New-Object System.IO.MemoryStream(,$r.Content)
        return [System.Drawing.Image]::FromStream($ms)
      }
    } catch { }
  }
  return $null
}

Write-Host "[3/5] 下载海报"
$imgs = New-Object System.Collections.Generic.List[object]
$fail = 0
foreach ($u in $pick) {
  if ($imgs.Count -ge $Posters) { break }
  $im = $null
  for ($try = 0; $try -lt 2 -and -not $im; $try++) {
    try { $im = Get-Poster $u } catch { $im = $null }
  }
  if ($im) { $imgs.Add($im) } else { $fail++ }
}
Log "成功 $($imgs.Count) 张，失败 $fail 张"
if ($imgs.Count -lt 6) { throw "可用海报不足（$($imgs.Count)），放弃本次生成" }

# ---------- 4. 拼马赛克 + 朦胧 ----------
$W = 1920; $H = 1080
Write-Host "[4/5] 合成 $W×$H"

$mosaic = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($mosaic)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::FromArgb(12, 12, 14))

# 海报竖版 2:3，格子 260×390，7 列 4 行，隔行错开半个格子 —— 像片墙不是像表格
$cw = 260; $ch = 390
$cols = [Math]::Ceiling($W / $cw) + 1
$rows = [Math]::Ceiling($H / $ch) + 1
$k = 0
for ($ry = 0; $ry -lt $rows; $ry++) {
  $stagger = if ($ry % 2 -eq 0) { 0 } else { [int]($cw / 2) }
  for ($cx = -1; $cx -lt $cols; $cx++) {
    $im = $imgs[$k % $imgs.Count]; $k++
    $dx = $cx * $cw + $stagger
    $dy = $ry * $ch
    # cover 裁剪：source 取中间那块，铺满格子
    $sw = $im.Width; $sh = $im.Height
    $scale = [Math]::Max($cw / $sw, $ch / $sh)
    $srcW = [int]($cw / $scale); $srcH = [int]($ch / $scale)
    $srcX = [int](($sw - $srcW) / 2); $srcY = [int](($sh - $srcH) / 2)
    $g.DrawImage($im,
      (New-Object System.Drawing.Rectangle $dx, $dy, $cw, $ch),
      (New-Object System.Drawing.Rectangle $srcX, $srcY, $srcW, $srcH),
      [System.Drawing.GraphicsUnit]::Pixel)
  }
}
$g.Dispose()

# 两次缩放 = 廉价高斯：先缩到 1/12 再放大回来，边缘柔但不糊成一坨
$smallW = [int]($W / $BlurDown); $smallH = [int]($H / $BlurDown)
$small = New-Object System.Drawing.Bitmap $smallW, $smallH
$gs = [System.Drawing.Graphics]::FromImage($small)
$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$gs.DrawImage($mosaic, 0, 0, $smallW, $smallH)
$gs.Dispose(); $mosaic.Dispose()

$final = New-Object System.Drawing.Bitmap $W, $H
$gf = [System.Drawing.Graphics]::FromImage($final)
$gf.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gf.DrawImage($small, 0, 0, $W, $H)
$gf.Dispose(); $small.Dispose()

# 压暗 + 四角暗角，让上面那排应用和片名压得住
$g2 = [System.Drawing.Graphics]::FromImage($final)
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

# 整体压暗 30%（保留海报颜色，不至于死黑）
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(66, 0, 0, 0))
$g2.FillRectangle($dark, 0, 0, $W, $H)
$dark.Dispose()

# 上下渐变：顶部更暗（放状态/时钟），底部更暗（放应用行）
$topH = [int]($H * 0.42)
$topRect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $W, $topH
$topBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $topRect, [System.Drawing.Color]::FromArgb(225, 0, 0, 0), [System.Drawing.Color]::FromArgb(0, 0, 0, 0),
  [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g2.FillRectangle($topBrush, $topRect)
$topBrush.Dispose()

$botY = [int]($H * 0.55); $botH = [int]($H * 0.45)
$botRect = New-Object System.Drawing.Rectangle -ArgumentList 0, $botY, $W, $botH
$botBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $botRect, [System.Drawing.Color]::FromArgb(0, 0, 0, 0), [System.Drawing.Color]::FromArgb(248, 0, 0, 0),
  [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g2.FillRectangle($botBrush, $botRect)
$botBrush.Dispose()
$g2.Dispose()

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = $day.ToString("yyyyMMdd")
$localPng = Join-Path $OutDir "mflixtv-wall-$stamp.png"
$final.Save($localPng, [System.Drawing.Imaging.ImageFormat]::Png)
$final.Dispose()
foreach ($im in $imgs) { try { $im.Dispose() } catch {} }
$sizeKB = [int]((Get-Item $localPng).Length / 1KB)
Log "已生成 $localPng（$sizeKB KB）"

# ---------- 5. 推到电视 ----------
Write-Host "[5/5] 推到电视"
$serial = (& $Adb devices) | Select-String -Pattern '^\S+\s+device$' | ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1
if (-not $serial) { throw "没找到 adb 设备（先 adb connect ${TvIp}:5555 或插 USB）" }
Log "设备 $serial"

& $Adb -s $serial shell "mkdir -p /sdcard/Pictures/MFlixTV" | Out-Null
& $Adb -s $serial push $localPng "/sdcard/Pictures/MFlixTV/today.png" 2>&1 | Out-Null
& $Adb -s $serial shell "mkdir -p /sdcard/Pictures/MFlixTV/history" | Out-Null
& $Adb -s $serial push $localPng "/sdcard/Pictures/MFlixTV/history/$stamp.png" 2>&1 | Out-Null
Log "已推送 /sdcard/Pictures/MFlixTV/today.png"

# 让系统图库立刻看到这张图（否则其它应用的选择器里可能还不出现）
& $Adb -s $serial shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/MFlixTV/today.png" 2>&1 | Out-Null

if ($SetBackground) {
  Write-Host "打开 Projectivy 背景选择器…"
  & $Adb -s $serial shell "am start -n com.spocky.projengmenu/.ui.launcherActivities.SetBackgroundActivity" 2>&1 | Out-Null
  Log "在弹出的窗口里选「today.png」即可"
}

Write-Host ""
Write-Host "完成。今天的壁纸：$localPng"
