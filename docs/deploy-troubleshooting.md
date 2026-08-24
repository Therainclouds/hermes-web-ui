# 部署排障速查

这份文档用于现场快速定位 `hermes-web-ui` 部署问题，优先提供可直接复制执行的命令。

适用范围：

- `scripts/deploy-source-armbian.sh`
- `scripts/deploy-armbian.sh`

## 快速分流

先判断你走的是哪条部署路径：

- 源码部署：`systemd` 托管 `hermes-web-ui.service`
- Docker 部署：`docker compose` 托管 `hermes-webui` 容器

如果你不确定，先执行：

```bash
sudo systemctl status hermes-web-ui.service --no-pager -l || true
cd /opt/hermes-web-ui && sudo docker compose ps || true
```

## 通用快速检查

### 系统时间、磁盘、端口

```bash
date
timedatectl status || true
df -h
free -h
ss -lntp | grep 6060 || true
```

### 基础网络

```bash
ip a
ip route
ping -c 1 1.1.1.1 || true
curl -I http://127.0.0.1:6060/health || true
```

### 最近失败日志

```bash
sudo journalctl -n 200 --no-pager | tail -n 80
```

## 源码部署排查

源码部署由 `systemd` 管理，关键对象是：

- `hermes-web-ui.service`
- `/etc/default/hermes-web-ui`
- `/home/hermesui/.local/bin/hermes`
- `/tmp/hermes-agent-bridge.sock`

### 1. 检查服务状态

```bash
sudo systemctl status hermes-web-ui.service --no-pager -l
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager
```

### 2. 检查运行环境

```bash
cat /etc/default/hermes-web-ui
systemctl cat hermes-web-ui.service
ls -lah /opt/hermes-web-ui/dist
ls -lah /opt/hermes-web-ui/dist/server
```

### 3. 检查 Hermes 安装归属

```bash
sudo -u hermesui -H ls -lah /home/hermesui/.local/bin/hermes
sudo -u hermesui -H head -n 1 /home/hermesui/.local/bin/hermes
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes version
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes doctor
```

### 4. 检查 agent bridge

```bash
sudo -u hermesui -H ls -lah /tmp/hermes-agent-bridge.sock
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager | grep -E "agent bridge|run_agent|ENOENT" || true
```

### 5. 页面能开但聊天失败

如果你看到以下任一现象：

- `agent bridge exited before ready`
- `RuntimeError: hermes-agent run_agent.py not found`
- `ENOENT /tmp/hermes-agent-bridge.sock`
- `/home/hermesui/.local/bin/hermes` 指向 `/root/.local/...`

优先按下面顺序修复：

```bash
sudo systemctl stop hermes-web-ui.service
sudo rm -rf /home/hermesui/.hermes/hermes-agent
sudo rm -rf /home/hermesui/.local/share/uv/tools/hermes-agent
sudo rm -f /home/hermesui/.local/bin/hermes
sudo rm -rf /root/.local/share/uv/tools/hermes-agent
sudo rm -f /root/.local/bin/hermes
sudo apt-get update -y
sudo apt-get install -y ripgrep ffmpeg build-essential python3-dev libffi-dev
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data sh -c 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | sh -s -- --skip-setup --skip-browser'
sudo systemctl restart hermes-web-ui.service
```

## Docker 部署排查

Docker 部署的关键对象是：

- `/opt/hermes-web-ui/.env`
- `/opt/hermes-web-ui/docker-compose.yml`
- `hermes-webui` 容器

### 1. 检查容器状态

```bash
cd /opt/hermes-web-ui
sudo docker compose ps
sudo docker compose logs --tail=200 hermes-webui
```

### 2. 检查 Docker 服务

```bash
sudo systemctl status docker --no-pager -l
sudo docker version
sudo docker compose version
```

### 3. 检查镜像源与拉取能力

```bash
cat /etc/docker/daemon.json || true
sudo docker info | grep -A5 "Registry Mirrors" || true
sudo docker pull ekkoye8888/hermes-web-ui || true
```

### 4. 手动回退直连 docker.io

```bash
sudo python3 - <<'PY'
import json
from pathlib import Path

path = Path("/etc/docker/daemon.json")
data = {}
if path.exists():
    data = json.loads(path.read_text(encoding="utf-8"))
data.pop("registry-mirrors", None)
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
sudo systemctl restart docker
sudo docker info | grep -A5 "Registry Mirrors" || true
```

### 5. 健康检查

```bash
curl -I http://127.0.0.1:6060/health || true
cd /opt/hermes-web-ui
sudo docker compose logs hermes-webui | grep -i "health\\|token\\|error" || true
```

## 常见失败模式

### `apt update` 提示 `Release file ... is not valid yet`

```bash
date
timedatectl status || true
sudo timedatectl set-ntp true || true
sudo systemctl restart systemd-timesyncd || true
sudo apt-get -o Acquire::Check-Date=false update
```

### Node 下载失败

```bash
sudo NODE_MIRROR_URL=https://npmmirror.com/mirrors/node ./scripts/deploy-source-armbian.sh
```

