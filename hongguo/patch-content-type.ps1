<#
.SYNOPSIS
    给 hongguo-web 内核打 content_type 透传补丁（幂等）。

.DESCRIPTION
    hongguo-web 解析上游数据时丢弃了 content_type（1=真人短剧，1004=漫剧/AI短剧），
    MFlixTV 短剧页靠它精确区分体裁。本脚本在 client.js 的两处解析函数各插一行。

    已有该字段则跳过；打补丁前留一份 .bak-content-type 备份。

.PARAMETER Target
    client.js 路径，默认 .\hongguo-web\server\src\service\client.js

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File hongguo\patch-content-type.ps1 -Target .\hongguo-web\server\src\service\client.js
#>
[CmdletBinding()]
param(
    [string]$Target = '.\hongguo-web\server\src\service\client.js'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Target)) {
    Write-Host "[x] 找不到 $Target" -ForegroundColor Red
    Write-Host "    先把内核克隆到旁边：git clone https://github.com/sunnysky123/hongguo-web hongguo-web"
    exit 1
}

$Target = (Resolve-Path -LiteralPath $Target).Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($Target, [System.Text.Encoding]::UTF8)

# ---- 补丁点定义：Anchor 之后插入 Insert ----
# 缩进刻意写死：锚点来自上游 1.1.x 的真实源码，缩进不匹配就不动文件（宁可失败也不写坏）。
$patches = @(
    @{
        Name   = '搜索结果/详情 content_type'
        Anchor = "  out.duration = num(vdata, 'duration');"
        Insert = @(
            '',
            '  // 体裁判别：1=真人短剧，1004=漫剧/AI短剧（上游唯一可靠的体裁信号）',
            "  out.content_type = num(vdata, 'content_type');"
        )
    },
    @{
        Name   = '榜单分页 content_type'
        Anchor = "      row.abstract = strip(str(v, 'video_desc'), 50);"
        Insert = @( "      row.content_type = num(v, 'content_type');" )
    }
)

$applied = 0
$skipped = 0
$missing = @()

foreach ($p in $patches) {
    # 幂等判据：插入内容的首行特征已存在即视为已打
    $probe = ($p.Insert | Where-Object { $_ -match 'content_type' } | Select-Object -First 1).Trim()
    if ($text.Contains($probe)) {
        Write-Host "[=] 已是最新：$($p.Name)"
        $skipped++
        continue
    }
    if (-not $text.Contains($p.Anchor)) {
        $missing += $p.Name
        Write-Host "[!] 锚点未找到：$($p.Name)" -ForegroundColor Yellow
        continue
    }
    $replacement = $p.Anchor + "`r`n" + ($p.Insert -join "`r`n")
    $text = $text.Replace($p.Anchor, $replacement)
    Write-Host "[+] 已插入：$($p.Name)" -ForegroundColor Green
    $applied++
}

if ($applied -gt 0) {
    $bak = $Target + '.bak-content-type'
    if (-not (Test-Path -LiteralPath $bak)) {
        Copy-Item -LiteralPath $Target -Destination $bak
        Write-Host "[i] 备份：$bak"
    }
    [System.IO.File]::WriteAllText($Target, $text, $utf8)
    Write-Host "[✓] 补丁完成（$applied 处），重启内核生效。"
}
elseif ($skipped -gt 0 -and $missing.Count -eq 0) {
    Write-Host "[✓] 无需改动。"
}
else {
    Write-Host "[x] 有 $($missing.Count) 处锚点没匹配上，文件未改动。" -ForegroundColor Red
    Write-Host "    多半是上游改了这版解析代码，打开 client.js 手动加一行：" -ForegroundColor Red
    Write-Host "    out.content_type = num(vdata, 'content_type');" -ForegroundColor Red
    Write-Host "    row.content_type = num(v, 'content_type');" -ForegroundColor Red
    exit 2
}
