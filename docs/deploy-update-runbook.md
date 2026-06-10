# 部署更新运行手册

## 目标

这份手册用于保证 Quanthermes 自定义版本在后续发布和部署后，始终可以稳定检测到 npm 上的新版本，并在 Web UI 中触发自更新。

相关现场手工升级流程见：

- `docs/update-distribution/09-manual-source-upgrade-sop.md`

## 当前发布约定

- npm 包名：`@quanthermes/hermes-web-ui`
- npm Registry：`https://registry.npmjs.org`
- npm 发布触发：推送 `v*` tag 到组织仓库，触发 `.github/workflows/npm-publish.yml`
- 设备部署模式：源码部署
- 设备更新模式：`source-deploy`
- 源码更新仓库：`https://github.com/tangledup-ai/hermes-web-ui`

## 当前推荐模式

- 版本检测来源：npm registry
- 更新执行方式：源码部署脚本
- 首次部署入口：`scripts/deploy-source-armbian.sh`
- 后续页面更新入口：`scripts/update-source-deploy.sh`

这样可以保证：

- 初始安装继续覆盖 `Hermes + Web UI + systemd + 环境文件`
- 页面更新不再更新错目标
- 部署路径和更新路径保持一致

## 当前数据保护边界

当前更新链路已按“真实路径识别 + 风险分级”接入第一阶段保护逻辑。

受保护的数据目录至少包括：

- `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`
- `UPLOAD_DIR`
- `HERMES_HOME_DIR` / `HERMES_HOME`

当前规则如下：

- `Web UI` 默认数据目录继续位于用户家目录下，不要求迁移。
- 更新前会先识别真实数据路径，而不是只依赖固定目录名。
- 若 `HERMES_WEB_UI_HOME` 或 `UPLOAD_DIR` 位于 `DEPLOY_DIR` 内，更新会被直接阻止。
- 若 `HERMES_HOME_DIR` 位于 `DEPLOY_DIR` 内，当前按兼容布局处理：
  - 历史默认路径如 `${DEPLOY_DIR}/hermes_data` 会给出告警但允许更新
  - 更新脚本会显式保留该目录，避免源码同步时被清理
- 第一阶段不会自动迁移任何数据目录，也不会回滚用户数据内容。

这意味着：

- 程序更新只替换程序代码、构建产物、脚本和依赖
- 用户聊天历史、上传、配置和 `Hermes` 运行状态不应被更新过程覆盖

## 设备包状态与日志

当更新策略为 `device-package` 时，安装器会把任务状态和日志落在 `Web UI` 数据目录下，默认位置为：

- 状态文件：`${HERMES_WEB_UI_HOME}/updates/update-task-state.json`
- 日志目录：`${HERMES_WEB_UI_HOME}/updates/logs/`

默认约定：

- `GET /api/hermes/update/status` 会在服务启动后和每次查询前从状态文件同步
- 设备包安装器会写入 `logPath`，便于前端和运维定位本次更新日志
- 更新成功后，任务状态会落为 `succeeded`
- 健康检查失败且自动回退成功后，任务状态会落为 `rolled_back`

## 自更新工作原理

1. 服务启动时读取 `WEBUI_UPDATE_*` 环境变量。
2. 后端通过 `/health` 返回当前版本、npm 最新版本、更新源标签和是否可更新。
3. 前端轮询 `/health`。
4. 当 `webui_version < webui_latest` 时，sidebar 底部显示更新按钮。
5. 用户点击更新后，后端先从 npm registry 解析 `latest` 对应的真实版本号。
6. 后端在真正执行更新前，会统一执行 preflight，判断真实数据路径和风险级别。
7. 在源码部署模式下，后端后台执行 `scripts/update-source-deploy.sh --version <x.y.z>`。
8. 更新脚本会再次根据真实数据路径执行脚本侧保护，避免误删受保护目录。
9. 更新脚本会下载对应 tag 的源码包，覆盖 `/opt/hermes-web-ui`，然后调用 `deploy-source-armbian.sh` 的 `update-only` 模式完成重建、写入环境变量、重启 `systemd` 和健康检查。
10. `update-only` 模式会保留当前 `HERMES_WEB_UI_HOME` 和 `UPLOAD_DIR`，不再强制回写成固定默认值。
11. 浏览器检测到服务版本变化后自动刷新。

## 必需环境变量

