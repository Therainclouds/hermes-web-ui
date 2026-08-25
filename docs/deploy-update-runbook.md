# 手动更新到指定版本教程

这份文档只回答一件事：

如何把一台设备手动更新到你指定的 `hermes-web-ui` 版本，例如 `0.6.18`。

如果你的目标是先把设备引导到一个已验证可用的版本，再让后续版本通过 Web UI 页面更新，这份文档就是给现场执行同事用的。

## 适用场景

- 设备当前版本过旧，不能直接依赖页面更新
- 需要先人工引导到一个稳定版本，例如 `0.6.18`
- 引导完成后，后续版本准备走 Web UI 在线更新

## 先记住 3 条规则

- 不要直接使用 `stable/latest.json`
- 不要直接执行 `source /etc/default/hermes-web-ui`
- 不要丢失设备原有 `PORT` 和 `BIND_HOST`

原因：

- `stable/latest.json` 会继续前进，不适合做固定版本引导
- `/etc/default/hermes-web-ui` 里可能有带空格的值，直接 `source` 会报错
- 如果手动安装时没保留原端口，设备可能从 `6060` 漂到 `8648`

## 一键执行版

先把下面命令里的版本号改成你要引导到的版本，然后整段执行。

```bash
sudo -i
set -euo pipefail

mkdir -p /tmp/hermes-bootstrap
cd /tmp/hermes-bootstrap

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

## 分步执行版

如果你希望一条一条确认，就按下面步骤执行。

### 1. 登录设备

```bash
ssh <设备用户名>@<设备IP>
sudo -i
set -euo pipefail
```

### 2. 建临时目录

```bash
mkdir -p /tmp/hermes-bootstrap
cd /tmp/hermes-bootstrap
```

### 3. 固定到指定版本

下面以 `0.6.18` 为例，你也可以替换成别的版本。

```bash
TARGET_VERSION="0.6.18"
MANIFEST_URL="https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/v${TARGET_VERSION}/manifest.json"
```

### 4. 下载固定版本 manifest

```bash
curl -fsSL "$MANIFEST_URL" -o manifest.json
cat manifest.json
```

你要确认：

- `version` 是你要的版本
- `packageUrl` 或 `packageUrls` 存在
- `sha256` 存在

### 5. 解析下载地址和校验值

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
```

### 6. 下载设备包并校验

```bash
curl -fsSL "$PACKAGE_URL" -o "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz"
printf '%s  %s\n' "$EXPECTED_SHA256" "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz" | sha256sum -c -
ls -lh "hermes-web-ui-device-v${TARGET_VERSION}.tar.gz"
```

如果校验失败，不要继续执行。

### 7. 安全加载设备当前环境

不要这样做：

```bash
source /etc/default/hermes-web-ui
```

请用下面这个安全版本：

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

### 8. 显式保留关键变量

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
```

### 9. 执行手动安装

```bash
bash /opt/hermes-web-ui/scripts/install-device-package.sh \
  --package "$PWD/hermes-web-ui-device-v${TARGET_VERSION}.tar.gz" \
  --version "$TARGET_VERSION"
```

说明：

- 该脚本可能执行几分钟
- 没有持续输出不代表卡死
- 日志可能已经重定向到文件

### 10. 安装完成后验证

```bash
curl -sS "http://127.0.0.1:${PORT}/health"
grep '^PORT=' /etc/default/hermes-web-ui
grep '^BIND_HOST=' /etc/default/hermes-web-ui
grep '"version"' /opt/hermes-web-ui/package.json
sudo systemctl status hermes-web-ui.service --no-pager
sudo -u hermesui -H cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json 2>/dev/null || true
sudo -u hermesui -H ls -lt /home/hermesui/.hermes-web-ui/updates/logs | head
```

## 成功标准

执行完成后，至少满足下面几点：

- `/opt/hermes-web-ui/package.json` 显示目标版本
- `curl http://127.0.0.1:${PORT}/health` 返回正常 JSON
- `/etc/default/hermes-web-ui` 里的 `PORT` 没被改成错误值
- `hermes-web-ui.service` 是 `active (running)`
- 页面可以正常打开
- 聊天功能正常

