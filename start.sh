#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "=== Hermes Web UI 启动脚本 ==="

# 默认监听 0.0.0.0，允许局域网设备访问（可用 BIND_HOST 覆盖）
export BIND_HOST="${BIND_HOST:-0.0.0.0}"

# 检测局域网 IP（用于展示访问地址）
LAN_IP="$(ip -4 route get 1 2>/dev/null | grep -oP 'src\s+\K[^ ]+' | head -n 1)"
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet\s+\K[^/]+' | head -n 1)"
fi
[ -z "$LAN_IP" ] && LAN_IP="127.0.0.1"

# 检查 node 和 node_modules
command -v node >/dev/null 2>&1 || { echo "❌ node 未安装"; exit 1; }
[ -d node_modules ] || { echo "❌ 请先 npm ci"; exit 1; }

echo "✓ node $(node -v)"
echo "✓ 监听地址: $BIND_HOST (局域网 IP: $LAN_IP)"

# 清理旧的进程 (8649=Vite前端, 8647=Koa后端)
for port in 8649 8647; do
  pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$pid" ]; then
    echo "→ 关闭端口 $port (PID $pid)"
    kill "$pid" 2>/dev/null || true
  fi
done

sleep 1

# 同时启动前后端
echo ""
echo "→ 启动 Vite 前端 (端口 8649) + Koa 后端 (端口 8647) ..."
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

echo -n "等待前端 8649"
for i in $(seq 1 30); do
  sleep 1
  if ss -tlnp 2>/dev/null | grep -q ':8649 '; then
    echo " ✅"
    break
  fi
  echo -n "."
done
[ "$i" -eq 30 ] && { echo ""; echo "❌ 前端未在 30s 内启动"; }

echo ""
echo "=== 启动完成 ==="
echo "  本机 Web UI:  http://localhost:8649  (HTTPS: https://localhost:8649)"
echo "  局域网 Web UI: http://$LAN_IP:8649  (HTTPS: https://$LAN_IP:8649)"
echo "  API:          http://$LAN_IP:8647"
echo "  日志:         ~/.hermes-web-ui/logs/server.log"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待子进程
wait $DEV_PID
