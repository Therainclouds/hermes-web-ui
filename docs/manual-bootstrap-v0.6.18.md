# 设备手动引导到 v0.6.18 操作手册

本文档用于把现场设备手动引导到 `v0.6.18`，让设备进入已验证可用的更新基线。完成本手册后，后续版本应优先通过 Web UI 在线更新，不再依赖人工替换部署目录。

## 适用场景

- 设备当前版本低于 `0.6.18`
- 设备尚未进入已修复的 Web UI 更新链路
- 需要先人工引导一次，再通过页面执行后续升级

## 目标

- 手动把设备升级到 `0.6.18`
- 保留设备现有运行配置，尤其是 `PORT`、`BIND_HOST` 和 `WEBUI_UPDATE_*`
- 避免手动执行安装脚本时把端口错误改写为 `8648`

## 重要原则

- 不要使用 `stable/latest.json` 做本次引导，必须固定到 `v0.6.18` 的 manifest
- 不要直接执行 `source /etc/default/hermes-web-ui`
- 不要手工删除 `hermes_data`、上传目录或 `HERMES_WEB_UI_HOME`
- 执行前先确认设备磁盘空间、网络和当前服务状态

## 前置检查

在设备上执行：

```bash
sudo -i
set -euo pipefail

date
df -h
free -h
sudo systemctl status hermes-web-ui.service --no-pager || true
cat /etc/default/hermes-web-ui
```

重点确认：

- 当前设备使用的端口，例如 `PORT=6060`
- 当前绑定地址，例如 `BIND_HOST=0.0.0.0`
- 当前更新策略仍是 `device-package`
- 磁盘空间足够完成解包和备份

## 第 1 步：准备临时目录

```bash
sudo -i
set -euo pipefail

mkdir -p /tmp/hermes-bootstrap-018
cd /tmp/hermes-bootstrap-018
```

## 第 2 步：获取固定版本 manifest

```bash
TARGET_VERSION="0.6.18"
MANIFEST_URL="https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/v${TARGET_VERSION}/manifest.json"

curl -fsSL "$MANIFEST_URL" -o manifest.json
cat manifest.json
```

这里必须确认：

- `version` 为 `0.6.18`
- `packageUrl` 或 `packageUrls` 指向 `v0.6.18`
- `sha256` 存在

## 第 3 步：解析下载地址和校验值

```bash
eval "$(python3 - <<'PY'
import json, shlex
with open('manifest.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
package_url = (data.get("packageUrls") or [data["packageUrl"]])[0]
print(f"TARGET_VERSION={shlex.quote(data['version'])}")
print(f"PACKAGE_URL={shlex.quote(package_url)}")
print(f"EXPECTED_SHA256={shlex.quote(data['sha256'])}")
PY
)"

echo "TARGET_VERSION=$TARGET_VERSION"
echo "PACKAGE_URL=$PACKAGE_URL"
echo "EXPECTED_SHA256=$EXPECTED_SHA256"

test "$TARGET_VERSION" = "0.6.18"
```

## 第 4 步：下载并校验设备包

```bash
curl -fsSL "$PACKAGE_URL" -o "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz"
printf '%s  %s\n' "$EXPECTED_SHA256" "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz" | sha256sum -c -
ls -lh "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz"
```

如果 `sha256sum -c -` 失败，不要继续执行，先重新检查 manifest 和下载源。

## 第 5 步：安全加载现有环境

不要直接执行：

```bash
source /etc/default/hermes-web-ui
```

请使用下面的方式，按 `KEY=VALUE` 原样加载：

```bash
while IFS= read -r line; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  value=${value%$'\r'}
  export "$key=$value"
done < /etc/default/hermes-web-ui
```

## 第 6 步：显式固定关键变量

这一段的目的，是确保安装器继承设备当前端口和服务配置，而不是回退到脚本默认值。

```bash
export APP_USER="${APP_USER:-hermesui}"
export DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
export SYSTEMD_SERVICE_NAME="hermes-web-ui.service"
export SERVICE_ENV_FILE="/etc/default/hermes-web-ui"
export PORT="${PORT:-6060}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
```

执行确认：

```bash
echo "APP_USER=$APP_USER"
echo "DEPLOY_DIR=$DEPLOY_DIR"
echo "PORT=$PORT"
echo "BIND_HOST=$BIND_HOST"
echo "SERVICE_ENV_FILE=$SERVICE_ENV_FILE"
echo "WEBUI_UPDATE_STRATEGY=${WEBUI_UPDATE_STRATEGY:-}"
echo "WEBUI_UPDATE_MANIFEST_URLS=${WEBUI_UPDATE_MANIFEST_URLS:-}"
```

如果这台设备历史端口不是 `6060`，这里应保持原来的值，不要强行改成别的端口。

## 第 7 步：执行手动引导安装

```bash
bash /opt/hermes-web-ui/scripts/install-device-package.sh \
  --package "$PWD/hermes-web-ui-device-v${TARGET_VERSION}.tar.gz" \
  --version "$TARGET_VERSION"
```

说明：

- 该脚本可能运行数分钟
- 过程中会执行解包、备份、`deploy-source-armbian.sh update-only`、依赖安装、服务重启和健康检查
- 如果当前终端长时间无输出，不一定代表卡死，安装日志可能已经重定向到文件

