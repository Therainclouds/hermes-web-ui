# 07. 分阶段实施计划

- 状态：in-progress
- 负责人：Cloud
- 最后更新时间：2026-06-11
- 依赖：前序全部设计文档

## 实施总原则

- 先做模块收敛，再做新策略接入。
- 先做检测和可观测性，再做执行闭环。
- 每个阶段都应具备独立验收标准，避免一次性大改。

## 已确认边界

- 第一阶段优先做“边界保护 + 模块收敛”，暂不进入 `device-package` 执行闭环。
- 兼容优先：不强制迁移现有设备目录结构，尤其不强制修改当前 `HERMES_HOME_DIR` 历史布局。
- 保护优先：更新实现必须识别真实数据路径，不能只依赖固定目录名或运维习惯。
- `Web UI` 数据目录继续保持默认位置，即 `HERMES_WEB_UI_HOME` 默认落在用户家目录下。
- 需要保护的真实数据至少包括：
  - `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`
  - `UPLOAD_DIR`
  - `HERMES_HOME_DIR` / `HERMES_HOME`
- 风险控制采用分级策略，而不是一刀切：
  - 低风险：正常更新
  - 中风险：告警但允许更新
  - 高风险：阻止更新

## 当前进度

### 已完成

- 已同步边界、风险分级、兼容策略到工作文档。
- 已新增专项开发规则文档 `10-development-rules.md`。
- 已完成共享更新模块首批收敛：
  - `types.ts`
  - `errors.ts`
  - `version-compare.ts`
  - `runtime-paths.ts`
  - `preflight.ts`
  - `strategies/npm-package.ts`
  - `strategies/source-deploy.ts`
- 已将 `health.ts` 版本比较逻辑迁移到共享模块。
- 已将 `update.ts` 接入统一 preflight 和风险分级返回。
- 已完成 `source-deploy` 脚本侧的真实数据路径保护。
- 已完成 focused server tests，并补充新增测试文件。

### 进行中

- 任务 A：更新不清空用户数据
  - 当前进度：第一阶段核心保护逻辑已落地，仍需继续补充运行手册与目标环境验证。
- 任务 B：更新进度可视化
  - 当前进度：B1 过渡版核心能力已落地，已完成单任务状态模型、状态查询接口、侧边栏阶段展示和失败摘要。
- 任务 B1-1：基础更新闭环可靠性收口
  - 当前进度：已落地 `controller owner -> runtime owner` handoff，完成 heartbeat/stale recovery、共享 task state helper，以及 `source-deploy` / `device-package` 状态语义统一。
- 任务 C：更新能力与预检显式化
  - 当前进度：已新增 `update capabilities` 能力接口，统一暴露支持矩阵、运行态配置、预检风险和运维路径。
- 阶段 P3：更新执行闭环
  - 当前进度：已完成 P3-A 最小执行闭环，正在推进 P3-B，补齐任务状态持久化、健康检查与自动回退。

### 未开始

- 阶段 P5：回滚增强与通道化

### 任务 C：更新能力与预检显式化

- 当前状态：in-progress
- 已完成：
  - 已扩展 `packages/server/src/services/update/types.ts`，新增：
    - `UpdateCapabilities`
    - 更细粒度的 `UpdateTaskStage`
    - 运行态依赖安装、运行时停止/启动等阶段占位
  - 已扩展 `packages/server/src/config.ts`，新增：
    - `WEBUI_UPDATE_AUTO_INSTALL_DEPENDENCIES`
    - `WEBUI_UPDATE_MIN_FREE_SPACE_BYTES`
  - 已增强 `packages/server/src/services/update/preflight.ts`：
    - 补充更新状态目录、staging 目录、日志目录写权限检查
    - 补充最低剩余磁盘空间检查
    - 设备侧强预检默认仅在非 Windows 运行态执行，避免开发机误拦截
  - 已为 `update` 模块新增正式能力接口：
    - `GET /api/hermes/update/capabilities`
  - 已让前端 `appStore` 和侧边栏消费能力接口，显示：
    - 预检告警
    - 阻断信息
    - 自动安装依赖、回滚、校验等能力元数据
  - 已补 focused regression tests：
    - `tests/server/update-preflight.test.ts`
    - `tests/server/update-controller.test.ts`
    - `tests/client/app-store.test.ts`
- 待完成：
  - 将 `device-package` 安装器阶段与能力接口进一步对齐，补足依赖安装与运行态切换的真实阶段落盘
  - 在独立更新中心 UI 中展示能力详情、运维路径与恢复建议

## 专项任务清单

### 任务 A：更新不清空用户数据

