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

## 2026-07-03

### 本轮目标

- 评估迁移后的 `skillhub` 专家系统后台接口是否可直接接入当前 Web UI。
- 在不改前端本地 API 契约的前提下，完成专家市场后端迁移适配。
- 修复团队专家安装链路中的结构性问题，避免成员专家“伪安装”。
- 解决迁移过程中引入的后端编译错误、安装下载失败及前端安装状态误判问题。

### 问题现象

- 新提供的专家后台文档使用 `skillhub` 路由和新的数据结构，无法直接替换当前 `/api/experts/*` 链路。
- 当前系统安装链路依赖旧版：
  - 版本化 `manifest` 接口
  - 版本化下载授权接口
  - `category` 字符串字段
  - `team_members[].latest_version`
- 团队专家原安装逻辑没有真实下载成员包，而是直接推导成员目录，存在“状态看似已安装、物理包并不存在”的结构性缺陷。
- 迁移改造过程中多次出现后端 `8647` 启动失败，前端表现为：
  - `502 Bad Gateway`
  - `ECONNREFUSED 127.0.0.1:8647`
  - `socket.io` / `/health` / `/api/hermes/*` 全线失败
- 安装专家时出现 `500 Internal Server Error`，服务端日志为：
  - `InstallError: Failed to parse URL from`
- 安装失败后刷新页面，UI 仍可能显示“已安装”，造成状态假阳性。

### 根因结论

- 新后台 `skillhub` 与旧版专家市场存在多处关键不兼容：
  - 路由前缀由 `/api/experts/*` 改为 `/api/skillhub/expert-catalog/*`
  - `manifest` 不再单独提供版本接口，而是整合进 `latest/` 的 `manifest_json`
  - 下载改为公开流式下载，不再返回旧版的版本化 `DownloadGrant`
  - `category` 从字符串变为对象结构
  - 团队成员详情不再保证包含 `latest_version`
- 团队专家激活链路根因在于安装器与激活器职责边界不完整：
  - 团长包会真实下载和解压
  - 成员仅拉取 manifest 并伪造安装目录，没有真实物理安装
- 本轮开发中出现的前端 502 根因均为后端进程崩溃，而非接口业务失败：
  - 一次是 `marketplace-client.ts` 中对 `unknown` 直接 `.map()`
  - 一次是将 `starterPrompts/defaultSkills` 的处理代码放入错误作用域
  - 一次是 `asOptionalString()` 调用参数个数错误触发 `TS2554`
- 安装接口返回 `500` 的直接根因是新后台在部分场景下返回空 `artifact_url`，旧逻辑把空字符串当成可用 URL，最终在下载阶段触发 `Failed to parse URL from`。
- 安装后“刷新显示已安装”的根因是前端把“存在安装记录”误等同于“安装成功”，没有要求 `status === 'installed'`。

### 代码修复

- 更新 [marketplace-client.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/hermes/experts/marketplace-client.ts)：
  - 实现新旧后台双栈兼容，优先适配 `skillhub`，保留旧接口回退。
  - 将新后台返回结构统一归一化为当前本地专家系统内部契约。
  - 将 `latest.manifest_json` 转换为当前使用的 `ExpertManifest`。
  - 将新后台公开下载流合成为当前安装器需要的 `DownloadGrant`。
  - 修复空 `artifact_url` 回退逻辑，默认落回 `/api/skillhub/expert-catalog/{slug}/download/`。
  - 修复多处 TypeScript 编译问题，恢复后端可启动状态。
- 更新 [activator.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/hermes/experts/activator.ts)：
  - 团队成员缺少 `latest_version` 时，主动调用 `fetchLatest()` 查询成员最新版本。
  - 成员专家改为真实执行下载、解压、激活，不再依赖伪造目录。
- 更新 [orchestrator.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/hermes/experts/orchestrator.ts)：
  - 团队安装时将 `clientId` 继续传递给成员安装链路。
  - 团队卸载时同步清理团长与成员的：
    - profile 绑定
    - 安装记录
    - 物理目录
- 更新 [experts-store.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/db/hermes/experts-store.ts)：
  - 新增按 `parent_team_slug` 查询绑定能力。
  - 新增按 `team_slug` 清理成员安装记录能力。
- 更新前端安装状态判定：
  - [experts.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/stores/hermes/experts.ts) 新增 `findReadyInstalled()`，仅将 `status === 'installed'` 视为真正可用。
  - [ExpertsView.vue](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/ExpertsView.vue)、[ExpertDetailView.vue](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/ExpertDetailView.vue)、[ExpertCard.vue](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/experts/ExpertCard.vue) 改为基于成功安装状态显示“已安装”与“开始对话”。

### 测试与验证

- 新增测试：
  - [hermes-marketplace-client.test.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/tests/server/hermes-marketplace-client.test.ts)
  - [hermes-expert-activator.test.ts](file:///g:/AIproject/longxia_keli/hermes-web-ui/tests/server/hermes-expert-activator.test.ts)
- 覆盖内容：
  - `skillhub` 目录归一化
  - `latest.manifest_json -> ExpertManifest`
  - 空 `artifact_url` 下的下载地址回退
  - 旧接口 404 下的回退策略
  - 团队成员缺失 `latest_version` 时的真实安装
- 已完成 `GetDiagnostics` 检查，相关改动文件无新增诊断错误。
- 已通过最小相关测试：
  - `npm test -- tests/server/hermes-marketplace-client.test.ts`
  - `npm test -- tests/server/hermes-marketplace-client.test.ts tests/server/hermes-expert-activator.test.ts tests/server/experts-config.test.ts`
- 结果：
  - `7 passed (7)`

### 当前状态

- 迁移后的 `skillhub` 官方专家目录已完成服务端适配，前端继续使用本地 `/api/hermes/experts/*` 契约。
- 团队专家安装链路已从“伪安装”改为真实安装。
- 已修复迁移过程中引入的编译错误与下载地址问题。
- 已修复前端“失败记录误显示为已安装”的状态假阳性。
- 当前静态检查与单元测试已通过，但仍需要真实开发环境下继续做一次安装与卸载闭环验证。

### 后续待验证

- 在真实 `skillhub` 环境下验证单专家完整闭环：
  - 列表
  - 详情
  - 安装
  - 启动聊天
- 在真实 `skillhub` 环境下验证团队专家完整闭环：
  - 团长安装
  - 成员安装
  - 卸载清理
- 确认新后台返回的 `manifest_json` 在真实生产数据上始终满足本地转换约束。
- 如需支持“安装历史版本”，需与上游后台重新定义版本化下载接口，不建议继续依赖当前“仅最新版本”的简化模型。
