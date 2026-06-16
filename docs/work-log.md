# Work Log

## 2026-06-16

### 本轮目标

- 保留并核实 Quanthermes 自定义更新链路。
- 清理前端和站点中的官方外链入口。
- 修复合并后导致本地无法稳定验证的关键问题。
- 为旧设备和正式发版准备可执行的运维基线。

### 已完成事项

- 核实并保留了 Quanthermes 的设备更新链路：
  - `device-package`
  - `source-deploy`
  - OSS 主源 + `release-manifests` 回退
- 核实了更新权限自修复逻辑仍在：
  - `scripts/hermes-web-ui-update-runner.sh`
  - `scripts/install-device-package.sh`
- 修复了前端侧边栏运行时错误，恢复设置入口交互：
  - `resolveDeviceUrls is not defined`
- 重置本地开发数据库并确认默认账号链路仍可用：
  - 用户名 `quanthermes`
  - 密码 `12345678`
- 删除了页面、官网和 README 中最直接的官方跳转入口。
- 修正了发布基线：
  - npm 发布名收口为 `@quanthermes/hermes-web-ui`
  - 补齐 `check:release-consistency`
  - 补齐 `test:device-package-release`
  - 补齐 `build:device-package`
- 修正了设备发布配置漂移：
  - `.github/device-package-release.json` 回到 `0.6.15`
- 新增旧设备一次性 bootstrap 脚本：
  - `scripts/bootstrap-device-from-v0.6.14-to-v0.6.15.sh`

### 当前发布口径

- `0.6.15` 是正式基线版本。
- `0.6.14` 旧设备不要直接依赖网页升级进入新链路。
- `0.6.14` 设备先执行一次：
  - `bootstrap-device-from-v0.6.14-to-v0.6.15.sh`
- 设备进入 `0.6.15` 后，再通过网页更新验证 `0.6.16`。

### 当前命名口径

- npm 发布包名：`@quanthermes/hermes-web-ui`
- 设备包文件名：`hermes-web-ui-device-vX.Y.Z.tar.gz`
- 桌面打包标识已改为 Quanthermes 命名，避免与官方桌面分发重名：
  - `packages/desktop/package.json`
  - `packages/desktop/electron-builder.yml`

### 待执行发布顺序

1. 合并到主分支并同步组织仓库。
2. 以当前基线正式发布 `v0.6.15`。
3. 用旧设备脚本把 `0.6.14` 设备拉到 `0.6.15`。
4. 将版本推进到 `0.6.16`。
5. 通过网页更新完成最后一轮 `0.6.15 -> 0.6.16` 验证。
