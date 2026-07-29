#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "=== Hermes Web UI 启动脚本 ==="

# 检查 node 和 node_modules
command -v node >/dev/null 2>&1 || { echo "❌ node 未安装"; exit 1; }
[ -d node_modules ] || { echo "❌ 请先 npm ci"; exit 1; }

echo "✓ node $(node -v)"

# 清理旧的进程 (6060=Vite前端, 8647=Koa后端)
for port in 6060 8647; do
  pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$pid" ]; then
    echo "→ 关闭端口 $port (PID $pid)"
    kill "$pid" 2>/dev/null || true
  fi
done

sleep 1

# 同时启动前后端
echo ""
echo "→ 启动 Vite 前端 (端口 6060) + Koa 后端 (端口 8647) ..."
echo ""

npm run dev 2>&1 &
DEV_PID=$!

# 等待两个端口就绪
echo -n "等待后端 8647"
for i in $(seq 1 30); do
  sleep 1
  if ss -tlnp 2>/dev/null | grep -q ':8647 '; then
    echo " ✅"
    break
  fi
  echo -n "."
done
[ "$i" -eq 30 ] && { echo ""; echo "❌ 后端未在 30s 内启动"; }

echo -n "等待前端 6060"
for i in $(seq 1 30); do
  sleep 1
  if ss -tlnp 2>/dev/null | grep -q ':6060 '; then
    echo " ✅"
    break
  fi
  echo -n "."
done
[ "$i" -eq 30 ] && { echo ""; echo "❌ 前端未在 30s 内启动"; }

echo ""
echo "=== 启动完成 ==="
echo "  Web UI:  http://localhost:6060"
echo "  API:     http://localhost:8647"
echo "  日志:    ~/.hermes-web-ui/logs/server.log"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待子进程
wait $DEV_PID
