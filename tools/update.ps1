<#
    lihongguotv 热更新工具
    ------------------------------------------------------------------
    用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Part all
      powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Part kernel
      powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Part sources
      powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Part all -Silent

    - kernel ：拉取 hongguo-web 最新源码，替换短剧内核，并重新打上 content_type 补丁
    - sources：内置池 + 现有配置 + 公开列表里的新源，探活后写回 app\.env
    - 两者都会在结束后按需重启对应服务；配置没变化时不重启
#>
param(
  [ValidateSet('all', 'kernel', 'sources')]
  [string]$Part = 'all',
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- 路径探测
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir

$packaged = Test-Path (Join-Path $root 'app\node_modules\next\dist\bin\next')
if ($packaged) {
  $appDir    = Join-Path $root 'app'
  $hgDir     = Join-Path $root 'hongguo'
  $nodeExe   = Join-Path $root 'runtime\node.exe'
  $ffmpegBin = Join-Path $root 'runtime\ffmpeg'
  $envFile   = Join-Path $appDir '.env'
} else {
  $appDir  = $root
  $hgDir   = Join-Path (Split-Path $root -Parent) 'hongguo-web'
  $nodeExe = $null
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
  $ffmpegBin = $null
  $ffCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ffCmd) { $ffmpegBin = Split-Path -Parent $ffCmd.Source }
  $envFile = Join-Path $appDir '.env'
}

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'update.log'
$script:SourceRestartNeeded = $false

function Log([string]$msg, [string]$level = 'INFO') {
  $line = ('{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $level, $msg)
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  if (-not $Silent) { Write-Host $line }
}

function Finish([string]$summary, [bool]$ok) {
  Log $summary ($(if ($ok) { 'OK' } else { 'FAIL' }))
  if ($Silent) {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.MessageBox]::Show(
      ($summary + "`r`n`r`n日志：$logFile"),
      'lihongguotv 更新',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      $(if ($ok) { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Warning })
    ) | Out-Null
  }
  exit $(if ($ok) { 0 } else { 1 })
}

# ---------------------------------------------------------------- 进程工具
function Get-PortPid([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return ($c | Select-Object -First 1).OwningProcess }
  } catch { }
  return 0
}

function Stop-Port([int]$port) {
  $procId = Get-PortPid $port
  if ($procId -gt 0) {
    Log "结束占用 $port 的进程 $procId"
    & taskkill /PID $procId /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
  }
}

