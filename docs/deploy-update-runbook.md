# 部署更新运行手册

## 目标

这份手册用于保证 Quanthermes 自定义版本在发布后具备可验证、可配置、可验收的设备更新闭环。

当前仓库同时保留两条更新链路：

- 兼容链路：`npm registry + source-deploy`
- `P4` 发布闭环链路：`release-manifests + device-package`

本手册的目标不是立即切换所有设备默认策略，而是明确：

- 真实发布后该如何校验
- 设备端如何配置 `device-package` 消费
- 运维如何定位状态、日志和自动回退结果

相关文档：

- `docs/update-distribution/04-release-flow.md`
- `docs/update-distribution/08-validation-and-rollback.md`
- `docs/update-distribution/09-manual-source-upgrade-sop.md`

## 当前发布约定

- npm 包名：`@quanthermes/hermes-web-ui`
- npm Registry：`https://registry.npmjs.org`
- npm 发布触发：推送 `v*` tag 到组织仓库，触发 `.github/workflows/npm-publish.yml`
- 设备包发布触发：推送 `v*` tag 或手工触发 `.github/workflows/device-package-release.yml`
- 设备包稳定入口：`release-manifests` 分支下的 `releases/<channel>/latest.json`
- 当前稳定通道：`stable`
- 当前首次部署入口：`scripts/deploy-source-armbian.sh`

## 模式说明

### 兼容模式

- 版本检测来源：npm registry
- 更新执行方式：`source-deploy`
- 页面更新入口：`scripts/update-source-deploy.sh`
- 适用场景：历史设备、尚未切到 `device-package` 配置的现场
- 后端执行约定：统一以 `bash <script>.sh` 启动更新脚本，不再依赖仓库中文件 mode 是否为 `755`

### P4 推荐发布闭环模式

- 版本检测来源：`release-manifests`
- 更新执行方式：`device-package`
- 包格式：`tar.gz + sha256 + manifest.json`
- 适用场景：需要验证或接入第一阶段正式设备包发布链路的设备
- 桥接注意：`deploy-source-armbian.sh` 的 `update-only` 重建流程必须保留整组 `device-package` 环境变量，避免旧设备重建后退回 `source-deploy`

说明：

- 本轮收口只补配置、校验和验收准备
- 本轮不修改 `scripts/deploy-source-armbian.sh` 的默认更新策略
- 因此“推荐模式”并不等于“所有新设备已自动默认启用”

## 当前数据保护边界

当前更新链路已按“真实路径识别 + 风险分级”接入第一阶段保护逻辑。

受保护的数据目录至少包括：

- `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`
- `UPLOAD_DIR`
- `HERMES_HOME_DIR` / `HERMES_HOME`

当前规则如下：

- `Web UI` 默认数据目录继续位于用户家目录下，不要求迁移
- 更新前会先识别真实数据路径，而不是只依赖固定目录名
- 若 `HERMES_WEB_UI_HOME` 或 `UPLOAD_DIR` 位于 `DEPLOY_DIR` 内，更新会被直接阻止
- 若 `HERMES_HOME_DIR` 位于 `DEPLOY_DIR` 内，当前按兼容布局处理
- 历史默认路径如 `${DEPLOY_DIR}/hermes_data` 会给出告警但允许更新
- 更新脚本会显式保留该目录，避免源码同步时被清理
- 第一阶段不会自动迁移任何数据目录，也不会回滚用户数据内容

这意味着：

- 程序更新只替换程序代码、构建产物、脚本和依赖
- 用户聊天历史、上传、配置和 `Hermes` 运行状态不应被更新过程覆盖

## 设备包状态、日志与备份

当更新策略为 `device-package` 时，安装器会把任务状态和日志落在 `Web UI` 数据目录下，默认位置为：

- 状态文件：`${HERMES_WEB_UI_HOME}/updates/update-task-state.json`
- 日志目录：`${HERMES_WEB_UI_HOME}/updates/logs/`
- 备份目录：`${DEPLOY_DIR}/.releases/backups`
- staging 目录：`${DEPLOY_DIR}/.releases/staging`

默认约定：

