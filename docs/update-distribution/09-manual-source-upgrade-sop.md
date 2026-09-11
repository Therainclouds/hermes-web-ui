# 09. 设备端源码包手工升级 SOP

- 状态：draft
- 负责人：Cloud
- 最后更新时间：2026-06-08
- 适用范围：Linux 设备、`systemd`、源码包覆盖安装、`source-deploy`

## 目标

这份 SOP 用于指导设备端在没有完整自动更新闭环时，安全执行源码包手工升级，避免误删聊天记录、配置、上传目录和 Hermes 运行数据。

适用场景：

- 现场手工上传 `hermes-web-ui-src.tar.gz`
- 需要覆盖 `/opt/hermes-web-ui`
- 需要在保留用户数据的前提下重新构建并重启服务
- 需要在失败时快速回到上一版本

## 本设备默认关键路径

当前设备默认路径如下：

- 代码目录：`/opt/hermes-web-ui`
- 旧代码目录回滚位：`/opt/hermes-web-ui.old`
- Hermes 数据目录：`/opt/hermes-web-ui/hermes_data`
- Web UI 状态目录：`/home/hermesui/.hermes-web-ui`
- 环境文件：`/etc/default/hermes-web-ui`
- 备份目录：`/opt/backups/hermes-web-ui`
- 服务名：`hermes-web-ui.service`
- 运行用户：`hermesui`

## 先决条件

手工升级前，必须满足：

- 已拿到完整源码包 `hermes-web-ui-src.tar.gz`
- 已确认服务路径和状态目录路径
- 已具备 `sudo` 权限
- 已确认磁盘空间足够容纳：
  - 新源码包
  - 数据备份包
  - 一份旧代码目录

## 升级前检查

### 1. 确认服务和路径

```bash
sudo systemctl cat hermes-web-ui.service
sudo cat /etc/default/hermes-web-ui
```

至少确认：

- `ExecStart=/opt/node-v23/bin/node /opt/hermes-web-ui/dist/server/index.js`
- `HERMES_WEB_UI_HOME=/home/hermesui/.hermes-web-ui`
- `HERMES_HOME=/opt/hermes-web-ui/hermes_data`

### 2. 校验源码包完整性

不要直接解压，先校验：

```bash
gzip -t ~/hermes-web-ui-src.tar.gz && echo OK
tar -tzf ~/hermes-web-ui-src.tar.gz | head -n 20
```

预期顶层目录为：

```text
hermes-web-ui/
```

若出现 `unexpected end of file` 或 `Unexpected EOF in archive`，说明源码包损坏或上传未完成，必须重新上传。

## 标准升级步骤

### 步骤 1：停止服务

```bash
sudo systemctl stop hermes-web-ui.service
```

### 步骤 2：备份数据

```bash
sudo mkdir -p /opt/backups/hermes-web-ui
T="$(date +%Y%m%d-%H%M%S)"

sudo tar -czf "/opt/backups/hermes-web-ui/webui-home-$T.tar.gz" \
  -C /home/hermesui .hermes-web-ui

sudo tar -czf "/opt/backups/hermes-web-ui/hermes-data-$T.tar.gz" \
  -C /opt/hermes-web-ui hermes_data

sudo cp /etc/default/hermes-web-ui \
  "/opt/backups/hermes-web-ui/hermes-web-ui.env.$T"
```

备份后确认：

```bash
sudo ls -lh /opt/backups/hermes-web-ui
```

### 步骤 3：保护实时数据

如果接下来准备整目录替换 `/opt/hermes-web-ui`，先把 `hermes_data` 挪走：

```bash
sudo mv /opt/hermes-web-ui/hermes_data /opt/hermes_data.safe
```

注意：

- 这是移动，不是复制
- 一旦执行成功，`/opt/hermes_data.safe` 将成为新的临时数据保护目录
- 后续若已经移回，就不要重复执行 `mv`

### 步骤 4：保留旧代码用于回滚

```bash
sudo mv /opt/hermes-web-ui /opt/hermes-web-ui.old
```

不要立刻删除旧目录，等新版本稳定后再清理。

### 步骤 5：解压新源码包

```bash
cd /opt
sudo tar -xzf ~/hermes-web-ui-src.tar.gz
```

解压完成后应存在：

```bash
/opt/hermes-web-ui
```

### 步骤 6：恢复 Hermes 数据目录

