# 测每个源的真实拉流速度：搜索 → 详情 → 并发抓 3 个分片 → KB/s
#
# 用法：powershell -ExecutionPolicy Bypass -File tools\bench-sources.ps1 [-Password 你的密码]
param(
  [string]$Base = 'http://127.0.0.1:8080',
  [string]$Password = 'MFlixTV'
)
$ErrorActionPreference = 'SilentlyContinue'
$base = $Base
$ck = "$env:TEMP\cdn_ck.txt"
$pw = '{"password":"' + $Password + '"}'
[IO.File]::WriteAllText("$env:TEMP\cdn_pw.json", $pw, [Text.UTF8Encoding]::new($false))
curl.exe -s --noproxy "*" -c $ck -X POST "$base/api/auth" -H "Content-Type: application/json" --data-binary "@$env:TEMP\cdn_pw.json" -o NUL

$sources = @(
  @{ n = '量子直连'; u = 'https://cj.lziapi.com/api.php/provide/vod' },
  @{ n = '鲨鱼'; u = 'https://shayuapi.com/api.php/provide/vod' },
  @{ n = '速播'; u = 'https://subocaiji.com/api.php/provide/vod' },
  @{ n = '非凡直连'; u = 'http://ffzy.tv/api.php/provide/vod' },
  @{ n = '魔都'; u = 'https://caiji.moduapi.cc/api.php/provide/vod' },
  @{ n = '暴风'; u = 'https://bfzyapi.com/api.php/provide/vod' },
  @{ n = '如意'; u = 'https://cj.rycjapi.com/api.php/provide/vod' },
  @{ n = '电影天堂'; u = 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
  @{ n = '非凡'; u = 'https://cj.ffzyapi.com/api.php/provide/vod' },
  @{ n = '百度'; u = 'https://api.apibdzy.com/api.php/provide/vod' },
  @{ n = '极速'; u = 'https://jszyapi.com/api.php/provide/vod' },
  @{ n = '红牛'; u = 'https://www.hongniuzy2.com/api.php/provide/vod' },
  @{ n = '豪华'; u = 'https://hhzyapi.com/api.php/provide/vod' },
  @{ n = '金鹰'; u = 'https://jyzyapi.com/api.php/provide/vod' }
)

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

foreach ($s in $sources) {
  $body = '{"wd":"流浪地球","sources":[{"name":"' + $s.n + '","url":"' + $s.u + '"}],"filterAdult":true}'
  [IO.File]::WriteAllText("$env:TEMP\cdn_q.json", $body, [Text.UTF8Encoding]::new($false))
  $sr = curl.exe -s --noproxy "*" -m 25 -b $ck -X POST "$base/api/search" -H "Content-Type: application/json" --data-binary "@$env:TEMP\cdn_q.json"
  $q = $sr | ConvertFrom-Json
  if (-not $q.list -or @($q.list).Count -eq 0) { "{0,-9} 搜索无结果" -f $s.n; continue }
  $hit = @($q.list | Where-Object { $_.name -like '流浪地球*' })[0]
  if (-not $hit) { $hit = @($q.list)[0] }

  $enc = [uri]::EscapeDataString('{"name":"' + $s.n + '","url":"' + $s.u + '"}')
  $d = (curl.exe -s --noproxy "*" -m 25 -b $ck "$base/api/detail?id=$($hit.vodId)&source=$enc") | ConvertFrom-Json
  $ep = $null
  if ($d.episodes -and @($d.episodes).Count -gt 0) { $ep = @($d.episodes)[0] }
  if (-not $ep) { "{0,-9} 无播放地址" -f $s.n; continue }

  $m3u8 = curl.exe -s --noproxy "*" -A $UA -m 12 $ep
  $lines = ($m3u8 -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }
  if (-not $lines) { "{0,-9} 清单为空" -f $s.n; continue }
  $baseUrl = $ep.Substring(0, $ep.LastIndexOf('/') + 1)
  $segs = @($lines | Select-Object -First 3 | ForEach-Object { if ($_ -match '^https?://') { $_ } else { $baseUrl + $_ } })

  $jobs = @()
  foreach ($sg in $segs) {
    $jobs += Start-Job -ScriptBlock { param($u, $ua) (curl.exe -s --noproxy "*" -A $ua -m 20 -o NUL -w "%{size_download}|%{time_total}" $u) } -ArgumentList $sg, $UA
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $res = $jobs | Wait-Job -Timeout 45 | Receive-Job
  $sw.Stop()
  $jobs | Remove-Job -Force
  $bytes = 0.0; $secs = 0.0
  foreach ($r in @($res)) { $p = "$r" -split '\|'; if ($p.Count -ge 2) { $bytes += [double]$p[0]; $secs = [Math]::Max($secs, [double]$p[1]) } }
  $kbs = 0; if ($secs -gt 0) { $kbs = [math]::Round(($bytes / 1KB) / $secs, 0) }
  "{0,-9} 片段 {1} 个 / {2,6} MB / 平均 {3,6} KB/s" -f $s.n, @($segs).Count, [math]::Round($bytes / 1MB, 2), $kbs
}
