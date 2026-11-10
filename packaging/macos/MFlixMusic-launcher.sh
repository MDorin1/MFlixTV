#!/bin/bash
# MFlix Music · macOS 启动器（3.19 重写，替换 workflow 里 cat > ... <<'LAUNCH' 那段）
#
# 修的三件事：
#  1) 单实例复用：先扫 8090-8129，谁回 /api/ping 就认谁是我自己，直接复用，
#     不再起第二个 node。旧版一路往上找空端口，永远不复用。
#  2) 开窗不再抢锁：开窗前只在「没有活着的同 profile 进程」时清 Singleton 锁，
#     并给窗口地址带上 appwin=1，前端据此在关窗时通知服务端退出。
#  3) 失败要说话：浏览器起不来、服务没起来都 alert，且把地址写进剪贴板。
#
# 另外数据目录挪到 ~/Library/Application Support/MFlixMusic/data，
# .app 整包替换升级时收藏和歌单不会再跟着丢。
set -u

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PAY="$RES/payload"
STATE="$HOME/Library/Application Support/MFlixMusic"
LOGDIR="$HOME/Library/Logs/MFlixMusic"
mkdir -p "$LOGDIR" "$STATE/data"
LOG="$LOGDIR/mflix-music.log"

notify() { /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true; }
alert() { /usr/bin/osascript -e "display alert \"MFlix Music\" message \"$1\"" >/dev/null 2>&1 || true; }

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') app launch ==="
  echo "app=$RES payload=$PAY"
} >> "$LOG"

/usr/bin/xattr -dr com.apple.quarantine "$RES" 2>/dev/null || true

if [ "$(uname -m)" = "arm64" ]; then NODE="$RES/runtime/node-arm64"; else NODE="$RES/runtime/node-x64"; fi
if [ ! -x "$NODE" ]; then
  /bin/chmod +x "$RES/runtime/node-arm64" "$RES/runtime/node-x64" 2>/dev/null
fi
if [ ! -x "$NODE" ]; then
  alert "安装不完整：找不到内置的 Node 运行时，请重新下载安装包。"
  exit 3
fi

# 这个端口上跑的是不是我自己？
ping_is_mine() {
  local out
  out="$(/usr/bin/curl -s --max-time 1 "http://127.0.0.1:$1/api/ping" 2>/dev/null || true)"
  case "$out" in
    *'"app":"mflix-music"'*) return 0 ;;
    *) return 1 ;;
  esac
}

REUSE=""
PORT=""
for p in $(/usr/bin/seq 8090 8129); do
  if /usr/bin/nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then
    if ping_is_mine "$p"; then REUSE="$p"; break; fi
    continue
  fi
  PORT="$p"
  break
done

PID=""
if [ -n "$REUSE" ]; then
  PORT="$REUSE"
  echo "$(date '+%H:%M:%S') reuse existing server port=$PORT" >> "$LOG"
else
  if [ -z "$PORT" ]; then
    alert "8090 附近的端口都被别的程序占用了，先关掉占口的程序再启动。"
    exit 4
  fi
  echo "$(date '+%H:%M:%S') start server port=$PORT data=$STATE/data" >> "$LOG"
  cd "$PAY" || { alert "安装不完整：payload 目录缺失。"; exit 5; }
  PORT="$PORT" MFLIX_LAUNCHER=1 MFLIX_DATA_DIR="$STATE/data" \
    /usr/bin/nohup "$NODE" server.js >> "$LOG" 2>&1 &
  PID=$!

  ok=""
  i=0
  while [ "$i" -lt 60 ]; do
    code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)
    if [ "$code" = "200" ]; then ok=1; break; fi
    sleep 1
    i=$((i+1))
  done
  if [ -z "$ok" ]; then
    alert "服务没能起来，日志在 ~/Library/Logs/MFlixMusic/mflix-music.log。"
    exit 6
  fi
fi

URL="http://127.0.0.1:${PORT}/?appwin=1"
IP="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || /usr/sbin/ipconfig getifaddr en1 2>/dev/null)"

open_window() {
  local UD="$STATE/browser"
  local BIN="" PNAME=""
  /bin/mkdir -p "$UD"
  if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; PNAME="Google Chrome"
  elif [ -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
    BIN="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; PNAME="Microsoft Edge"
  fi
  if [ -z "$BIN" ]; then
    /usr/bin/open "$URL"
    echo "$(date '+%H:%M:%S') no chromium browser, opened default browser (window close not tracked)" >> "$LOG"
    return 1
  fi
  # profile 锁：上一次是被强退的，Singleton 锁还躺在磁盘上，新窗口会直接摆烂。
  # 只在没有活着的同 profile 进程时才清，别把正常在跑的实例搞坏。
  if /usr/bin/pgrep -f "user-data-dir=$UD" >/dev/null 2>&1; then
    echo "$(date '+%H:%M:%S') profile_locked=yes (alive instance reused)" >> "$LOG"
  else
    /bin/rm -f "$UD/SingletonLock" "$UD/SingletonSocket" "$UD/SingletonCookie" 2>/dev/null || true
    echo "$(date '+%H:%M:%S') profile_locked=no (stale locks cleared)" >> "$LOG"
  fi
  if ! /usr/bin/open -na "$PNAME" --args --user-data-dir="$UD" --app="$URL" \
        --window-size=1440,900 --no-first-run --no-default-browser-check >> "$LOG" 2>&1; then
    alert "窗口没能打开（$PNAME 启动失败）。服务已在 $URL 运行，地址已复制，可粘贴到浏览器打开。"
    printf '%s' "$URL" | /usr/bin/pbcopy 2>/dev/null || true
    return 2
  fi
  sleep 2
  if ! /usr/bin/pgrep -f "user-data-dir=$UD" >/dev/null 2>&1; then
    alert "窗口没能打开：浏览器 profile 可能被别的进程占用。地址已复制到剪贴板。"
    printf '%s' "$URL" | /usr/bin/pbcopy 2>/dev/null || true
    return 3
  fi
  return 0
}

if [ "${MFLIX_NOBROWSER:-}" = "1" ]; then
  echo "READY $URL LAN http://${IP:-unknown}:$PORT"
  exit 0
fi

if [ -n "$IP" ]; then
  printf 'http://%s:%s/' "$IP" "$PORT" | /usr/bin/pbcopy 2>/dev/null || true
  echo "READY $URL LAN http://$IP:$PORT" >> "$LOG"
  notify "MFlix Music 已启动" "手机/电视用 http://$IP:$PORT （已复制到剪贴板）"
else
  notify "MFlix Music 已启动" "本机 http://127.0.0.1:$PORT （没读到局域网 IP，检查 Wi-Fi）"
fi

open_window
WRC=$?

# 复用别人的服务：开完窗就退，Dock 不留空壳图标；下次点图标还是秒开。
if [ -z "$PID" ]; then
  exit 0
fi

# 自己起的服务：等它退（前端关窗会打 /api/bye，10 秒后自己退）。
# 窗口没开起来也别把它晾着，直接收掉。
if [ "$WRC" -ne 0 ]; then
  kill "$PID" 2>/dev/null
  exit 7
fi

trap 'kill "$PID" 2>/dev/null; exit 0' INT TERM HUP
wait "$PID"
echo "$(date '+%H:%M:%S') stopping" >> "$LOG"
exit 0