- 当前状态：in-progress
- 已完成：
  - 已明确 `Web UI` 数据、上传数据、`Hermes` 数据与程序目录边界
  - 已新增真实路径识别与 preflight 分级
  - 已在 `source-deploy` 和 `npm-package` 路径前接入统一 preflight
  - 已在 `update-source-deploy.sh` 中落地脚本侧保护
  - 已补充相关测试与工作文档同步
- 待完成：
  - 在具备 bash 的目标环境或 CI 中完成 shell 语法/行为补验
  - 做一次设备侧或接近设备环境的更新链路验收

- 优先级：最高
- 目标：把“更新应用不清空聊天历史、配置和上传数据”做成硬约束，而不是依赖运维习惯。
- 核心范围：
  - 明确 `Web UI` 数据、上传数据、`Hermes` 数据与程序部署目录的边界
  - 以真实路径识别为准，而不是只依赖目录名保留名单
  - 增加更新前 preflight 检查
  - 对明显危险布局阻止更新，对历史兼容布局保留告警但允许更新
  - 明确自动回退只回退程序版本，不回滚用户数据
- 建议变更文件：
  - `packages/server/src/config.ts`
  - `packages/server/src/controllers/update.ts`
  - `packages/server/src/services/update/types.ts`
  - `packages/server/src/services/update/errors.ts`
  - 新增 `packages/server/src/services/update/runtime-paths.ts`
  - 新增 `packages/server/src/services/update/preflight.ts`
  - `packages/server/src/services/update/strategies/source-deploy.ts`
  - `packages/server/src/services/update/strategies/npm-package.ts`
  - `scripts/install-device-package.sh`
  - `scripts/update-source-deploy.sh`
  - `docs/deploy-update-runbook.md`
  - `docs/update-distribution/05-device-update-flow.md`
  - `tests/server/update-runtime-paths.test.ts`
  - `tests/server/update-preflight.test.ts`
- 验收标准：
  - `Web UI` 默认数据目录继续位于用户家目录，不修改现有默认策略
  - 更新前能识别真实数据路径，并对危险布局做出分级处理
  - 当前 `HERMES_HOME_DIR` 历史兼容布局不会被直接判死
  - 更新和回退都不会删除用户数据目录
  - 文档中明确写出“更新不清空用户数据”的产品承诺和技术前提

### 任务 B：更新进度可视化

- 当前状态：in-progress
- 当前阶段：B1 过渡版
- 已完成：
  - 已新增单任务状态模型与 `task-store`
  - 已新增正式更新状态查询接口
  - 已让前端轮询状态接口而不是仅依赖 `/health`
  - 已在侧边栏展示更新阶段和失败摘要
  - 已新增 runtime owner / heartbeat 语义，杜绝正常重启被误判为失败
  - 已让 `source-deploy` / `device-package` 通过共享 `update-task-state.py` 写入真实运行态结果
  - 已新增 `10` 轮 managed source-deploy handoff 自动化回归
  - 已补充 server/client 测试
- 待完成：
  - 结合后续 `device-package` 执行链路补齐更细粒度阶段
  - 在后续阶段补齐真实下载百分比展示
- 本轮范围：
  - 基于现有 `source-deploy` / `npm-package` 更新链路增加单任务状态模型
  - 增加正式更新状态查询接口
  - 前端改为轮询状态接口，而不是仅依赖 `/health`
  - 先展示阶段级进度和失败摘要，暂不实现真实下载百分比

- 优先级：高
- 目标：让用户在更新时能看到明确进度，而不是只看到“正在更新”。
- 核心范围：
  - 增加更新任务状态模型
  - 提供正式更新状态查询接口
  - 前端展示阶段进度、下载进度和失败原因摘要
- 建议变更文件：
  - `packages/server/src/controllers/update.ts`
  - `packages/server/src/routes/update.ts`
  - `packages/server/src/services/update/task-store.ts`
  - `packages/server/src/services/update/strategies/device-package.ts`
  - `packages/client/src/api/hermes/system.ts`
  - `packages/client/src/stores/hermes/app.ts`
  - `tests/server/update-task-store.test.ts`
  - `tests/server/device-package-strategy.test.ts`
  - `tests/client/app-store.test.ts`
- 验收标准：
  - 用户可看到至少阶段级进度
  - 下载阶段在可获取 `Content-Length` 时显示真实百分比
  - 更新失败时可看到简明错误状态和结果
  - 前端不再只依赖 `/health` 猜测更新是否完成

## 阶段 P1：更新模块收敛