源码部署、systemd 部署或一键部署脚本都必须提供以下变量：

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_DIST_TAG=latest
WEBUI_UPDATE_STRATEGY=source-deploy
WEBUI_UPDATE_SCRIPT=/opt/hermes-web-ui/scripts/update-source-deploy.sh
WEBUI_UPDATE_REPO=https://github.com/tangledup-ai/hermes-web-ui
```

注意：

- `WEBUI_UPDATE_REGISTRY` 和 `WEBUI_UPDATE_REPO` 不要写反引号，不要留前后空格。
- `update-source-deploy.sh` 必须是 `root:root` 且 `755`。
- `hermesui` 需要一条最小 sudoers 规则，允许免密执行更新脚本。

推荐 sudoers：

```bash
hermesui ALL=(root) NOPASSWD:SETENV: /bin/bash /opt/hermes-web-ui/scripts/update-source-deploy.sh *
```

与数据保护直接相关的环境变量建议显式保留：

```bash
HERMES_HOME=/opt/hermes-web-ui/hermes_data
HERMES_WEB_UI_HOME=/home/hermesui/.hermes-web-ui
UPLOAD_DIR=/home/hermesui/.hermes-web-ui/upload
```

说明：

- 若未显式设置 `UPLOAD_DIR`，服务端默认使用 `${HERMES_WEB_UI_HOME}/upload`
- 若使用自定义目录，请确保目录不与程序源码目录混放

## systemd 推荐配置

当前设备采用 systemd + EnvironmentFile 方式启动：

- 服务文件：`/etc/systemd/system/hermes-web-ui.service`
- 环境文件：`/etc/default/hermes-web-ui`

推荐的 `/etc/default/hermes-web-ui` 最小内容如下：

```bash
PORT=6060
BIND_HOST=0.0.0.0
NODE_ENV=production
HOME=/home/hermesui
PATH=/opt/node-v23/bin:/home/hermesui/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERMES_HOME=/opt/hermes-web-ui/hermes_data
HERMES_BIN=/home/hermesui/.local/bin/hermes
HERMES_WEB_UI_HOME=/home/hermesui/.hermes-web-ui
UPLOAD_DIR=/home/hermesui/.hermes-web-ui/upload
LANG=C.UTF-8
LC_ALL=C.UTF-8

WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_DIST_TAG=latest
WEBUI_UPDATE_STRATEGY=source-deploy
WEBUI_UPDATE_SCRIPT=/opt/hermes-web-ui/scripts/update-source-deploy.sh
WEBUI_UPDATE_REPO=https://github.com/tangledup-ai/hermes-web-ui
```

修改后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart hermes-web-ui
```

## 发布标准流程

1. 修改 `package.json` 版本号。
2. 提交代码并推送到组织仓库。
3. 推送 `v*` tag。
4. 等待 GitHub Actions 完成 npm 发布。
5. 用以下命令确认 npm 上已经有新版本：

```bash
npm view @quanthermes/hermes-web-ui version
```

6. 如需设备端源码部署，重新运行 `scripts/deploy-source-armbian.sh`，它会自动写入全部更新变量。

## 部署后验收

每次部署完成后，必须做以下检查。

### 1. 检查 systemd 进程是否拿到更新变量

```bash
pid=$(systemctl show -p MainPID --value hermes-web-ui)
tr '\0' '\n' < /proc/$pid/environ | grep WEBUI_UPDATE
```

预期至少包含：

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_DIST_TAG=latest
WEBUI_UPDATE_STRATEGY=source-deploy
WEBUI_UPDATE_SCRIPT=/opt/hermes-web-ui/scripts/update-source-deploy.sh
WEBUI_UPDATE_REPO=https://github.com/tangledup-ai/hermes-web-ui
```

### 2. 检查健康检查接口

```bash
curl http://127.0.0.1:6060/health
```

预期当 npm 上存在新版本时，返回类似：

```json
{
  "webui_version": "0.6.12",
  "webui_latest": "0.6.13",
  "webui_update_enabled": true,
  "webui_update_source_label": "Quanthermes npm",
  "webui_update_available": true
}
```

### 3. 检查页面表现

预期前端页面左下角：

- 显示 `更新源：Quanthermes npm`
- 当存在新版本时，显示更新按钮
- 用户点击后可自动触发源码更新并重启

### 4. 检查数据目录是否符合当前保护预期

```bash
grep -E '^(HERMES_HOME|HERMES_WEB_UI_HOME|UPLOAD_DIR)=' /etc/default/hermes-web-ui
```

建议至少确认：

- `HERMES_WEB_UI_HOME` 位于用户家目录或独立数据目录
- `UPLOAD_DIR` 未落在程序源码目录内
- `HERMES_HOME` 如位于 `${DEPLOY_DIR}/hermes_data`，属于兼容布局，可继续运行但应知晓其告警属性

### 5. 检查更新日志中的 preflight 和保护输出

```bash
tail -n 200 /var/log/hermes-web-ui-update.log
```

重点关注：

- 是否出现 `WARNING` 级兼容布局提示
- 是否出现“inside DEPLOY_DIR and update is blocked”之类的危险布局阻止信息
- 是否打印了最终保留的顶层目录列表
- 对于 `device-package`，还应确认状态文件中的 `logPath / rollbackMessage / healthcheckUrl` 与现场一致

## 一键部署脚本必须保证的内容

后续任何源码打包脚本或一键部署脚本，必须满足：

1. 写入 `/etc/default/hermes-web-ui`
2. 写入全部 `WEBUI_UPDATE_*` 变量
3. 保留或显式写入 `HERMES_HOME`、`HERMES_WEB_UI_HOME`、`UPLOAD_DIR`
4. 重启 `hermes-web-ui`
5. 自动执行一次环境变量和 `/health` 验证
6. 任一检查失败时退出并提示错误

现在 `scripts/deploy-source-armbian.sh` 已默认内置这些值：

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_DIST_TAG=latest
WEBUI_UPDATE_STRATEGY=source-deploy
WEBUI_UPDATE_SCRIPT=/opt/hermes-web-ui/scripts/update-source-deploy.sh
WEBUI_UPDATE_REPO=https://github.com/tangledup-ai/hermes-web-ui
```