- `GET /api/hermes/update/status` 会在服务启动后和每次查询前从状态文件同步
- 设备包安装器会写入 `logPath`
- 健康检查失败且自动回退成功后，任务状态会落为 `rolled_back`
- 回退后会在状态文件中保留 `rollbackMessage`
- 设备端排障时应优先核对状态文件、任务日志和 `journalctl`

## 自更新工作原理

### source-deploy

1. 服务启动时读取 `WEBUI_UPDATE_*` 环境变量。
2. 后端通过 `/health` 返回当前版本、npm 最新版本、更新源标签和是否可更新。
3. 用户点击更新后，后端先从 npm registry 解析 `latest` 对应的真实版本号。
4. 后端执行统一 preflight，判断真实数据路径和风险级别。
5. 后台执行 `scripts/update-source-deploy.sh --version <x.y.z>`。
6. 更新脚本下载 tag 源码包，覆盖部署目录，再调用 `deploy-source-armbian.sh` 的 `update-only` 模式重建与自检。

### device-package

1. 服务启动后按 `WEBUI_UPDATE_MANIFEST_URL` 或 `WEBUI_UPDATE_MANIFEST_BASE_URL + WEBUI_UPDATE_CHANNEL` 解析 `latest.json`。
2. `/health` 返回最新版本、更新源标签、策略、通道和包类型。
3. 用户点击更新后，后端下载 `latest.json` 指向的设备包并校验 `sha256`。
4. 安装器解包到 staging 目录，校验最小结构，创建部署目录备份。
5. 安装器执行受控替换，并调用 `deploy-source-armbian.sh` 的 `update-only` 模式重建。
6. 安装器执行 `/health` 健康检查。
7. 若健康检查失败，则恢复备份并再次执行 `update-only`，最终把结果写入状态文件。

## 配置说明

### 兼容模式必需变量

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

- `WEBUI_UPDATE_REGISTRY` 和 `WEBUI_UPDATE_REPO` 不要写反引号，不要留前后空格
- 页面触发更新时，服务端会通过 `bash /opt/hermes-web-ui/scripts/update-source-deploy.sh` 执行脚本，因此不会再因仓库文件 mode 为 `644` 而在 `spawn` 前失败
- 若运维需要直接执行脚本，仍建议 `update-source-deploy.sh` 保持 `root:root` 且 `755`
- `hermesui` 需要一条最小 sudoers 规则，允许免密执行更新脚本

推荐 sudoers：

```bash
hermesui ALL=(root) NOPASSWD:SETENV: /bin/bash /opt/hermes-web-ui/scripts/update-source-deploy.sh *
```