- 当前状态：completed
- 完成说明：
  - 已完成版本比较逻辑收敛
  - 已完成目录保护逻辑共享模块化
  - 已完成 `source-deploy` / `npm-package` 统一 preflight 接入
  - 已完成相关 server focused tests

目标：把版本比较、策略分发、错误码从 controller 中抽离。

建议变更文件：

- `packages/server/src/config.ts`
- `packages/server/src/controllers/health.ts`
- `packages/server/src/controllers/update.ts`
- 新增 `packages/server/src/services/update/types.ts`
- 新增 `packages/server/src/services/update/errors.ts`
- 新增 `packages/server/src/services/update/version-compare.ts`
- 新增 `packages/server/src/services/update/runtime-paths.ts`
- 新增 `packages/server/src/services/update/preflight.ts`
- 新增 `packages/server/src/services/update/strategies/source-deploy.ts`
- 新增 `packages/server/src/services/update/strategies/npm-package.ts`

验收标准：

- `health` 不再使用简单 `!==` 判断更新。
- `source-deploy` 和 `npm-package` 进入执行前都经过统一 preflight。
- 目录保护逻辑从 controller 和脚本局部规则收敛到共享模块。
- 原有旧策略行为不变。
- 相关 server 测试通过。

## 阶段 P2：接入 manifest 检测

- 当前状态：completed
- 已完成：
  - 新增 `manifest-client`
  - 扩展 `config.update` 的 manifest 检测字段
  - 让 `health` 优先走 manifest，失败时回退旧 npm 检测链路
  - 同步前端 health 类型和 store 字段
  - 同步任务日志与进度记录
- 已验证：
  - `manifestUrl` 直连检测
  - `manifestBaseUrl + channel` 组装检测
  - manifest 失败时回退旧 npm registry 检测
  - 前端可接收更新源、通道、策略和包类型字段

目标：先让系统看见自有更新源最新版本。

建议变更文件：

- 新增 `packages/server/src/services/update/manifest-client.ts`
- 修改 `packages/server/src/controllers/health.ts`
- 修改 `packages/client/src/api/hermes/system.ts`
- 修改 `packages/client/src/stores/hermes/app.ts`
- 新增 `tests/server/update-manifest-client.test.ts`

验收标准：

- 配置 `device-package` 后可通过 manifest 得到最新版本。
- UI 可展示更新源、通道与是否可更新。
- 旧配置不受影响。

## 阶段 P3：更新执行闭环

- 当前状态：in-progress
- 当前阶段：P3-B 健康检查与自动回退
- 已完成：
  - 已扩展 `config.update`，新增安装器、staging、backup 和 healthcheck 配置字段
  - 已扩展更新任务阶段，补齐 `checking / downloading / verifying / backing_up / health_checking / rolled_back`
  - 已让 `manifest-client` 支持执行阶段严格字段校验
  - 已新增 `packages/server/src/services/update/strategies/device-package.ts`
  - 已让 `update.ts` 接入 `device-package` 分支，完成 manifest 解析、兼容性校验、包下载校验和安装器启动
  - 已新增 `scripts/install-device-package.sh`，实现解包、结构校验、程序备份、受控替换和 `update-only` 重建
  - 已在 `task-store` 中补齐 JSON 持久化、原子写入和跨实例恢复
  - 已让 `update.ts` 在模块初始化与状态查询时从磁盘同步任务状态，并让 `device-package` 成功结果改为等待脚本落盘
  - 已让 `install-device-package.sh` 成为 `device-package` 的状态事实源，负责：
    - 写入 `logPath`
    - 推进 `backing_up / installing / restarting / health_checking / succeeded / rolled_back`
    - 健康检查失败后自动恢复 `BACKUP_DIR`
    - 回退后再次执行 `update-only` 重建并做回退健康检查
  - 已收敛 `source-deploy` / `device-package` 的 `.sh` 脚本执行命令构造：
    - Windows 下先解析 `bash` / `bash.exe`
    - 找不到 `bash` 时在 `spawn` 前以 `UpdateError(update_execution_misconfigured)` 失败
  - 已统一 `update.ts` 中脚本缺失场景的错误类型：
    - `WEBUI_UPDATE_SCRIPT` / `WEBUI_UPDATE_INSTALLER_SCRIPT` 缺失时统一改为 `UpdateError`
  - 已将上述约束同步到 `docs/update-distribution/10-development-rules.md`
  - 已新增 focused tests：
    - `tests/server/source-deploy-strategy.test.ts`
    - `tests/server/device-package-strategy.test.ts`
    - `tests/server/update-manifest-client.test.ts`
    - `tests/server/update-controller.test.ts`
    - `tests/server/update-task-store.test.ts`