function Wait-Port([int]$port, [int]$timeoutSec = 40) {
  for ($i = 0; $i -lt ($timeoutSec * 2); $i++) {
    if ((Get-PortPid $port) -gt 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-Hongguo {
  $main = Join-Path $hgDir 'server\src\main.js'
  if (-not (Test-Path $main)) { Log "找不到短剧入口 $main" 'WARN'; return }
  $oldPath = $env:PATH
  if (Test-Path $ffmpegBin) { $env:PATH = "$ffmpegBin;$env:PATH" }
  $env:PORT = '8000'
  $env:BIND_HOST = '127.0.0.1'
  $env:HG_TRANSCODE = '1'
  $env:HG_OPEN_BROWSER = '0'
  $env:HG_CACHE_MAX_FILES = '120'
  $p = Start-Process -FilePath $nodeExe -ArgumentList @($main) -WorkingDirectory $hgDir -WindowStyle Hidden -PassThru `
       -RedirectStandardOutput (Join-Path $hgDir 'hg.log') -RedirectStandardError (Join-Path $hgDir 'hg.err.log')
  $env:PATH = $oldPath
  Log "短剧服务已启动 (pid $($p.Id))"
}

function Start-Web {
  $next = Join-Path $appDir 'node_modules\next\dist\bin\next'
  if (-not (Test-Path $next)) { Log "找不到 Next 入口 $next" 'WARN'; return }
  $p = Start-Process -FilePath $nodeExe -ArgumentList @($next, 'start', '-p', '8080') -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
       -RedirectStandardOutput (Join-Path $appDir 'server.log') -RedirectStandardError (Join-Path $appDir 'server.err.log')
  Log "lihongguotv 已启动 (pid $($p.Id))"
}

# ---------------------------------------------------------------- 内核更新
$MIRRORS = @(
  'https://codeload.github.com/sunnysky123/hongguo-web/zip/refs/heads/main',
  'https://gh-proxy.com/https://github.com/sunnysky123/hongguo-web/archive/refs/heads/main.zip',
  'https://ghfast.top/https://github.com/sunnysky123/hongguo-web/archive/refs/heads/main.zip',
  'https://ghproxy.net/https://github.com/sunnysky123/hongguo-web/archive/refs/heads/main.zip'
)

function Get-Remote([string]$url, [string]$outFile) {
  try {
    $old = [Net.ServicePointManager]::SecurityProtocol
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $outFile -TimeoutSec 90 -UseBasicParsing
    [Net.ServicePointManager]::SecurityProtocol = $old
    return $true
  } catch {
    Log "下载失败 $url ：$($_.Exception.Message)" 'WARN'
    return $false
  }
}

function Update-ContentTypePatch {
  $client = Join-Path $hgDir 'server\src\service\client.js'
  if (-not (Test-Path $client)) { Log '找不到 client.js，跳过补丁' 'WARN'; return }
  $txt = Get-Content $client -Raw -Encoding UTF8
  $changed = $false

  if ($txt -notmatch 'out\.content_type\s*=') {
    $anchor = "  out.horiz_cover = str(vdata, 'horiz_cover');"
    if ($txt.Contains($anchor)) {
      $rep = $anchor + "`r`n  // 体裁判别：1=真人短剧，1004=漫剧/AI短剧`r`n  out.content_type = num(vdata, 'content_type');"
      $txt = $txt.Replace($anchor, $rep)
      $changed = $true
    } else {
      Log '搜索行锚点没找到，content_type 补丁可能失效（上游改结构了）' 'WARN'
    }
  }

  if ($txt -notmatch 'row\.content_type\s*=') {
    $anchor2 = "      row.abstract = strip(str(v, 'video_desc'), 50);"
    if ($txt.Contains($anchor2)) {
      $txt = $txt.Replace($anchor2, $anchor2 + "`r`n      row.content_type = num(v, 'content_type');")
      $changed = $true
    }
  }

  if ($changed) { Set-Content -Path $client -Value $txt -Encoding UTF8 -NoNewline }
}

function Invoke-KernelUpdate {
  Log '===== 检查短剧内核更新 ====='
  $tmp = Join-Path $env:TEMP ('hg-update-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'

  $ok = $false
  foreach ($m in $MIRRORS) {
    Log "尝试下载：$m"
    if (Get-Remote $m $zip) { $ok = $true; break }
  }
  if (-not $ok) { Log '所有下载源都失败（网络/代理问题）' 'FAIL'; return $false }

  try { Expand-Archive -Path $zip -DestinationPath $tmp -Force } catch { Log "解压失败：$($_.Exception.Message)" 'FAIL'; return $false }

  $inner = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'server\src\main.js') } | Select-Object -First 1
  if (-not $inner) { Log '压缩包里找不到 server/src/main.js' 'FAIL'; return $false }

  $newVer = ''
  $pkgPath = Join-Path $inner.FullName 'package.json'
  if (Test-Path $pkgPath) { try { $newVer = (Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { } }
  $curPkg = Join-Path $hgDir 'package.json'
  $curVer = ''
  if (Test-Path $curPkg) { try { $curVer = (Get-Content $curPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { } }
  Log "本地内核 $curVer → 远端 $newVer"

  $bak = Join-Path $hgDir ('server\src.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  if (Test-Path (Join-Path $hgDir 'server\src')) {
    Copy-Item (Join-Path $hgDir 'server\src') $bak -Recurse -Force
    Log "已备份旧内核到 $bak"
  }

  Remove-Item (Join-Path $hgDir 'server\src') -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $inner.FullName 'server\src') (Join-Path $hgDir 'server\src') -Recurse -Force
  if (Test-Path $pkgPath) { Copy-Item $pkgPath $curPkg -Force }
  if (Test-Path (Join-Path $inner.FullName 'web')) { Copy-Item (Join-Path $inner.FullName 'web') (Join-Path $hgDir 'web') -Recurse -Force }
  Log '内核文件已替换'

  Update-ContentTypePatch
  Log '已重新打上 content_type 补丁'

  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  return $true
}

# ---------------------------------------------------------------- 远程源列表
# 源站会持续失效，光靠内置池会越用越少，所以每次体检都去公开配置里补新源
$REMOTE_LISTS = @(
  @{ name = 'qist-tvbox'; url = 'https://raw.githubusercontent.com/qist/tvbox/master/jsm.json' },
  @{ name = 'gao-0827'; url = 'https://raw.githubusercontent.com/gaotianliuyun/gao/master/0827.json' },
  @{ name = 'gao-0825'; url = 'https://raw.githubusercontent.com/gaotianliuyun/gao/master/0825.json' }
)
$REMOTE_MIRRORS = @('', 'https://gh-proxy.com/', 'https://ghfast.top/')

function Get-SrcKey([string]$u) {
  try {
    $x = [uri]$u
    return ($x.Host + $x.AbsolutePath).ToLowerInvariant().TrimEnd('/')
  } catch {
    return $u
  }
}

function Test-PrivateUrl([string]$u) {
  if ($u -notmatch '^https?://') { return $true }
  $hostPart = ([uri]$u).Host
  if ($hostPart -match '^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)') { return $true }
  return $false
}

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function Get-RemoteCmsSources {
  $found = New-Object System.Collections.ArrayList
  foreach ($list in $REMOTE_LISTS) {
    $ok = $false
    foreach ($mirror in $REMOTE_MIRRORS) {
      if ($ok) { break }
      $target = $mirror + $list.url
      try {
        $raw = Invoke-WebRequest -Uri $target -TimeoutSec 25 -UseBasicParsing -Headers @{ 'User-Agent' = $UA }
        $json = $raw.Content | ConvertFrom-Json
        $sites = @($json.sites)
        if ($sites.Count -eq 0) { continue }
        $before = $found.Count
        foreach ($s in $sites) {
          $api = [string]$s.api
          if ([string]::IsNullOrWhiteSpace($api)) { continue }
          if ($api -notmatch 'api\.php') { continue }
          # 去掉 ?ac=list 之类尾巴：留着会和后面拼的 ?ac=videolist 形成双问号
          $api = ($api -split '\?')[0].Trim().TrimEnd('/')
          if (Test-PrivateUrl $api) { continue }
          if ($found | Where-Object { (Get-SrcKey $_.u) -eq (Get-SrcKey $api) }) { continue }
          $name = [string]$s.name
          if ([string]::IsNullOrWhiteSpace($name)) { $name = ([uri]$api).Host }
          $name = ($name -replace '[\s\|｜•·]+', ' ').Trim()
          if ($name.Length -gt 12) { $name = $name.Substring(0, 12) }
          [void]$found.Add(@{ n = $name; u = $api })
        }
        $ok = $true
        Log ("远程列表 {0}：新增 {1} 个候选" -f $list.name, ($found.Count - $before))
      } catch {
        Log ("远程列表 {0} 经 {1} 失败：{2}" -f $list.name, $(if ($mirror) { $mirror } else { '直连' }), $_.Exception.Message) 'WARN'
      }
    }
  }
  Log ("远程候选合计 {0} 个" -f $found.Count)
  return $found
}

# ---------------------------------------------------------------- 内置候选池
$VOD_POOL = @(
  @{ n = '极速资源'; u = 'https://jszyapi.com/api.php/provide/vod' },
  @{ n = '速播资源'; u = 'https://subocaiji.com/api.php/provide/vod' },
  @{ n = '红牛资源'; u = 'https://www.hongniuzy2.com/api.php/provide/vod' },
  @{ n = '豪华资源'; u = 'https://hhzyapi.com/api.php/provide/vod' },
  @{ n = '金鹰资源'; u = 'https://jyzyapi.com/api.php/provide/vod' },
  @{ n = '暴风资源'; u = 'https://bfzyapi.com/api.php/provide/vod' },
  @{ n = '非凡资源'; u = 'https://cj.ffzyapi.com/api.php/provide/vod' },
  @{ n = '飞飞资源'; u = 'https://api.ffzyapi.com/api.php/provide/vod' },
  @{ n = '光速资源'; u = 'https://api.guangsuapi.com/api.php/provide/vod' },
  @{ n = '魔都资源'; u = 'https://caiji.moduapi.cc/api.php/provide/vod' },
  @{ n = '360资源'; u = 'https://360zy.com/api.php/provide/vod' },
  @{ n = '无尽资源'; u = 'https://api.wujinapi.com/api.php/provide/vod' },
  @{ n = '快车资源'; u = 'https://caiji.kczyapi.com/api.php/provide/vod' },
  @{ n = '卧龙资源'; u = 'https://collect.wolongzyw.com/api.php/provide/vod' },
  @{ n = '如意资源'; u = 'https://cj.rycjapi.com/api.php/provide/vod' },
  @{ n = '天涯资源'; u = 'https://tyyszy.com/api.php/provide/vod' },
  @{ n = '索尼资源'; u = 'https://suoniapi.com/api.php/provide/vod' },
  @{ n = '快看资源'; u = 'https://kuaikan-api.com/api.php/provide/vod' },
  @{ n = '天空资源'; u = 'https://api.tiankongapi.com/api.php/provide/vod' },
  @{ n = '茅台资源'; u = 'https://api.maotaizy.cc/api.php/provide/vod' },
  @{ n = '鲨鱼资源'; u = 'https://shayuapi.com/api.php/provide/vod' },
  @{ n = '新浪资源'; u = 'https://api.xinlangapi.com/api.php/provide/vod' },
  @{ n = '虎牙资源'; u = 'https://www.huyaapi.com/api.php/provide/vod' },
  @{ n = '闪电资源'; u = 'https://sdzyapi.com/api.php/provide/vod' }
)

# 2026-10-24 实测拉流快的站（tools/bench.log）：排在最前，避免"搜得快但播得卡"的站上位
$FAST_HOSTS = @('jszyapi.com', 'bfzyapi.com', 'hhzyapi.com', 'apibdzy.com', 'subocaiji.com', 'moduapi.cc', 'wujinapi.com')

function Get-SourcePrio([string]$u) {
  try {
    $h = ([uri]$u).Host.ToLowerInvariant()
    foreach ($f in $FAST_HOSTS) { if ($h -eq $f -or $h.EndsWith('.' + $f)) { return 0 } }
    return 1
  } catch {
    return 2
  }
}

# ---------------------------------------------------------------- 点播源体检
function Invoke-SourceUpdate {
  Log '===== 探测点播源 ====='
  $pool = New-Object System.Collections.ArrayList
  foreach ($x in $VOD_POOL) { [void]$pool.Add($x) }

  # 1) 现有配置里的源优先保留：一次探测抖动不该把好源挤掉
  if (Test-Path $envFile) {
    try {
      $cur = Get-Content $envFile -Raw -Encoding UTF8
      $m = [regex]::Match($cur, '(?m)^DEFAULT_SOURCES=(.+)$')
      if ($m.Success) {
        $parsedCur = ConvertFrom-Json -InputObject $m.Groups[1].Value
        foreach ($s in @($parsedCur)) {
          if ([string]::IsNullOrWhiteSpace($s.url)) { continue }
          if ($pool | Where-Object { (Get-SrcKey $_.u) -eq (Get-SrcKey $s.url) }) { continue }
          [void]$pool.Add(@{ n = $(if ($s.name) { [string]$s.name } else { '原有源' }); u = [string]$s.url })
        }
      }
    } catch {
      Log '解析现有 DEFAULT_SOURCES 失败，跳过合并' 'WARN'
    }
  }

  # 2) 从公开列表补新源（源站会持续失效，靠这一步保持"永远有能用"的）
  try {
    foreach ($r in (Get-RemoteCmsSources)) {
      if (-not ($pool | Where-Object { (Get-SrcKey $_.u) -eq (Get-SrcKey $r.u) })) { [void]$pool.Add($r) }
    }
  } catch {
    Log ('远程候选获取失败：' + $_.Exception.Message) 'WARN'
  }

  if ($pool.Count -gt 80) { $pool = $pool[0..79] }
  Log ("候选池 {0} 个（内置 {1} + 现有 + 远程）" -f $pool.Count, $VOD_POOL.Count)

  $results = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $pool.Count; $i += 6) {
    $batch = $pool[$i..([Math]::Min($i + 5, $pool.Count - 1))]
    $jobs = @()
    foreach ($item in $batch) {
      $jobs += Start-Job -ScriptBlock {
        param($u, $n)
        $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $OutputEncoding = [Text.Encoding]::UTF8
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $probe = $u + $(if ($u.Contains('?')) { '&' } else { '?' }) + 'ac=videolist&wd=' + [uri]::EscapeDataString('庆余年')
        try {
          $txt = (curl.exe -s -m 12 -A $ua $probe) -join ''
          $sw.Stop()
          if (-not $txt) { return [pscustomobject]@{ Name = $n; Url = $u; Ms = [int]$sw.ElapsedMilliseconds; Count = 0; Ok = $false } }
          $obj = $txt | ConvertFrom-Json
          if ($null -eq $obj.list) { return [pscustomobject]@{ Name = $n; Url = $u; Ms = [int]$sw.ElapsedMilliseconds; Count = 0; Ok = $false } }
          # 只认"名字里真含关键词"的条目：有的站忽略 wd 返回固定内容
          $hits = @($obj.list | Where-Object { $_.vod_name -and ([string]$_.vod_name).Contains('庆余年') }).Count
          return [pscustomobject]@{ Name = $n; Url = $u; Ms = [int]$sw.ElapsedMilliseconds; Count = $hits; Ok = $true }
        } catch {
          $sw.Stop()
          return [pscustomobject]@{ Name = $n; Url = $u; Ms = [int]$sw.ElapsedMilliseconds; Count = 0; Ok = $false }
        }
      } -ArgumentList $item.u, $item.n
    }
    $null = Wait-Job -Job $jobs -Timeout 40
    foreach ($j in $jobs) {
      $r = Receive-Job -Job $j -ErrorAction SilentlyContinue
      if ($r) { [void]$results.Add($r) }
      Remove-Job -Job $j -Force -ErrorAction SilentlyContinue
    }
  }

  $alive = $results | Where-Object { $_.Ok } | ForEach-Object {
    [pscustomobject]@{
      Name  = $_.Name
      Url   = $_.Url
      Ms    = $_.Ms
      Count = $_.Count
      Prio  = (Get-SourcePrio $_.Url)
    }
  } | Sort-Object Prio, @{ Expression = { if ($_.Count -gt 0) { 0 } else { 1 } } }, Ms

  $fastCount = @($alive | Where-Object { $_.Prio -eq 0 }).Count
  Log ("可用 {0} / {1} 个源（已知快源 {2} 个）" -f @($alive).Count, @($results).Count, $fastCount)
  foreach ($a in $alive) {
    Log ("  {0,-14} {1,5}ms  命中 {2,2}  {3}{4}" -f $a.Name, $a.Ms, $a.Count, $(if ($a.Prio -eq 0) { '[快] ' } else { '' }), $a.Url)
  }

  if (@($alive).Count -lt 3) {
    Log '可用源不足 3 个，保留原配置不覆盖' 'WARN'
    return $false
  }

  # ---- 保守更新：现役源只要还活着就原样保留，只做"替补"不做"重排" ----
  $currentList = @()
  if (Test-Path $envFile) {
    try {
      $cur = Get-Content $envFile -Raw -Encoding UTF8
      $mm0 = [regex]::Match($cur, '(?m)^DEFAULT_SOURCES=(.+)$')
      if ($mm0.Success) { $currentList = @(ConvertFrom-Json -InputObject $mm0.Groups[1].Value) }
    } catch { }
  }

  $aliveMap = @{}
  foreach ($a in $alive) { $aliveMap[(Get-SrcKey $a.Url)] = $a }

  # 先数现役源这次失活几个：1~2 个是探测抖动，不该因此换整张表、重启服务
  $deadCurrent = 0
  foreach ($cc in $currentList) {
    if ([string]::IsNullOrWhiteSpace($cc.url)) { continue }
    if (-not $aliveMap.ContainsKey((Get-SrcKey $cc.url))) { $deadCurrent++ }
  }
  if (@($currentList).Count -ge 3 -and $deadCurrent -lt 3) {
    Log ("现役源基本健康（本次失活 {0} 个，阈值 3），保持原配置不动" -f $deadCurrent)
    $script:SourceRestartNeeded = $false
    return $true
  }
  if ($deadCurrent -gt 0) { Log ("现役源失活 {0} 个，触发自愈重建" -f $deadCurrent) 'WARN' }
  $final = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($c in $currentList) {
    if ([string]::IsNullOrWhiteSpace($c.url)) { continue }
    $k = Get-SrcKey $c.url
    if ($aliveMap.ContainsKey($k)) {
      [void]$final.Add(@{ n = $(if ($c.name) { [string]$c.name } else { '原有源' }); u = [string]$c.url })
      $seen[$k] = $true
    } else {
      Log ("  现役源失活，准备替补：{0}" -f $c.url) 'WARN'
    }
  }

  $addedCount = 0
  foreach ($a in $alive) {
    if ($final.Count -ge 6) { break }
    $k = Get-SrcKey $a.Url
    if ($seen.ContainsKey($k)) { continue }
    [void]$final.Add(@{ n = $a.Name; u = $a.Url })
    $seen[$k] = $true
    $addedCount++
  }
  if ($addedCount -gt 0) { Log ("补充 {0} 个新源" -f $addedCount) }

  $pick = $final
  $json = '[' + (($pick | ForEach-Object { '{"name":"' + $_.n + '","url":"' + $_.u + '"}' }) -join ',') + ']'

  if (-not (Test-Path $envFile)) { Log "找不到 $envFile" 'FAIL'; return $false }
  $envText = Get-Content $envFile -Raw -Encoding UTF8

  # 只比对 URL 集合：完全一致就不写盘、不重启
  $oldKeys = (@($currentList | ForEach-Object { Get-SrcKey $_.url } | Sort-Object) -join ',')
  $newKeys = (@($pick | ForEach-Object { Get-SrcKey $_.u } | Sort-Object) -join ',')

  if ($oldKeys -eq $newKeys) {
    Log '现役源全部健康，无需调整（不写盘、不重启）'
    $script:SourceRestartNeeded = $false
    return $true
  }

  if ($envText -match '(?m)^DEFAULT_SOURCES=.*$') {
    $envText = [regex]::Replace($envText, '(?m)^DEFAULT_SOURCES=.*$', ('DEFAULT_SOURCES=' + $json))
  } else {
    $envText = $envText.TrimEnd() + "`r`n`r`nDEFAULT_SOURCES=$json`r`n"
  }
  Set-Content -Path $envFile -Value $envText -Encoding UTF8 -NoNewline
  Log "已写入 $envFile ：保留 $($pick.Count) 个源"
  # 只有"当前源已经不够用"才重启；否则新配置下次启动生效，不打断正在看的人
  $curAliveCount = @($currentList).Count - $deadCurrent
  if ($curAliveCount -lt 3) {
    Log ("当前源仅剩 {0} 个可用，需要立即重启生效" -f $curAliveCount) 'WARN'
    $script:SourceRestartNeeded = $true
  } else {
    Log '配置已更新，下次启动生效（当前源仍可用，不重启打断）'
    $script:SourceRestartNeeded = $false
  }
  return $true
}

# ---------------------------------------------------------------- 主流程
try {
  Log "===== 开始更新（模式：$Part，布局：$(if($packaged){'安装版'}else{'开发版'})）====="

  $kernelChanged = $false
  $sourceChanged = $false

  if ($Part -eq 'all' -or $Part -eq 'kernel') {
    $kernelChanged = Invoke-KernelUpdate
    if ($kernelChanged) {
      Stop-Port 8000
      Start-Sleep -Seconds 1
      Start-Hongguo
      if (Wait-Port 8000 30) { Log '短剧服务已就绪' } else { Log '短剧服务启动超时' 'WARN' }
    }
  }

  if ($Part -eq 'all' -or $Part -eq 'sources') {
    $sourceChanged = Invoke-SourceUpdate
    if ($sourceChanged -and $script:SourceRestartNeeded) {
      Stop-Port 8080
      Start-Sleep -Seconds 1
      Start-Web
      if (Wait-Port 8080 40) { Log 'lihongguotv 已就绪' } else { Log 'lihongguotv 启动超时' 'WARN' }
    }
  }

  $msg = @()
  if ($Part -eq 'all' -or $Part -eq 'kernel') { $msg += ('短剧内核：' + $(if ($kernelChanged) { '已更新' } else { '未更新（下载失败或已是新版）' })) }
  if ($Part -eq 'all' -or $Part -eq 'sources') { $msg += ('点播源：' + $(if ($sourceChanged) { '已刷新' } else { '未更新（可用源不足）' })) }
  Finish ($msg -join "`r`n") ($kernelChanged -or $sourceChanged)
}
catch {
  Log "异常：$($_.Exception.Message)" 'FAIL'
  Finish ("更新出错：" + $_.Exception.Message) $false
}