### device-package 推荐变量

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes release-manifests
WEBUI_UPDATE_STRATEGY=device-package
WEBUI_UPDATE_PACKAGE_TYPE=device-package
WEBUI_UPDATE_CHANNEL=stable
WEBUI_UPDATE_MANIFEST_BASE_URL=https://raw.githubusercontent.com/<owner>/<repo>/release-manifests/releases
WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh
WEBUI_UPDATE_VERIFY_SHA256=true
WEBUI_UPDATE_STAGING_DIR=/opt/hermes-web-ui/.releases/staging
WEBUI_UPDATE_BACKUP_DIR=/opt/hermes-web-ui/.releases/backups
WEBUI_UPDATE_HEALTHCHECK_URL=http://127.0.0.1:6060/health
WEBUI_UPDATE_STATE_FILE=/home/hermesui/.hermes-web-ui/updates/update-task-state.json
WEBUI_UPDATE_LOG_DIR=/home/hermesui/.hermes-web-ui/updates/logs
WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=60000
WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=2000
WEBUI_UPDATE_HEALTHCHECK_RETRIES=15
WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=5000
```

说明：

- 若同时配置 `WEBUI_UPDATE_MANIFEST_URL` 和 `WEBUI_UPDATE_MANIFEST_BASE_URL`，以前者为准
- `WEBUI_UPDATE_MANIFEST_BASE_URL` 应指向 `release-manifests/releases` 根路径，不要直接带 `latest.json`
- 页面触发更新时，服务端会通过 `bash /opt/hermes-web-ui/scripts/install-device-package.sh` 执行安装器，因此不会再因仓库文件 mode 为 `644` 而在 `spawn` 前失败
- `deploy-source-armbian.sh` 的 `update-only` 重建流程必须保留上面这组 `device-package` 变量，否则旧设备会在重建后失去 manifest 配置
- `WEBUI_UPDATE_VERIFY_SHA256` 在第一阶段建议保持 `true`

### 与数据保护相关的变量

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

### 兼容模式最小示例

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

### device-package 最小示例

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
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes release-manifests
WEBUI_UPDATE_STRATEGY=device-package
WEBUI_UPDATE_PACKAGE_TYPE=device-package
WEBUI_UPDATE_CHANNEL=stable
WEBUI_UPDATE_MANIFEST_BASE_URL=https://raw.githubusercontent.com/<owner>/<repo>/release-manifests/releases
WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh
WEBUI_UPDATE_VERIFY_SHA256=true
WEBUI_UPDATE_STAGING_DIR=/opt/hermes-web-ui/.releases/staging
WEBUI_UPDATE_BACKUP_DIR=/opt/hermes-web-ui/.releases/backups
WEBUI_UPDATE_HEALTHCHECK_URL=http://127.0.0.1:6060/health
WEBUI_UPDATE_STATE_FILE=/home/hermesui/.hermes-web-ui/updates/update-task-state.json
WEBUI_UPDATE_LOG_DIR=/home/hermesui/.hermes-web-ui/updates/logs
WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=60000
WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=2000
WEBUI_UPDATE_HEALTHCHECK_RETRIES=15
WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=5000
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
4. 等待 GitHub Actions 完成 npm 发布和 `device-package-release.yml`。
5. 用以下命令确认 npm 上已经有新版本：

```bash
npm view @quanthermes/hermes-web-ui version
```

6. 打开本次 `device-package-release` workflow summary，记录：

- tag
- channel
- manifest branch
- latest URL

7. 对照下文“发布后校验”完成人工复核。

## 发布后校验

每次 `device-package-release.yml` 真实发布后，至少完成以下检查。

### 1. 检查 GitHub Release 资产

确认对应 tag 下至少存在：

- `hermes-web-ui-device-vX.Y.Z.tar.gz`
- `hermes-web-ui-device-vX.Y.Z.tar.gz.sha256`
- `manifest.json`

### 2. 检查 manifest branch

确认 `release-manifests` 分支存在以下文件：

- `releases/stable/latest.json`
- `releases/vX.Y.Z/manifest.json`
- `releases/vX.Y.Z/hermes-web-ui-device-vX.Y.Z.tar.gz.sha256`

可使用：

```bash
git fetch origin release-manifests
git show origin/release-manifests:releases/stable/latest.json
```

### 3. 检查 latest.json 内容

确认至少包含：

- `version`
- `channel`
- `packageUrl`
- `sha256`
- `minCurrentVersion`
- `compatibleNodeRange`

### 4. 检查真实下载与 sha256

```bash
curl -fsSL "<packageUrl>" -o /tmp/hermes-device-package.tar.gz
sha256sum /tmp/hermes-device-package.tar.gz
```

预期：

- 下载成功
- 输出摘要与 `latest.json` 中的 `sha256` 一致

### 5. 检查 manifest.json 回读一致性

确认 Release 下载到的 `manifest.json` 与 `release-manifests` 分支按版本归档的 `manifest.json` 一致。

### 6. 记录验收留痕

建议在发布记录中保留：

- GitHub Actions run URL
- 发布 tag
- 发布 channel
- `latest.json` URL
- `packageUrl`
- 摘要校验结果
- 是否需要补发或回退

## 设备侧消费验收

设备切到 `device-package` 配置后，至少做以下检查。

### 1. 检查运行进程是否拿到更新变量

```bash
pid=$(systemctl show -p MainPID --value hermes-web-ui)
tr '\0' '\n' < /proc/$pid/environ | grep WEBUI_UPDATE
```

预期至少包含：

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_STRATEGY=device-package
WEBUI_UPDATE_PACKAGE_TYPE=device-package
WEBUI_UPDATE_CHANNEL=stable
WEBUI_UPDATE_MANIFEST_BASE_URL=https://raw.githubusercontent.com/<owner>/<repo>/release-manifests/releases
WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh
WEBUI_UPDATE_VERIFY_SHA256=true
```