- 本轮已验证：
  - `task-store` 可持久化 `currentTask / lastTask` 并由新实例恢复
  - `updateStatus()` 可从磁盘读取已落盘的任务结果
  - `device-package` 安装器启动环境已包含 `stateFile / logDir / taskId / healthcheck*`
  - focused tests 通过：
    - `npm run test -- tests/server/update-task-store.test.ts tests/server/update-controller.test.ts tests/server/device-package-strategy.test.ts tests/server/config.test.ts`
  - Windows 下 `.sh` 更新脚本执行命令解析与缺少 `bash` 的结构化失败路径已验证：
    - `npm run test -- tests/server/device-package-strategy.test.ts tests/server/source-deploy-strategy.test.ts tests/server/update-controller.test.ts`
- 待完成：
  - 在具备 bash 的目标环境中补设备包安装器实际行为验证
  - 在运维文档中补齐设备包状态文件、日志目录和回退观测项
  - 通过桥接版本完成旧设备从 `source-deploy` 到 `device-package` 的真实迁移验收

目标：实现下载、校验、安装、状态查询和自动回退。

建议变更文件：

- 新增 `packages/server/src/services/update/task-store.ts`
- 新增 `packages/server/src/services/update/strategies/device-package.ts`
- 修改 `packages/server/src/routes/update.ts`
- 修改 `packages/server/src/controllers/update.ts`
- 新增 `scripts/install-device-package.sh`
- 兼容修改 `scripts/update-source-deploy.sh`
- 新增 `tests/server/device-package-strategy.test.ts`
- 新增 `tests/server/update-task-store.test.ts`

验收标准：

- 任务状态可查询。
- `sha256` mismatch 会终止安装。
- 健康检查失败会自动回退。

## 阶段 P4：发布闭环

- 当前状态：in-progress
- 已完成：
  - 已将 `manifestBaseUrl + channel` 的稳定入口协议切换为 `channel/latest.json`
  - 已新增 `scripts/build-device-package.mjs`，负责：
    - 生成 `hermes-web-ui-device-vX.Y.Z.tar.gz`
    - 生成 `manifest.json`
    - 生成 `hermes-web-ui-device-vX.Y.Z.tar.gz.sha256`
    - 生成 `releases/<channel>/latest.json`
    - 校验设备包中 `dist/`、`package.json`、`package-lock.json` 与安装脚本结构
  - 已新增 `package.json` 脚本入口：
    - `npm run build:device-package`
  - 已新增 `.github/workflows/device-package-release.yml`，负责：
    - 独立执行 focused validation
    - 构建设备包发布产物
    - 上传 GitHub Release 资产
    - 更新 `release-manifests` 分支上的 `latest.json`
    - 执行发布后校验并保留 workflow artifact / summary
  - 已新增 `.github/device-package-release.json`，将 `P4` 发布参数收敛到版本化配置文件
  - 已修复两个 `P4` 稳定性问题：
    - 自动 tag 发布不再把 `minCurrentVersion` 默认写成 `0.0.0`
    - `latest.json` 发布后校验不再依赖 Raw CDN 的即时刷新
  - 已完成一轮面向 `P5` 的前置架构收敛：
    - 新增 `packages/server/src/services/update/device-package-contract.ts`，收敛设备包协议中的：
      - `channel` segment 规范
      - `artifactFormat`
      - Node 兼容范围语义
      - 设备包最小文件结构
    - 新增 `packages/server/src/services/update/package-info.ts`，收敛 `health.ts` / `update.ts` 的本地包信息与版本读取逻辑
    - 已将 `device-package` 的 Node 兼容协议从 `compatibleNodeMajor` 收敛为 `compatibleNodeRange`
    - manifest 消费端保留对旧字段 `compatibleNodeMajor` 的兼容读取，并统一归一到新范围语义
  - 已修复三个本轮确认的 `P4` 闭环风险：
    - `channel` 路径规则改为统一 slug 规范，避免发布路径与消费 URL 漂移
    - Node 兼容判断不再使用“major 必须完全相等”，避免未来 Node 升级后的误拦截
    - workflow 发布后已补真实设备包下载与 `sha256` 校验，避免 CI 绿但设备首次下载失败
  - 已更新专项设计文档：
    - `03-package-spec.md`
    - `04-release-flow.md`
    - `06-env-and-config.md`
