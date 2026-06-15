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

- 当前源码部署自更新链路会在替换 `hermes-web-ui` 前，先串行升级 `hermes-agent` 到最新稳定版
- `hermes-agent` 升级失败时，整次 `hermes-web-ui` 更新直接中止，不继续覆盖部署目录
- `anthropic` 版本默认不固定；只有显式设置 `HERMES_ANTHROPIC_VERSION` 时，自更新链路才会额外 pin 该 SDK
- Docker 部署链路不在本轮调整范围内

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
- 备份目录：`${HERMES_WEB_UI_HOME}/updates/backups`
- staging 目录：`${HERMES_WEB_UI_HOME}/updates/staging`

默认约定：

- `GET /api/hermes/update/status` 会在服务启动后和每次查询前从状态文件同步
- 设备包安装器会写入 `logPath`
- 受控更新服务以 `root` 执行安装器，但会把状态文件、日志目录和请求文件修正回 `hermesui` 可读写
- 安装器会在执行结束后清理本次 staging 临时目录
- 备份目录默认只保留最近 `2` 份 `last-known-good-*`，更旧的备份会自动清理
- 若自定义 `staging` 或 `backups` 目录仍落在 `DEPLOY_DIR` 内，安装器会直接拒绝执行
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
6. 更新脚本下载 tag 源码包，并先调用新源码里的 `deploy-source-armbian.sh` 升级 `hermes-agent` 最新稳定版。
7. 若 `hermes-agent` 升级失败，整次更新中止，不覆盖当前 `hermes-web-ui` 部署目录。
8. `hermes-agent` 升级成功后，更新脚本覆盖部署目录，再调用 `deploy-source-armbian.sh` 的 `update-only` 模式重建与自检。

### device-package

1. 服务启动后按 `WEBUI_UPDATE_MANIFEST_URL`、`WEBUI_UPDATE_MANIFEST_URLS` 或 `WEBUI_UPDATE_MANIFEST_BASE_URL + WEBUI_UPDATE_CHANNEL` 解析 `latest.json`。
2. `/health` 返回最新版本、更新源标签、策略、通道和包类型。
3. 用户点击更新后，后端下载 `latest.json` 指向的设备包并校验 `sha256`。
4. 安装器解包到 staging 目录，校验最小结构，并先调用新包里的 `deploy-source-armbian.sh` 升级 `hermes-agent` 最新稳定版。
5. 若 `hermes-agent` 升级失败，整次更新直接中止，不替换当前部署目录。
6. `hermes-agent` 升级成功后，安装器创建部署目录备份，执行受控替换，再调用 `deploy-source-armbian.sh` 的 `update-only` 模式重建。
7. 安装器执行 `/health` 健康检查。
8. 若健康检查失败，则恢复备份并再次执行 `update-only`，最终把结果写入状态文件。

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
- 页面触发更新时，服务端会先写入更新请求文件，再通过 `sudo systemctl start hermes-web-ui-update.service` 触发固定 root 更新服务
- `hermes-web-ui` 与 `hermes-agent` 常驻进程继续运行在 `hermesui`；只有受控更新服务短暂以 `root` 执行
- 若运维需要直接执行脚本，仍建议 `update-source-deploy.sh` 保持 `root:root` 且 `755`
- `hermesui` 需要一条最小 sudoers 规则，允许免密启动受控更新服务，而不是直接执行更新脚本

推荐 sudoers：

```bash
Defaults:hermesui env_reset,use_pty,log_output,secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Defaults!/usr/bin/systemctl !setenv
Defaults!/usr/bin/journalctl !setenv

Cmnd_Alias HERMES_WEB_UI_UPDATE = /usr/bin/systemctl start hermes-web-ui-update.service, /usr/bin/systemctl status hermes-web-ui-update.service, /usr/bin/journalctl -u hermes-web-ui-update.service -n 200 --no-pager

hermesui ALL=(root) NOPASSWD: HERMES_WEB_UI_UPDATE
```

