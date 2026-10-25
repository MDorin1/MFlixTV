#!/bin/bash
# lihongguotv 启动器（macOS）
cd "$(dirname "$0")" || exit 1

export PATH="$PWD/runtime/ffmpeg:$PATH"
NODE="./runtime/node"
[ -x "$NODE" ] || { echo "找不到 runtime/node"; read -r; exit 1; }

# 首次运行：生成 .env
[ -f app/.env ] || cp app/.env.example app/.env 2>/dev/null

port_open() { /usr/bin/nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

# 1) 红果服务（8000）
if ! port_open 8000; then
  echo "[1/2] 启动红果服务…"
  PORT=8000 BIND_HOST=127.0.0.1 HG_OPEN_BROWSER=0 HG_CACHE_MAX_FILES=120 \
    "$NODE" hongguo/server/src/main.js > hongguo/hg.log 2>&1 &
fi

# 2) lihongguotv 主站（8080）
if ! port_open 8080; then
  echo "[2/2] 启动 lihongguotv…"
  "$NODE" app/node_modules/next/dist/bin/next start -p 8080 > app/server.log 2>&1 &
fi

for i in $(seq 1 40); do
  port_open 8080 && break
  sleep 1
done

if port_open 8080; then
  echo "已就绪：http://localhost:8080  （默认密码 lihongguotv）"
  open "http://localhost:8080"
else
  echo "启动超时，日志：app/server.log"
fi
echo
echo "这个窗口可以直接关掉，服务在后台运行。"
echo "彻底停止：pkill -f 'next start -p 8080'; pkill -f hongguo/server/src/main.js"
sleep 3