## 第 8 步：安装完成后立即验证

```bash
curl -sS "http://127.0.0.1:${PORT}/health"
grep '^PORT=' /etc/default/hermes-web-ui
grep '^BIND_HOST=' /etc/default/hermes-web-ui
grep '"version"' /opt/hermes-web-ui/package.json
sudo systemctl status hermes-web-ui.service --no-pager
sudo -u hermesui -H cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json 2>/dev/null || true
sudo -u hermesui -H ls -lt /home/hermesui/.hermes-web-ui/updates/logs | head
```

成功标准：

- `package.json` 显示 `0.6.18`
- `/health` 能正常返回 JSON
- `/etc/default/hermes-web-ui` 中的 `PORT` 仍然是设备原端口
- `hermes-web-ui.service` 为 `active (running)`
- 页面可正常打开
- 聊天功能可正常使用

## 第 9 步：验证后续 Web 更新能力

完成手动引导后，不要再手动安装下一版，后续版本应通过页面按钮升级。

建议同时开 3 个窗口观察：

```bash
sudo journalctl -u hermes-web-ui.service -f
```

```bash
sudo journalctl -u hermes-web-ui-update.service -f
```

```bash
watch -n 1 'cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json 2>/dev/null || true'
```

如果页面能检测到新版本，并且通过 Web UI 成功完成下一跳升级，则说明设备已经进入已修复的更新基线。

## 一键执行版

如果现场只需要一段可直接复制执行的命令，使用下面这一版：

```bash
sudo -i
set -euo pipefail

mkdir -p /tmp/hermes-bootstrap-018
cd /tmp/hermes-bootstrap-018

TARGET_VERSION="0.6.18"
MANIFEST_URL="https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/v${TARGET_VERSION}/manifest.json"

curl -fsSL "$MANIFEST_URL" -o manifest.json

eval "$(python3 - <<'PY'
import json, shlex
with open('manifest.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
package_url = (data.get("packageUrls") or [data["packageUrl"]])[0]
print(f"TARGET_VERSION={shlex.quote(data['version'])}")
print(f"PACKAGE_URL={shlex.quote(package_url)}")
print(f"EXPECTED_SHA256={shlex.quote(data['sha256'])}")
PY
)"

test "$TARGET_VERSION" = "0.6.18"

curl -fsSL "$PACKAGE_URL" -o "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz"
printf '%s  %s\n' "$EXPECTED_SHA256" "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz" | sha256sum -c -

while IFS= read -r line; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  value=${value%$'\r'}
  export "$key=$value"
done < /etc/default/hermes-web-ui

export APP_USER="${APP_USER:-hermesui}"
export DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
export SYSTEMD_SERVICE_NAME="hermes-web-ui.service"
export SERVICE_ENV_FILE="/etc/default/hermes-web-ui"
export PORT="${PORT:-6060}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"

bash /opt/hermes-web-ui/scripts/install-device-package.sh \
  --package "$PWD/hermes-web-ui-device-v${TARGET_VERSION}.tar.gz" \
  --version "$TARGET_VERSION"

curl -sS "http://127.0.0.1:${PORT}/health"
grep '^PORT=' /etc/default/hermes-web-ui
grep '^BIND_HOST=' /etc/default/hermes-web-ui
grep '"version"' /opt/hermes-web-ui/package.json
sudo systemctl status hermes-web-ui.service --no-pager
```

## 常见问题

### 1. 手动安装后端口从 `6060` 变成 `8648`

原因通常是安装脚本在当前 shell 中没有读到设备原有 `PORT`，从而回退到脚本默认端口。

先检查：

```bash
grep '^PORT=' /etc/default/hermes-web-ui
sudo journalctl -u hermes-web-ui.service -n 30 --no-pager
```

如需修回：

```bash
sudo sed -i 's/^PORT=.*/PORT=6060/' /etc/default/hermes-web-ui
sudo systemctl restart hermes-web-ui.service
curl -sS http://127.0.0.1:6060/health
```

如果设备原本不是 `6060`，请把命令里的端口替换为现场原值。

### 2. 当前终端长时间没有输出

先看后台日志：

```bash
ps -ef | grep -E 'install-device-package|deploy-source-armbian|npm|node' | grep -v grep
ls -lt /home/hermesui/.hermes-web-ui/updates/logs | head
tail -n 120 $(ls -t /home/hermesui/.hermes-web-ui/updates/logs/*.log | head -n 1)
```

### 3. 健康检查失败

执行：

```bash
sudo systemctl status hermes-web-ui.service --no-pager
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager
sudo -u hermesui -H cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json 2>/dev/null || true
sudo -u hermesui -H ls -lt /home/hermesui/.hermes-web-ui/updates/logs | head
tail -n 200 $(ls -t /home/hermesui/.hermes-web-ui/updates/logs/*.log 2>/dev/null | head -n 1)
```

## 相关文档

- [部署更新运行手册](./deploy-update-runbook.md)
- [部署排障速查](./deploy-troubleshooting.md)
- [Armbian/Ubuntu 源码部署指南](./deploy-source-armbian.md)
