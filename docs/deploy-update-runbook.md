# 部署更新运行手册

## 目标

这份手册用于保证 Quanthermes 自定义版本在后续发布和部署后，始终可以稳定检测到 npm 上的新版本，并在 Web UI 中触发自更新。

## 当前发布约定

- npm 包名：`@quanthermes/hermes-web-ui`
- npm Registry：`https://registry.npmjs.org`
- 全局安装命令：`npm install -g @quanthermes/hermes-web-ui`
- 运行命令：`hermes-web-ui start`
- GitHub Actions 发布：推送 `v*` tag 触发 `.github/workflows/npm-publish.yml`

## 自更新工作原理

1. 服务启动时读取 `WEBUI_UPDATE_*` 环境变量。
2. 后端通过 `/health` 返回当前版本、npm 最新版本、更新源标签和是否可更新。
3. 前端轮询 `/health`。
4. 当 `webui_version < webui_latest` 时，sidebar 底部显示更新按钮。
5. 用户点击更新后，服务端执行：
   - `npm install -g @quanthermes/hermes-web-ui@latest`
   - 重启当前 Web UI 服务
6. 浏览器检测到服务版本变化后自动刷新。

## 必需环境变量

源码部署、systemd 部署或一键部署脚本都必须提供以下变量：

```bash
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_DIST_TAG=latest
```

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
LANG=C.UTF-8
LC_ALL=C.UTF-8

WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_DIST_TAG=latest
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
- 用户点击后可自动安装更新并重启

## 一键部署脚本必须保证的内容

后续任何源码打包脚本或一键部署脚本，必须满足：

1. 写入 `/etc/default/hermes-web-ui`
2. 写入全部 `WEBUI_UPDATE_*` 变量
3. 重启 `hermes-web-ui`
4. 自动执行一次环境变量和 `/health` 验证
5. 任一检查失败时退出并提示错误

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
```

并确认设备可以访问：

- `https://registry.npmjs.org`
- npm 包 `@quanthermes/hermes-web-ui`

## 运维基线

请长期保留以下基线信息：

- systemd 服务名：`hermes-web-ui`
- systemd 环境文件：`/etc/default/hermes-web-ui`
- 服务启动命令：`/opt/node-v23/bin/node /opt/hermes-web-ui/dist/server/index.js`
- 健康检查地址：`http://127.0.0.1:6060/health`
- npm 包名：`@quanthermes/hermes-web-ui`
- 更新源标签：`Quanthermes npm`
