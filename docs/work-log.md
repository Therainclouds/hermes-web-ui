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

## 2026-06-17

### 本轮目标

- 定位设备部署后 `hermes-web` 聊天全部失效、但 `hermes` CLI 正常的问题根因。
- 修复 `device-package` 在线更新入口未进入受控 runner 的链路错误。
- 在真实设备上完成“手动引导版本 + 网页下一跳更新”的闭环验收。

### 问题现象

- 设备部署后，`hermes-web` 中所有聊天失效，但同机 `hermes` CLI 可正常使用。
- Web UI 检测到新版本后，点击更新没有进入 `device-package` 链路，而是错误落入旧的 npm/CLI restart 分支。
- 设备侧日志出现旧路径报错：
  - `Updated package CLI not found`
- 更新时没有生成以下 runner 侧产物：
  - `update-runner-request.json`
  - `update-task-state.json`
  - 新的 `device-package-*.log`

### 根因结论

- 聊天故障根因落在 `agent bridge worker` 启动链：wheel/venv 部署下，worker 会错误回退到源码模式查找 `run_agent.py`，导致 `profile worker ... exited before ready`，从而引发 Web UI 聊天不可用。
- 在线更新根因落在服务端更新入口：`packages/server/src/controllers/update.ts` 中的 `handleUpdate()` 没有按 `config.update.strategy` 分流到 `device-package` / `source-deploy` 的受控 runner，而是继续无条件走旧的 npm 安装 + CLI restart 路径。

### 代码修复

- 修复 `packages/server/src/controllers/update.ts`：
  - 让 `handleUpdate()` 按策略分流：
    - `device-package`：manifest 解析、兼容性检查、下载校验、写入 runner 请求、启动 `hermes-web-ui-update.service`
    - `source-deploy`：走 managed runner
    - `npm-package`：保留旧链路，但按 registry 解析出的真实版本安装，不再硬编码 `latest`
  - 增加 registry 版本解析逻辑，避免安装目标与发布版本不一致。
  - 补齐 managed update 响应体，返回任务状态、阶段和 `taskId`。
  - 修复并发更新时的进程内锁清理竞态，避免第二次请求提前解除更新保护。
  - 强化失败信息落盘，保留 `stderr` / `UpdateError.details` 便于设备排障。
- 更新 `packages/server/src/services/update/errors.ts`：
  - 新增 `update_registry_query_failed`
  - 新增 `update_registry_invalid`
- 更新 `tests/server/update-controller.test.ts`：
  - 同步 `device-package` 真实入口行为
  - 覆盖并发更新锁
  - 覆盖 runner 路径断言
  - 覆盖 registry 失败细节

### 本地验证

- 已完成 `GetDiagnostics` 检查，改动文件无新增诊断错误。
- 已通过最小相关测试：
  - `npm run test -- tests/server/update-controller.test.ts`
- 结果：
  - `22 passed (22)`

### 版本与设备验收

- 由于 `0.6.17` 的 npm 发布失败但 Release 成功，同版本号存在内容不一致风险，因此放弃将其作为最终统一发布基线，只保留其作为测试设备引导版本。
- 测试设备先手动引导到 `0.6.17`，用于获取已修复更新器的运行基线。
- 设备在 `0.6.17` 上复测通过：
  - `hermes-web` 聊天恢复正常
  - `hermes` CLI 继续正常
- 随后在真实设备上通过 Web UI 完成 `0.6.17 -> 0.6.18` 在线更新验证。
- 更新成功后确认：
  - 页面更新链路恢复
  - 设备版本完成切换
  - 聊天功能在更新后仍正常

### 本轮结论

- 设备聊天失效问题已修复。
- `device-package` 在线更新链路已修复，并经过真实设备“引导版本 + 下一跳网页更新”闭环验证。
- 后续设备若已处于修复版基线，可继续按 Web UI 在线更新流程升级，不需要再依赖人工替换部署目录。