优先顺序如下：

1. 若 `/opt/hermes_data.safe` 存在，直接移回：

```bash
sudo mv /opt/hermes_data.safe /opt/hermes-web-ui/hermes_data
sudo chown -R hermesui:hermesui /opt/hermes-web-ui/hermes_data
```

2. 若 `hermes_data.safe` 已不存在，但备份包存在，则从备份包恢复：

```bash
sudo tar -xzf /opt/backups/hermes-web-ui/hermes-data-YYYYMMDD-HHMMSS.tar.gz -C /opt/hermes-web-ui
sudo chown -R hermesui:hermesui /opt/hermes-web-ui/hermes_data
```

3. 恢复后确认：

```bash
sudo ls -lah /opt/hermes-web-ui/hermes_data
```

### 步骤 7：重新构建并安装

源码包不是可直接运行的最终产物，必须重新跑 `update-only` 部署：

```bash
cd /opt/hermes-web-ui
sudo DEPLOY_UPDATE_ONLY=true \
  DEPLOY_DIR=/opt/hermes-web-ui \
  APP_USER=hermesui \
  PORT=6060 \
  SYSTEMD_SERVICE_NAME=hermes-web-ui.service \
  SERVICE_ENV_FILE=/etc/default/hermes-web-ui \
  HERMES_HOME_DIR=/opt/hermes-web-ui/hermes_data \
  bash scripts/deploy-source-armbian.sh
```

### 步骤 8：验证结果

```bash
curl -sS http://127.0.0.1:6060/health
curl -sS http://127.0.0.1:6060/api/auth/status
sudo systemctl status hermes-web-ui.service --no-pager
```

预期：

- `/health` 返回 `status: ok`
- `webui_version` 为目标版本
- `webui_update_available` 判断正确
- `/api/auth/status` 返回 `hasPasswordLogin`
- `systemd` 状态为 `active (running)`

## 常见故障与处理

### 1. `Unexpected EOF in archive`

原因：

- 源码包上传不完整或已损坏

处理：

- 删除损坏包
- 重新上传
- 先执行 `gzip -t` 和 `tar -tzf` 校验，再解压

### 2. `Cannot find module '/opt/hermes-web-ui/dist/server/index.js'`

原因：

- 当前目录只是源码，尚未生成 `dist`
- 或源码目录不完整

处理：

- 重新执行 `deploy-source-armbian.sh` 的 `update-only` 模式
- 若仍失败，先重解压源码包再重跑

### 3. `/health` 返回正常但脚本仍报 `Health check failed`

原因：

- 自检窗口过严或响应太慢，属于部署脚本误判

处理：

- 以 `/health` 和 `systemctl status` 的实际结果为准
- 记录为已知问题，后续修复部署脚本健康检查逻辑

### 4. `webui_version` 高于 `webui_latest` 但仍显示可更新

原因：

- `/health` 版本比较逻辑错误

处理：

- 热修 `packages/server/src/controllers/health.ts`
- 重新 build 并重启服务

## 回滚步骤

如果新版本失败且旧目录还在：

```bash
sudo systemctl stop hermes-web-ui.service
sudo rm -rf /opt/hermes-web-ui
sudo mv /opt/hermes-web-ui.old /opt/hermes-web-ui
sudo chown -R hermesui:hermesui /opt/hermes-web-ui
sudo systemctl daemon-reload
sudo systemctl start hermes-web-ui.service
```

如果数据目录丢失，再从备份包恢复：

```bash
sudo tar -xzf /opt/backups/hermes-web-ui/hermes-data-YYYYMMDD-HHMMSS.tar.gz -C /opt/hermes-web-ui
sudo chown -R hermesui:hermesui /opt/hermes-web-ui/hermes_data
```

## 升级完成后的收尾

建议：

- 保留 `/opt/hermes-web-ui.old` 至少一个观察周期
- 保留 `/opt/backups/hermes-web-ui/` 的备份包
- 确认新版本稳定后再清理旧代码目录：

```bash
sudo rm -rf /opt/hermes-web-ui.old
```

## 本次现场结论

本次现场升级验证确认：

- 数据目录与代码目录需要严格分离
- 源码包覆盖升级前必须先保护 `hermes_data`
- 源码包升级后必须重新执行 `deploy-source-armbian.sh`
- `/health` 的版本比较逻辑需要使用 semver，而不是简单不相等判断