### Hermes 安装脚本下载失败

```bash
sudo HERMES_INSTALLER_MIRROR=https://your-mirror/install.sh ./scripts/deploy-source-armbian.sh
```

### npm 安装慢或失败

```bash
sudo -u hermesui -H cat /home/hermesui/.npmrc
sudo -u hermesui -H env PATH=/opt/node-v23/bin:$PATH npm config get registry
```

## 重部署命令

### 源码部署重跑

如果你是本地源码包部署，不要使用 `git pull`。标准流程是重新打包、重新上传、重新解压，再执行脚本。

远端最小重跑命令：

```bash
sudo systemctl stop hermes-web-ui.service || true
sudo rm -rf /opt/hermes-web-ui
sudo mkdir -p /opt
sudo tar -xzf /tmp/hermes-web-ui-src.tar.gz -C /opt
cd /opt/hermes-web-ui
chmod +x scripts/deploy-source-armbian.sh
sudo ./scripts/deploy-source-armbian.sh
```

### Docker 部署重跑

```bash
cd /opt/hermes-web-ui
sudo docker compose down
sudo ./scripts/deploy-armbian.sh
```

## 相关文档

- [源码部署指南](./deploy-source-armbian.md)
- [Docker 部署指南](./deploy-armbian.md)
- [历史排障记录](./work-log.md)

## HTTPS 启用（麦克风必须）

浏览器 `getUserMedia()` 在非 localhost 下必须 HTTPS。hemes-web-ui 支持 protocol-sniffing：同一端口同时处理 HTTP/HTTPS。

### 生成自签名证书

```bash
# 在设备上执行（替换 IP 为实际地址）
mkdir -p /root/hermes-web-ui/certs
openssl req -x509 -newkey rsa:2048 \
  -keyout /root/hermes-web-ui/certs/server.key \
  -out    /root/hermes-web-ui/certs/server.crt \
  -days 365 -nodes \
  -subj '/CN=192.168.10.87' \
  -addext 'subjectAltName=IP:192.168.10.87'
```

证书放在 `hermes-web-ui/certs/` 目录，Node 服务器启动时自动检测。

### 验证

```bash
curl -sk https://<设备IP>:6060/
# 应返回 HTML，日志中显示:
# Server: https://localhost:6060 (LAN: https://<设备IP>:6060)
```

浏览器首次访问会提示不安全，点击 **高级 → 继续访问**。

## Python 虚拟环境修复

会议 ASR 后端（Python/FastAPI）依赖 venv。部署后常见错误：

```
Failed to create Python venv (exit 1): no stderr
Failed to install Python dependencies (exit 1): No module named pip
```

### 修复步骤

```bash
# 1. 安装 python3-venv（Debian/Ubuntu 必需）
apt-get update -qq && apt-get install -y python3.10-venv python3-pip

# 2. 如果 venv 已存在但缺 pip，手动注入
cd /root/hermes-web-ui/dist/server/python-backend
.venv/bin/python3 -m ensurepip --upgrade

# 3. 安装所有依赖
.venv/bin/pip3 install fastapi uvicorn websockets pydantic openai httpx sse-starlette oss2 requests

# 4. 重启服务
systemctl restart hermes-web-ui
```

### 验证 ASR 服务

```bash
# 应看到两个 uvicorn 进程
ps aux | grep uvicorn | grep -v grep
# 端口 8000 (ASR) 和 8001 (diarize) 应在监听
ss -tlnp | grep -E '8000|8001'

# 查看日志
journalctl -u hermes-web-ui -n 30 --no-pager | grep -E 'meeting|asr|venv|pip|error'
```

## 会议 ASR 连接失败排查

前端会议页面需要：

1. **DashScope API Key** — 在会议页面设置中填入（阿里云语音识别服务密钥）
2. **ASR 后端运行** — 端口 8000/8001 需在监听
3. **WebSocket 连接** — 浏览器通过 6060 端口的 WebSocket 代理连接到 ASR

### 检查清单

```bash
# ASR 健康检查（需认证 token，直接看进程更可靠）
ps aux | grep uvicorn | grep -v grep

# 如果 ASR 未运行，手动启动
curl -sk -X POST https://127.0.0.1:6060/api/meeting-asr/start \
  -H 'Content-Type: application/json' \
  -d '{"dashscopeApiKey": "YOUR_KEY"}'

# 查看 ASR 状态
curl -sk https://127.0.0.1:6060/api/meeting-asr/status
```

## 启动顺序总结

新设备首次部署后的完整检查清单：

```
□ apt install python3.10-venv python3-pip
□ 生成 TLS 证书 → hermes-web-ui/certs/server.{crt,key}
□ systemctl restart hermes-web-ui
□ 确认 HTTPS: curl -sk https://<IP>:6060/
□ 确认 venv 无报错: journalctl -u hermes-web-ui -n 20 --no-pager
□ 确认 ASR 进程: ps aux | grep uvicorn
□ 在会议页面填入 DashScope API Key
```