### device-package 推荐变量

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes OSS + release-manifests
WEBUI_UPDATE_STRATEGY=device-package
WEBUI_UPDATE_PACKAGE_TYPE=device-package
WEBUI_UPDATE_CHANNEL=stable
WEBUI_UPDATE_MANIFEST_BASE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases
WEBUI_UPDATE_MANIFEST_URLS=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/stable/latest.json,https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/stable/latest.json
WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh
WEBUI_UPDATE_RUNNER_SERVICE=hermes-web-ui-update.service
WEBUI_UPDATE_RUNNER_REQUEST_FILE=/home/hermesui/.hermes-web-ui/updates/update-runner-request.json
WEBUI_UPDATE_VERIFY_SHA256=true
WEBUI_UPDATE_STAGING_DIR=/home/hermesui/.hermes-web-ui/updates/staging
WEBUI_UPDATE_BACKUP_DIR=/home/hermesui/.hermes-web-ui/updates/backups
WEBUI_UPDATE_BACKUP_RETENTION_COUNT=2
WEBUI_UPDATE_HEALTHCHECK_URL=http://127.0.0.1:6060/health
WEBUI_UPDATE_STATE_FILE=/home/hermesui/.hermes-web-ui/updates/update-task-state.json
WEBUI_UPDATE_LOG_DIR=/home/hermesui/.hermes-web-ui/updates/logs
WEBUI_UPDATE_MANIFEST_TIMEOUT_MS=30000
WEBUI_UPDATE_PACKAGE_TIMEOUT_MS=300000
WEBUI_UPDATE_DOWNLOAD_RETRIES=3
WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS=2000
WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=60000
WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=2000
WEBUI_UPDATE_HEALTHCHECK_RETRIES=15
WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=5000
HERMES_AGENT_UPDATE_MANIFEST_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/stable/latest.json
HERMES_AGENT_WHEELHOUSE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/wheelhouse/
```

说明：

- 若同时配置 `WEBUI_UPDATE_MANIFEST_URL`、`WEBUI_UPDATE_MANIFEST_URLS` 和 `WEBUI_UPDATE_MANIFEST_BASE_URL`，服务端会按顺序依次尝试 manifest 源
- `WEBUI_UPDATE_MANIFEST_BASE_URL` 应指向当前主分发源的 `releases` 根路径，不要直接带 `latest.json`
- 当前推荐把 OSS `latest.json` 放在首位，把 GitHub `release-manifests` 放在回退位
- `latest.json` 现在可同时携带 `packageUrl` 和 `packageUrls`，推荐把 OSS 直链放在首位、GitHub Release 放在回退位
- 页面触发更新时，服务端会先写入更新请求文件，再通过 `sudo systemctl start hermes-web-ui-update.service` 触发固定 root 更新服务
- `hermes-web-ui` 与 `hermes-agent` 常驻进程继续运行在 `hermesui`；只有受控更新服务短暂以 `root` 执行
- device-package 更新成功后，`deploy-source-armbian.sh` 会显式重启 `hermes-web-ui.service` 完成 cutover，并在自检里确认 `/health` 返回的新 `webui_version` 已与磁盘版本一致
- `deploy-source-armbian.sh` 的 `update-only` 重建流程必须保留上面这组 `device-package` 变量，否则旧设备会在重建后失去 manifest 配置
- `WEBUI_UPDATE_RUNNER_SERVICE` 应与设备上的受控更新服务名一致，默认是 `hermes-web-ui-update.service`
- `WEBUI_UPDATE_RUNNER_REQUEST_FILE` 是服务端写入的请求文件位置，默认位于 `HERMES_WEB_UI_HOME/updates/update-runner-request.json`
- `WEBUI_UPDATE_VERIFY_SHA256` 在第一阶段建议保持 `true`
- `WEBUI_UPDATE_STAGING_DIR` 与 `WEBUI_UPDATE_BACKUP_DIR` 必须位于运行时状态目录，不要放在 `DEPLOY_DIR` 内
- `WEBUI_UPDATE_BACKUP_RETENTION_COUNT` 默认保留最近 `2` 份备份；若不配置，安装器仍按 `2` 处理
- `WEBUI_UPDATE_MANIFEST_TIMEOUT_MS` 控制 `latest.json` / `manifest.json` 拉取超时
- `WEBUI_UPDATE_PACKAGE_TIMEOUT_MS` 控制设备包下载超时
- `WEBUI_UPDATE_DOWNLOAD_RETRIES` 与 `WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS` 会对 manifest 和设备包下载一起生效；当现场到 GitHub 不稳定时，仍应优先依赖 OSS 主源
- `HERMES_AGENT_UPDATE_MANIFEST_URL` 指向 OSS 上维护的 `hermes-agent/stable/latest.json`
- `HERMES_AGENT_WHEELHOUSE_URL` 指向 OSS wheelhouse，脚本会优先使用 `--no-index --find-links` 从国内源安装依赖

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
- 更新服务文件：`/etc/systemd/system/hermes-web-ui-update.service`
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
WEBUI_UPDATE_RUNNER_SERVICE=hermes-web-ui-update.service
WEBUI_UPDATE_RUNNER_REQUEST_FILE=/home/hermesui/.hermes-web-ui/updates/update-runner-request.json
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
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes OSS + release-manifests
WEBUI_UPDATE_STRATEGY=device-package
WEBUI_UPDATE_PACKAGE_TYPE=device-package
WEBUI_UPDATE_CHANNEL=stable
WEBUI_UPDATE_MANIFEST_BASE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases
WEBUI_UPDATE_MANIFEST_URLS=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/stable/latest.json,https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/stable/latest.json
WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh
WEBUI_UPDATE_RUNNER_SERVICE=hermes-web-ui-update.service
WEBUI_UPDATE_RUNNER_REQUEST_FILE=/home/hermesui/.hermes-web-ui/updates/update-runner-request.json
WEBUI_UPDATE_VERIFY_SHA256=true
WEBUI_UPDATE_STAGING_DIR=/opt/hermes-web-ui/.releases/staging
WEBUI_UPDATE_BACKUP_DIR=/opt/hermes-web-ui/.releases/backups
WEBUI_UPDATE_HEALTHCHECK_URL=http://127.0.0.1:6060/health
WEBUI_UPDATE_STATE_FILE=/home/hermesui/.hermes-web-ui/updates/update-task-state.json
WEBUI_UPDATE_LOG_DIR=/home/hermesui/.hermes-web-ui/updates/logs
WEBUI_UPDATE_MANIFEST_TIMEOUT_MS=30000
WEBUI_UPDATE_PACKAGE_TIMEOUT_MS=300000
WEBUI_UPDATE_DOWNLOAD_RETRIES=3
WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS=2000
WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS=60000
WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS=2000
WEBUI_UPDATE_HEALTHCHECK_RETRIES=15
WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS=5000
HERMES_AGENT_UPDATE_MANIFEST_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/stable/latest.json
HERMES_AGENT_WHEELHOUSE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/wheelhouse/
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
5. `device-package-release.yml` 会读取仓库内的 `release/hermes-agent-stable.json`，自动把本次绑定的 `hermes-agent` 稳定 wheel、wheelhouse 和 `stable/latest.json` 同步到 OSS。
6. 用以下命令确认 npm 上已经有新版本：

```bash
npm view @quanthermes/hermes-web-ui version
```

7. 打开本次 `device-package-release` workflow summary，记录：

- tag
- channel
- manifest branch
- latest URL
- hermes-agent stable version

8. 对照下文“发布后校验”完成人工复核。

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
- `packageUrls`
- `sha256`
- `minCurrentVersion`
- `compatibleNodeRange`

### 4. 检查 OSS 与 GitHub 真实下载

```bash
curl -fsSL "https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/vX.Y.Z/hermes-web-ui-device-vX.Y.Z.tar.gz" -o /tmp/hermes-device-package-oss.tar.gz
sha256sum /tmp/hermes-device-package-oss.tar.gz
```

```bash
curl -fsSL "<packageUrl>" -o /tmp/hermes-device-package-github.tar.gz
sha256sum /tmp/hermes-device-package-github.tar.gz
```

预期：

- 两次下载都成功
- 两次输出摘要与 `latest.json` 中的 `sha256` 一致

### 5. 检查 hermes-agent OSS 元数据

```bash
curl -fsSL "https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/stable/latest.json"
```

预期至少包含：

- `version`
- `wheelUrl`
- `wheelUrls`
- `wheelhouseUrl`

说明：

- 正常发布路径下，这个文件会由 `device-package-release.yml` 自动生成并上传
- 仅当需要补传或重建 `hermes-agent` OSS 元数据时，才手工触发 `.github/workflows/hermes-agent-oss-mirror.yml`

### 6. 检查 manifest.json 回读一致性

确认 Release 下载到的 `manifest.json` 与 `release-manifests` 分支按版本归档的 `manifest.json` 一致。

### 7. 记录验收留痕

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
WEBUI_UPDATE_MANIFEST_BASE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases
WEBUI_UPDATE_MANIFEST_URLS=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/stable/latest.json,https://raw.githubusercontent.com/tangledup-ai/hermes-web-ui/release-manifests/releases/stable/latest.json
WEBUI_UPDATE_INSTALLER_SCRIPT=/opt/hermes-web-ui/scripts/install-device-package.sh
WEBUI_UPDATE_RUNNER_SERVICE=hermes-web-ui-update.service
WEBUI_UPDATE_VERIFY_SHA256=true
HERMES_AGENT_UPDATE_MANIFEST_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/stable/latest.json
HERMES_AGENT_WHEELHOUSE_URL=https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/hermes-agent/wheelhouse/
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
- `error`

若下载阶段失败，`error` 里现在会附带底层网络细节，例如：

- `code`
- `timeoutMs`
- `attempts`
- `primary` / `fallback` 传输错误

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
- `WEBUI_UPDATE_RUNNER_SERVICE` 与设备上的受控更新服务名一致

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

- `hermes-agent` 最新稳定版 release 元数据解析失败
- `hermes-agent` 最新稳定版 wheel 下载或安装失败
- `WEBUI_UPDATE_MANIFEST_BASE_URL` 写错
- `WEBUI_UPDATE_INSTALLER_SCRIPT` 缺失或没有执行权限
- `WEBUI_UPDATE_RUNNER_SERVICE` 不存在或未被 sudoers 放行
- `packageUrl` 不可下载
- GitHub 网络瞬时抖动导致 manifest 或设备包下载超时，需结合 `error` 中的 `attempts` / `timeoutMs` / `ETIMEDOUT` / `ECONNRESET` 判断
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
- 受控更新服务：`hermes-web-ui-update.service`
- 兼容源码更新脚本：`/opt/hermes-web-ui/scripts/update-source-deploy.sh`
- manifest branch：`release-manifests`