- 本轮已验证：
  - `manifestBaseUrl + channel` 现在会解析到 `latest.json`
  - 设备包构建脚本会生成设备包、`manifest.json`、`sha256` 与 `latest.json`
  - 设备包构建产物结构与当前安装器要求一致
  - 发布元数据缺失时，构建脚本会显式失败，而不是静默放宽升级兼容保护
  - `release-manifests` 校验已改为基于远端 git 内容的确定性校验
  - `channel` 规范非法时，构建脚本与 manifest URL 生成会显式失败
  - 新的 Node 兼容范围协议已覆盖：
    - 新字段 `compatibleNodeRange`
    - 旧字段 `compatibleNodeMajor` 的向后兼容归一
    - `^` / `~` 对缺失 minor / patch 的范围上界语义已补强
  - `health.ts` / `update.ts` 的本地版本读取已共享同一模块
  - focused tests 通过：
    - `npm run test -- tests/server/build-device-package-script.test.ts tests/server/update-manifest-client.test.ts tests/server/device-package-strategy.test.ts tests/server/update-controller.test.ts tests/server/health-controller.test.ts tests/server/config.test.ts`
    - `npm run test -- tests/server/device-package-contract.test.ts tests/server/device-package-strategy.test.ts`
  - `npm run build` 通过
- 待完成：
  - 在包含 staging 修复的正式发布版本上完成 `device-package-release.yml` 的复验，确认 release 资产上传与 `release-manifests` 分支推送通过
  - 根据首次真实发布结果决定是否需要额外保留 `beta/latest.json` 占位文件
- 首次真实发布验收记录：
  - 已在组织仓库以 `workflow_dispatch + v0.6.14` 启动首次真实发布验收
  - 首轮失败点位于 `Build device package release`
  - 已确认失败根因不是 tag 或仓库 remote，而是 `scripts/build-device-package.mjs` 的 staging 目录设计
  - 原实现把 staging 放在 `dist/device-package-release/.stage`，随后又整体复制仓库 `dist/`，导致 CI 上稳定触发递归复制错误
  - 已按最小范围修复为系统临时目录 staging，并补 focused regression test，当前等待复验
  - 已补充 runbook 中基于 `release-manifests` 的配置示例、发布后校验步骤和设备侧消费验收准备
  - 已将镜像基础验收与更新链路验收拆分，避免“设备能开机”与“设备可消费更新”混为一谈
  - 后续排查已确认组织仓库 `v0.6.14` tag 仍指向修复前提交 `22e905a8`，而 staging 修复位于后续提交 `db03a684`
  - 同时已确认 `0.6.14` 已存在于 npm，不能再以同版本做规范复发
  - 因此 `P4` 已切换到规范修复路径：以包含 staging 修复的新版本 `0.6.15` 完成组织仓库正式发布与复验
  - 现场旧设备进一步暴露出桥接升级阻塞：
    - Linux 上 `.sh` 更新脚本原先按“直接执行脚本路径”构造命令
    - 仓库内 `scripts/update-source-deploy.sh` 与 `scripts/install-device-package.sh` 的 git mode 为 `100644`
    - 旧设备页面更新因此在 `spawn ... EACCES` 之前就失败，无法进入脚本主体
  - 当前修复路径已收敛为最小桥接补丁：
    - 将共享 shell 命令构造统一改为 `bash <script>.sh`
    - 让 `deploy-source-armbian.sh` 在 `update-only` 场景保留 `device-package` 相关环境变量
    - 用桥接版本完成旧设备从 `source-deploy` 到 `device-package` 的一次迁移升级

目标：CI 自动产出设备包、摘要和 manifest。

建议变更文件：

- 新增 `scripts/build-device-package.mjs`
- 新增 `.github/workflows/device-package-release.yml`
- 修改 `package.json`

验收标准：

- tag 发布后可自动生成设备包。
- manifest、摘要和设备包地址稳定可访问。
- 发布后校验通过。

## 阶段 P5：回滚增强与通道化

- 当前状态：not-started

目标：在自动回退基础上，增加可控回滚和多通道能力。

建议变更文件：

- 修改 `packages/server/src/routes/update.ts`
- 修改 `packages/server/src/controllers/update.ts`
- 修改 `packages/client/src/stores/hermes/app.ts`
- 修改安装器脚本与回滚脚本

验收标准：

- 支持指定可回滚版本。
- 支持 `stable` / `beta` 通道分离。
- 回滚链路有完整日志和状态记录。

## 不进入首批实现的事项

- 桌面端统一更新器
- Docker 更新模式
- 更新控制台
- 前端完整更新中心页面
- 签名验签

## 文档与实现映射

- 本目录文档用于实现前的设计依据。
- 后续每进入一个阶段，需在 `change-log.md` 记录：
  - 开始日期
  - 修改范围
  - 风险
  - 验收结果