### 2. 检查健康检查接口

```bash
curl http://127.0.0.1:6060/health
```

预期至少包含：

```json
{
  "status": "ok",
  "webui_update_enabled": true,
  "webui_update_strategy": "device-package",
  "webui_update_channel": "stable",
  "webui_update_package_type": "device-package"
}
```

### 3. 检查状态与日志路径

```bash
ls -ld /home/hermesui/.hermes-web-ui/updates
ls -ld /home/hermesui/.hermes-web-ui/updates/logs
```

若已有任务记录，再检查：

```bash
cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json
```

重点关注：

- `status`
- `stage`
- `logPath`
- `rollbackMessage`
- `healthcheckUrl`

### 4. 检查页面表现

预期前端页面左下角：

- 显示更新源标签
- 当存在新版本时显示更新按钮
- 更新过程中显示阶段状态
- 失败后显示失败摘要

### 5. 检查数据目录边界

```bash
grep -E '^(HERMES_HOME|HERMES_WEB_UI_HOME|UPLOAD_DIR)=' /etc/default/hermes-web-ui
```

建议至少确认：

- `HERMES_WEB_UI_HOME` 位于用户家目录或独立数据目录
- `UPLOAD_DIR` 未落在程序源码目录内
- `HERMES_HOME` 如位于 `${DEPLOY_DIR}/hermes_data`，属于兼容布局，可继续运行但应知晓其告警属性

## 常见问题

### `/health` 中 `webui_update_enabled` 为 false

优先检查：

- `WEBUI_UPDATE_ENABLED`
- `WEBUI_UPDATE_STRATEGY`
- `WEBUI_UPDATE_SOURCE_LABEL`

若当前希望走 `device-package`，还要确认：

- `WEBUI_UPDATE_PACKAGE_TYPE=device-package`
- `WEBUI_UPDATE_CHANNEL=stable`
- `WEBUI_UPDATE_MANIFEST_BASE_URL` 或 `WEBUI_UPDATE_MANIFEST_URL` 已正确配置
- `WEBUI_UPDATE_INSTALLER_SCRIPT` 存在且可执行

### 页面没有更新按钮

检查顺序：

1. `curl http://127.0.0.1:6060/health`
2. 确认 `webui_update_enabled` 为 `true`
3. 确认 `webui_latest` 高于 `webui_version`
4. 浏览器强制刷新 `Ctrl + F5`
5. 确认当前运行版本已包含更新按钮对应的前端代码

### 设备升级失败

优先检查：

```bash
journalctl -u hermes-web-ui -n 200 --no-pager
cat /home/hermesui/.hermes-web-ui/updates/update-task-state.json
tail -n 200 /home/hermesui/.hermes-web-ui/updates/logs/*.log
```

常见原因：

- `WEBUI_UPDATE_MANIFEST_BASE_URL` 写错
- `WEBUI_UPDATE_INSTALLER_SCRIPT` 缺失或没有执行权限
- `packageUrl` 不可下载
- `sha256` 校验失败
- `HERMES_WEB_UI_HOME` 或 `UPLOAD_DIR` 被配置到了 `DEPLOY_DIR` 内，导致 preflight 主动阻止
- 安装后健康检查失败，安装器已触发自动回退

若状态文件中出现：

- `status=rolled_back`
- `rollbackMessage`

说明本次更新已自动恢复到上一个可用程序版本，应继续检查任务日志与 `journalctl`。

## 运维基线

请长期保留以下基线信息：

- systemd 服务名：`hermes-web-ui`
- systemd 环境文件：`/etc/default/hermes-web-ui`
- 服务启动命令：`/opt/node-v23/bin/node /opt/hermes-web-ui/dist/server/index.js`
- 健康检查地址：`http://127.0.0.1:6060/health`
- npm 包名：`@quanthermes/hermes-web-ui`
- 设备包安装器：`/opt/hermes-web-ui/scripts/install-device-package.sh`
- 兼容源码更新脚本：`/opt/hermes-web-ui/scripts/update-source-deploy.sh`
- manifest branch：`release-manifests`
