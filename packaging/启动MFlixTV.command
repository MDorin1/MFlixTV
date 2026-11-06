#!/bin/bash
# ============================================================
#  MFlixTV 启动器（macOS，Intel / Apple 芯片通用）
#  双击运行；会在本机起两个服务：
#    - 短剧内核   127.0.0.1:8000
#    - MFlixTV 主站 127.0.0.1:8080
#  然后打开浏览器。关掉这个终端窗口＝停止服务。
# ============================================================
cd "$(dirname "$0")" || exit 1
ROOT="$PWD"

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  NODE="$ROOT/runtime/node-arm64"
  FFMPEG="$ROOT/runtime/ffmpeg/ffmpeg-arm64"
  ARCHNAME="Apple 芯片（arm64）"
else
  NODE="$ROOT/runtime/node-x64"
  FFMPEG="$ROOT/runtime/ffmpeg/ffmpeg-x64"
  ARCHNAME="Intel（x86_64）"
fi

# 解压后权限可能被清掉，这里补一次（不影响系统安全设置）
chmod +x "$NODE" "$FFMPEG" 2>/dev/null
chmod +x "$ROOT/启动MFlixTV.command" 2>/dev/null

if [ ! -x "$NODE" ]; then
  echo "找不到可执行的 Node 运行时：$NODE"
  echo "请重新解压完整的压缩包（不要把文件单独拖出来）。"
  read -r -p "按回车退出…" _
  exit 1
fi

# ffmpeg 放到 PATH 里，短剧内核直接找 ffmpeg 就能用
mkdir -p "$ROOT/runtime/bin"
ln -sf "$FFMPEG" "$ROOT/runtime/bin/ffmpeg" 2>/dev/null
export PATH="$ROOT/runtime/bin:$PATH"

echo "MFlixTV · $ARCHNAME"
echo "目录：$ROOT"

port_open() { /usr/bin/nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

# 已经有一个在跑就不再起第二个
if port_open 8080; then
  echo "MFlixTV 已经在运行，直接打开页面。"
  open "http://localhost:8080"
  sleep 2
  exit 0
fi

[ -f "$ROOT/app/.env" ] || cp "$ROOT/app/.env.example" "$ROOT/app/.env" 2>/dev/null

# 1) 短剧内核：必须以 hongguo 为工作目录启动（它按 cwd 找 config/web）
if ! port_open 8000; then
  echo "[1/2] 启动短剧内核…"
  (
    cd "$ROOT/hongguo" || exit 1
    PORT=8000 \
    BIND_HOST=127.0.0.1 \
    HG_TRANSCODE=1 \
    HG_CACHE_MAX_FILES=120 \
    HG_OPEN_BROWSER=0 \
      exec "$NODE" "$ROOT/hongguo/server/src/main.js"
  ) > "$ROOT/hongguo/hg.log" 2>&1 &
  HG_PID=$!
fi

# 2) 主站：Next 必须把工作目录设在 app 里，否则它找不到 .next
echo "[2/2] 启动 MFlixTV…"
(
  cd "$ROOT/app" || exit 1
  exec "$NODE" "$ROOT/app/node_modules/next/dist/bin/next" start -p 8080
) > "$ROOT/app/server.log" 2>&1 &
NEXT_PID=$!

cleanup() {
  echo
  echo "正在停止…"
  [ -n "$NEXT_PID" ] && kill "$NEXT_PID" 2>/dev/null
  [ -n "$HG_PID" ] && kill "$HG_PID" 2>/dev/null
  # 短剧内核会另起 ffmpeg，留着会占 CPU
  pkill -f "hongguo/server/src/main.js" 2>/dev/null
  pkill -f "runtime/bin/ffmpeg" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

for i in $(seq 1 40); do
  port_open 8080 && break
  sleep 1
done

if port_open 8080; then
  echo "已启动：http://localhost:8080   默认密码 MFlixTV"
  echo "同一 WiFi 的手机 / 电视用「http://$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null):8080」也能看。"
  open "http://localhost:8080"
else
  echo "启动没成功，看日志：app/server.log"
  tail -n 20 "$ROOT/app/server.log" 2>/dev/null
fi

echo
echo "这个窗口开着服务就在跑；关掉窗口或按 Control-C 即停止。"
wait