## 后续怎么做

当设备已经被人工引导到 `0.6.18` 这类已验证版本后，后续版本优先通过 Web UI 页面更新，不要继续人工替换部署目录。

建议验证方式：

```bash
sudo journalctl -u hermes-web-ui.service -f
```

```bash
sudo journalctl -u hermes-web-ui-update.service -f
```

```bash
watch -n 1 'cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json 2>/dev/null || true'
```

## 常见问题

### 手动更新后端口从 `6060` 变成 `8648`

先检查：

```bash
grep '^PORT=' /etc/default/hermes-web-ui
sudo journalctl -u hermes-web-ui.service -n 30 --no-pager
```

原因通常是：

- 执行安装脚本前没有把设备原来的 `PORT` 带进当前 shell
- 安装器回退到了默认端口

修回示例：

```bash
sudo sed -i 's/^PORT=.*/PORT=6060/' /etc/default/hermes-web-ui
sudo systemctl restart hermes-web-ui.service
curl -sS http://127.0.0.1:6060/health
```

如果设备原本不是 `6060`，把命令里的端口替换成现场原值。

### 当前终端长时间没输出

先不要急着中断，先看日志和进程：

```bash
ps -ef | grep -E 'install-device-package|deploy-source-armbian|npm|node' | grep -v grep
ls -lt /home/hermesui/.hermes-web-ui/updates/logs | head
tail -n 120 $(ls -t /home/hermesui/.hermes-web-ui/updates/logs/*.log | head -n 1)
```

### 升级后健康检查失败

执行下面这组命令收集信息：

```bash
sudo systemctl status hermes-web-ui.service --no-pager
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager
sudo -u hermesui -H cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json 2>/dev/null || true
sudo -u hermesui -H ls -lt /home/hermesui/.hermes-web-ui/updates/logs | head
tail -n 200 $(ls -t /home/hermesui/.hermes-web-ui/updates/logs/*.log 2>/dev/null | head -n 1)
```

## 相关文件

- 安装脚本：`/opt/hermes-web-ui/scripts/install-device-package.sh`
- 环境文件：`/etc/default/hermes-web-ui`
- 服务名：`hermes-web-ui.service`
- 更新状态：`/home/hermesui/.hermes-web-ui/updates/update-task-state.json`
- 更新日志目录：`/home/hermesui/.hermes-web-ui/updates/logs`
- 环境快照：`/home/hermesui/.hermes-web-ui/env-state.json`
  （安装或 `/api/hermes/update/reconcile` 触发后写入；
  包含 Node / Hermes Agent 版本、安装脚本指纹、与 manifest 的 drift）

## 环境对账（reconcile）

如果设备升级后行为异常（端口漂移、脚本不一致、依赖缺失），但控制台没有清晰错误，可手动触发一次环境对账：

```bash
sudo /opt/hermes-web-ui/scripts/install-device-package.sh \
  --reconcile-env-only --version 0.7.20
```

或者从浏览器对 `/api/hermes/update/reconcile` 发 POST。结果会写入
`env-state.json`，并以 exit code 区分：0 = 无 drift；1 = 有 drift（看
`driftFromManifest` 字段定位）；2 = 抓取失败。

## PORT 解析

升级脚本不再用 `8648` 静默覆盖 `PORT`。优先级：

1. 调用方传入的 `PORT` 环境变量
2. `/etc/default/hermes-web-ui` 中的 `PORT=`
3. 默认 `6060`

`/etc/default/hermes-web-ui` 缺失或未设置 `PORT` 时，脚本会
`[INFO] PORT not exported; resolved ...` 提示用了哪条路径。