建议脚本内固定加入：

```bash
systemctl restart hermes-web-ui
sleep 2

pid=$(systemctl show -p MainPID --value hermes-web-ui)
tr '\0' '\n' < /proc/$pid/environ | grep WEBUI_UPDATE || {
  echo "WEBUI_UPDATE env missing"
  exit 1
}

curl -fsS http://127.0.0.1:6060/health || {
  echo "/health check failed"
  exit 1
}
```

## 常见问题

### 页面显示当前为定制版，升级由内部发布流程管理

原因：`WEBUI_UPDATE_*` 未配置或运行进程未拿到这些变量。

检查：

```bash
pid=$(systemctl show -p MainPID --value hermes-web-ui)
tr '\0' '\n' < /proc/$pid/environ | grep WEBUI_UPDATE
```

### `/health` 中 `webui_update_enabled` 为 false

原因：配置文件缺少以下任一项：

- `WEBUI_UPDATE_ENABLED`
- `WEBUI_UPDATE_PACKAGE`
- `WEBUI_UPDATE_REGISTRY`
- `WEBUI_UPDATE_CLI_BIN`

如果当前部署模式是源码部署，还要确认：

- `WEBUI_UPDATE_STRATEGY=source-deploy`
- `WEBUI_UPDATE_SCRIPT=/opt/hermes-web-ui/scripts/update-source-deploy.sh`
- `WEBUI_UPDATE_REPO=https://github.com/tangledup-ai/hermes-web-ui`

### npm 已发布新版本，但页面没有更新按钮

检查顺序：

1. `npm view @quanthermes/hermes-web-ui version`
2. `curl http://127.0.0.1:6060/health`
3. 浏览器强制刷新 `Ctrl + F5`
4. 确认当前运行版本是否包含更新按钮对应的前端代码

### 设备升级失败

优先检查：

```bash
journalctl -u hermes-web-ui -n 200 --no-pager
tail -n 200 /var/log/hermes-web-ui-update.log
```

如果页面点更新后没有动作，按这个顺序检查：

```bash
pid=$(systemctl show -p MainPID --value hermes-web-ui)
tr '\0' '\n' < /proc/$pid/environ | grep WEBUI_UPDATE
journalctl -u hermes-web-ui -n 200 --no-pager
tail -n 200 /var/log/hermes-web-ui-update.log
ls -l /opt/hermes-web-ui/scripts/update-source-deploy.sh
```

常见原因：

- `update-source-deploy.sh` 没有执行权限
- `update-source-deploy.sh` 不是 `root:root`
- sudoers 没有 `NOPASSWD:SETENV`
- `WEBUI_UPDATE_REPO` 写错或带反引号
- `HERMES_WEB_UI_HOME` 或 `UPLOAD_DIR` 被配置到了 `DEPLOY_DIR` 内，导致 preflight 主动阻止
- GitHub archive 下载慢，需回退到 `codeload.github.com`
- 设备包安装后健康检查失败，安装器已触发自动回退，可继续检查状态文件中的 `rollbackMessage`

如果日志中看到以下类型消息：

- `Web UI data directory is inside DEPLOY_DIR and update is blocked`
- `Upload directory is inside DEPLOY_DIR and update is blocked`

说明当前布局会导致更新覆盖用户数据，必须先调整目录后再继续。

如果日志中看到以下类型消息：

- `Hermes data directory is using the legacy compatibility layout inside the deploy directory`

说明当前仍在使用兼容布局，更新会继续，但后续建议逐步评估迁移到部署目录外的数据路径。

更新脚本现在会按这个顺序下载：

```text
1. https://github.com/tangledup-ai/hermes-web-ui/archive/refs/tags/vX.Y.Z.tar.gz
2. https://codeload.github.com/tangledup-ai/hermes-web-ui/tar.gz/refs/tags/vX.Y.Z
```

并确认设备可以访问：

- `https://registry.npmjs.org`
- `https://github.com/tangledup-ai/hermes-web-ui`
- `https://codeload.github.com`

## 运维基线

请长期保留以下基线信息：

- systemd 服务名：`hermes-web-ui`
- systemd 环境文件：`/etc/default/hermes-web-ui`
- 服务启动命令：`/opt/node-v23/bin/node /opt/hermes-web-ui/dist/server/index.js`
- 健康检查地址：`http://127.0.0.1:6060/health`
- npm 包名：`@quanthermes/hermes-web-ui`
- 更新源标签：`Quanthermes npm`
- 源码更新脚本：`/opt/hermes-web-ui/scripts/update-source-deploy.sh`
- 源码更新仓库：`https://github.com/tangledup-ai/hermes-web-ui`
