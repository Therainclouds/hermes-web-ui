# 方案变更记录

## 2026-06-07

### 新增

- 建立 `docs/update-distribution/` 目录，作为设备端自有更新包分发方案的统一索引。
- 建立 `docs/adr/` 目录，作为本主题的决策记录目录。
- 输出需求、架构、更新包规范、发布流程、设备更新流程、配置设计、实施计划、验证与回退文档。

### 已确认结论

- 主服务常驻非 `root`，安装阶段短时提权。
- 登录用户可触发升级到当前官方稳定版。
- 更新包以自有下载源为主，不再依赖 GitHub tag archive 作为长期方案。
- 首发以 `tar.gz` 设备包 + `sha256` + manifest 为基础。
- MVP 先做失败自动回退，后续再做指定版本回滚。

### 仍未确认

- 自有下载源承载介质
- 版本发现源是否第一阶段立即切到 manifest
- 安装器具体提权实现方式

### 任务清单更新

- 新增专项任务 A：`更新不清空用户数据`，并提升为最高优先级。
- 新增专项任务 B：`更新进度可视化`，作为高优先级并行专项。
- 在 `07-implementation-plan.md` 中补充了两个专项任务的目标、范围、建议变更文件与验收标准，便于拆分到其他会话独立执行。

## 2026-06-08

### 新增

- 新增 `09-manual-source-upgrade-sop.md`，沉淀设备端源码包手工升级标准操作流程。

### 现场结论沉淀

- 明确源码包手工升级前必须先校验压缩包完整性。
- 明确整目录替换前必须单独保护 `hermes_data`。
- 明确源码包覆盖后必须重新执行 `deploy-source-armbian.sh` 的 `update-only` 流程，不能只依赖 `systemd` 直接启动。
- 明确 `/health` 版本比较修复已在设备端验证生效，可作为后续手工升级后的验收项。

## 2026-06-09

### 边界确认

- 确认第一阶段先做“边界保护 + 模块收敛”，暂不直接进入 `device-package` 执行闭环。
- 确认第一阶段的主要目标是“更新不覆盖用户数据”，而不是强制统一现场目录结构。
- 确认 `Web UI` 默认数据目录继续保持在用户家目录下，不修改当前默认策略。
- 确认需要保护的真实数据至少包括：
  - `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`
  - `UPLOAD_DIR`
  - `HERMES_HOME_DIR` / `HERMES_HOME`

### 技术结论

- 确认 `Web UI` 聊天历史并不只存在于 `Hermes` 数据目录；当前普通聊天的 session/message 已由 `Web UI` 本地 SQLite 持久化。
- 确认当前 `HERMES_HOME_DIR=${DEPLOY_DIR}/hermes_data` 属于历史兼容布局，第一阶段需要兼容处理，不直接判死。
- 确认目录保护应基于真实路径识别，而不是只依赖固定目录名保留名单。
- 确认目录风险控制采用分级策略：
  - 低风险：正常更新
  - 中风险：告警但允许更新
  - 高风险：阻止更新

### 计划调整

- 更新 `07-implementation-plan.md`，将任务 A 与阶段 P1 收敛到“真实数据路径保护 + preflight + 模块收敛”。
- 更新 `05-device-update-flow.md`，补充第一阶段已确认边界、兼容策略与分级治理原则。
- 新增 `10-development-rules.md`，作为本轮执行阶段的专项开发规则基线。
- 更新 `open-questions.md`，将本轮已确认项与已关闭问题单独沉淀，避免后续重复讨论。

### 下一步

- 下一步执行按“先同步工作文档，再进入代码实施”推进。
- 实施阶段优先修改：
  - `config.update` 及目录事实源解析
  - `runtime-paths / preflight`
  - `source-deploy / npm-package` 统一接入 preflight
  - `update-source-deploy.sh` 脚本侧真实数据路径保护

### 实施进展

- 新增 `10-development-rules.md`，作为本轮执行阶段的专项开发规则基线。
- 已新增共享模块：
  - `packages/server/src/services/update/types.ts`
  - `packages/server/src/services/update/errors.ts`
  - `packages/server/src/services/update/version-compare.ts`
  - `packages/server/src/services/update/runtime-paths.ts`
  - `packages/server/src/services/update/preflight.ts`
  - `packages/server/src/services/update/strategies/npm-package.ts`
  - `packages/server/src/services/update/strategies/source-deploy.ts`
- 已将 `health.ts` 的版本比较逻辑收敛到共享模块。
- 已将 `update.ts` 接入统一 preflight，并在危险布局下返回阻止结果。
- 已让 `source-deploy` 更新在脚本侧根据真实数据路径做二次保护。
- 已让 `deploy-source-armbian.sh` 在 `update-only` 场景保留 `HERMES_WEB_UI_HOME` 与 `UPLOAD_DIR` 配置，不再回写成固定默认值。

### 验证结果

- 已通过 focused server tests：
  - `npm run test -- tests/server/config.test.ts tests/server/health-controller.test.ts tests/server/update-controller.test.ts tests/server/update-runtime-paths.test.ts tests/server/update-preflight.test.ts tests/server/version-compare.test.ts`
- 尝试执行 shell 语法检查：
  - `bash -n scripts/update-source-deploy.sh`
  - `bash -n scripts/deploy-source-armbian.sh`
- 当前执行环境缺少 `/bin/bash`，因此 shell 语法检查未在本地完成，需要在具备 bash 的目标环境或 CI 中补验。

### 任务日志更新

- 已将 `07-implementation-plan.md` 状态从 `draft` 更新为 `in-progress`。
- 已在实施计划中补充“当前进度”分区，区分：
  - 已完成
  - 进行中
  - 未开始
- 已将任务状态明确为：
  - 任务 A：`in-progress`
  - 阶段 P1：`completed`
  - 任务 B / 阶段 P2 / P3 / P4 / P5：`not-started`
- 已补充任务 A 的剩余事项：
  - bash 环境补验
  - 设备侧或近似设备环境验收

### 文档补齐

- 已回写 `docs/deploy-update-runbook.md`，补充当前已实现的数据保护边界、风险分级、兼容布局处理和运维验收项。
- 已同步更新任务 A 的剩余事项，去除已完成的运行手册回写项。

### 任务 B 启动

- 已启动任务 B 的 B1 过渡版实施。
- 本轮目标是先为当前 `source-deploy` / `npm-package` 更新链路补齐：
  - 单任务状态模型
  - 正式状态查询接口
  - 前端阶段展示与失败摘要
- 本轮不进入 `device-package`、manifest 检测和真实下载百分比展示。

### 任务 B 实施进展

- 已新增 `packages/server/src/services/update/task-store.ts`，用于维护单任务状态和最近一次结果。
- 已扩展 `packages/server/src/services/update/types.ts`，补充更新任务状态、阶段与状态查询返回结构。
- 已新增 `GET /api/hermes/update/status`，并让 `POST /api/hermes/update` 返回 `taskId / status / stage`。
- 已让 `update.ts` 在版本解析、启动、安装、重启、失败等关键阶段写入任务状态。
- 已改造前端 `system.ts`、`app.ts` 和 `AppSidebar.vue`：
  - 轮询正式状态接口
  - 展示阶段级进度
  - 展示失败摘要
- 已新增或更新测试：
  - `tests/server/update-task-store.test.ts`
  - `tests/server/update-controller.test.ts`
  - `tests/client/app-store.test.ts`
  - `tests/client/sidebar-search.test.ts`

### 任务 B 验证结果

- 已通过 focused tests：
  - `npm run test -- tests/server/update-controller.test.ts tests/server/update-task-store.test.ts tests/client/app-store.test.ts tests/client/sidebar-search.test.ts`

### 阶段 P2 启动

- 已启动 `P2：接入 manifest 检测`。
- 本轮目标：
  - 新增 `manifest-client`
  - 扩展 `config.update` 的 manifest 配置
  - 扶正 `health` 检测优先级
  - 保持旧 npm 检测链路兼容
- 本轮要求继续同步实施计划与变更日志，保证检测链路改造过程可追溯。

### 阶段 P2 实施进展

- 已新增 `packages/server/src/services/update/manifest-client.ts`，用于解析配置、拉取 manifest 并输出统一检测结果。
- 已扩展 `packages/server/src/config.ts`：
  - 新增 `manifestUrl`
  - 新增 `manifestBaseUrl`
  - 新增 `channel`
  - 新增 `packageType`
  - 将 `device-package` 纳入更新策略枚举
- 已改造 `packages/server/src/controllers/health.ts`：
  - 优先走 manifest 检测
  - manifest 失败时回退旧 npm registry 检测
  - 补充 `webui_update_channel / strategy / package_type`
- 已改造前端：
  - `packages/client/src/api/hermes/system.ts`
  - `packages/client/src/stores/hermes/app.ts`
  - `packages/client/src/components/layout/AppSidebar.vue`
  - 新增更新源与通道展示

### 阶段 P2 验证结果

- 已通过 focused tests：
  - `npm run test -- tests/server/config.test.ts tests/server/health-controller.test.ts tests/server/update-manifest-client.test.ts tests/client/app-store.test.ts tests/client/sidebar-search.test.ts`

### 阶段 P3 启动

- 已启动 `P3：更新执行闭环`，当前先推进 `P3-A` 最小执行闭环。
- 本轮目标：
  - 接入 `device-package` 执行策略
  - 严格校验 manifest 执行字段
  - 下载设备包并校验 `sha256`
  - 新增受控安装器 `install-device-package.sh`
  - 保持任务 A 的目录保护边界不被新链路绕过

### 阶段 P3-A 实施进展

- 已扩展 `packages/server/src/services/update/types.ts`：
  - 增加执行期所需配置字段
  - 扩展任务阶段枚举
  - 新增 `DevicePackageManifest`
- 已扩展 `packages/server/src/services/update/errors.ts`，新增 manifest、下载、校验、安装器相关错误码。
- 已扩展 `packages/server/src/services/update/manifest-client.ts`，支持执行阶段严格 manifest 校验。
- 已新增 `packages/server/src/services/update/strategies/device-package.ts`，负责：
  - manifest 解析
  - 当前版本/Node 兼容性检查
  - 设备包下载与 `sha256` 校验
  - 组装安装器命令与环境变量
- 已改造 `packages/server/src/controllers/update.ts`：
  - 接入 `device-package` 分支
  - 异步推进 `checking / downloading / verifying / backing_up / installing`
  - 对无效注入版本号回退使用 `package.json` 版本，避免兼容性判断失真
- 已新增 `scripts/install-device-package.sh`，实现：
  - 设备包解包与结构校验
  - 程序目录备份
  - 数据目录保护
  - 替换部署树并调用 `deploy-source-armbian.sh update-only`

### 阶段 P3-A 验证结果

- 已通过 focused tests：
  - `npm run test -- tests/server/update-controller.test.ts tests/server/device-package-strategy.test.ts tests/server/update-manifest-client.test.ts tests/server/config.test.ts`
- 当前仍未在具备 bash 的目标设备环境中完成真实安装验收，该项保留到后续环境验证阶段。

### 阶段 P3-B 实施进展

- 已扩展 `packages/server/src/services/update/task-store.ts`：
  - 新增 JSON 持久化和原子落盘
  - 新增 `syncFromDisk()`，支持跨实例恢复 `currentTask / lastTask`
  - 修复阶段更新时把 `undefined` 落入状态文件的问题，避免恢复时被判定为非法记录
- 已改造 `packages/server/src/controllers/update.ts`：
  - 模块启动和 `GET /api/hermes/update/status` 时先从磁盘同步状态
  - `device-package` 安装器启动后，成功结果不再由控制器直接判定，而是等待脚本落盘结果
- 已改造 `scripts/install-device-package.sh`：
  - 新增状态文件写入协议
  - 新增任务日志文件落盘
  - 新增更新后健康检查
  - 新增健康检查失败后的自动回退、回退重建和回退健康检查
- 已补充 focused tests：
  - `tests/server/update-task-store.test.ts`
  - `tests/server/update-controller.test.ts`
  - 覆盖持久化恢复、状态查询和 `device-package` 安装器环境变量

### 阶段 P3-B 验证结果

- 已通过 focused tests：
  - `npm run test -- tests/server/update-task-store.test.ts tests/server/update-controller.test.ts tests/server/device-package-strategy.test.ts tests/server/config.test.ts`
- 当前 Windows 本地环境仍不具备目标设备 bash/systemd 运行条件，因此：
  - 尚未对 `install-device-package.sh` 执行真实设备级联调
  - 自动回退链路仍需在目标设备或 CI 的 Linux/bash 环境补行为验收

### Windows 脚本执行与错误语义收敛

- 已确认并修复 `source-deploy` / `device-package` 在 Windows 下硬编码 `bash` 的问题：
  - 执行 `.sh` 更新脚本前，先通过共享逻辑解析 `bash` / `bash.exe`
  - 若当前 Windows 环境缺少 `bash`，在 `spawn` 前以 `UpdateError(update_execution_misconfigured)` 失败
- 已确认并修复更新控制器中脚本缺失场景使用通用 `Error` 的问题：
  - `WEBUI_UPDATE_SCRIPT` / `WEBUI_UPDATE_INSTALLER_SCRIPT` 缺失时统一改为 `UpdateError`
- 已同步到专项开发规则：
  - `docs/update-distribution/10-development-rules.md`
- 已补充 focused tests：
  - `tests/server/source-deploy-strategy.test.ts`
  - `tests/server/device-package-strategy.test.ts`
  - `tests/server/update-controller.test.ts`
- 已通过 focused tests：
  - `npm run test -- tests/server/device-package-strategy.test.ts tests/server/source-deploy-strategy.test.ts tests/server/update-controller.test.ts`

### 阶段 P4 启动：发布闭环

- 已确认第一阶段 `P4` 继续使用 `latest.json` 作为稳定更新入口，不把下载速度优化纳入本轮目标。
- 已确认第一阶段下载承载方案：
  - 设备包、`sha256` 和版本 `manifest.json` 继续使用 GitHub Release
  - `latest.json` 和按版本归档的 manifest 元数据使用 `release-manifests` 分支
- 已确认发布工作流拆分方案：
  - 保留现有 `npm-publish.yml`
  - 新增独立 `device-package-release.yml`
- 已完成协议收敛：
  - `manifestBaseUrl + channel` 现在解析到 `channel/latest.json`
- 已新增 `scripts/build-device-package.mjs`，可生成：
  - `hermes-web-ui-device-vX.Y.Z.tar.gz`
  - `hermes-web-ui-device-vX.Y.Z.tar.gz.sha256`
  - `manifest.json`
  - `releases/<channel>/latest.json`
- 已新增 `.github/workflows/device-package-release.yml`，当前职责包括：
  - focused validation
  - 设备包构建
  - GitHub Release 资产上传
  - `release-manifests` 分支更新
  - 发布后校验与 artifact/summary 留痕
- 已新增 `.github/device-package-release.json`，用版本化配置文件显式记录本次设备包发布的：
  - `version`
  - `channel`
  - `minCurrentVersion`
  - `manifestBranch`
  - `healthcheckUrl`
- 已修复两个 `P4` 稳定性问题：
  - 自动 tag 发布不再默认把 `minCurrentVersion` 写成 `0.0.0`
  - `latest.json` 发布后校验从 Raw URL 切换为远端 git 内容校验，避免 CDN 刷新时延导致误报失败
- 已补充 focused tests：
  - `tests/server/build-device-package-script.test.ts`
  - `tests/server/update-manifest-client.test.ts`
- 已通过 focused tests：
  - `npm run test -- tests/server/update-manifest-client.test.ts tests/server/build-device-package-script.test.ts tests/server/device-package-strategy.test.ts tests/server/update-controller.test.ts`
- 当前剩余事项：
  - 在真实 GitHub Actions 环境验证 `device-package-release.yml`
  - 根据首次真实发布结果补充运维配置示例与发布验收记录

### 阶段 P4 风险修复与 P5 前置收敛

- 已基于本轮审计结论收敛三个直接发布风险：
  - `channel` 目录路径与客户端消费 URL 统一为同一套 slug 规范
  - Node 兼容协议从 `compatibleNodeMajor` 收敛为 `compatibleNodeRange`
  - 发布工作流新增对真实设备包资产下载与 `sha256` 的发布后校验
- 已新增共享模块：
  - `packages/server/src/services/update/device-package-contract.ts`
  - `packages/server/src/services/update/package-info.ts`
- 当前共享模块已承担：
  - 设备包 `channel` segment 规范
  - 设备包最小结构约束
  - Node 兼容范围判断
  - `health.ts` / `update.ts` 的本地版本读取与包信息解析
- 为保证兼容性，manifest 消费端已支持：
  - 新字段 `compatibleNodeRange`
  - 旧字段 `compatibleNodeMajor` 到范围语义的归一转换
- 已补充 / 更新 focused tests：
  - `tests/server/build-device-package-script.test.ts`
  - `tests/server/update-manifest-client.test.ts`
  - `tests/server/device-package-strategy.test.ts`
  - `tests/server/update-controller.test.ts`
  - `tests/server/health-controller.test.ts`
  - `tests/server/config.test.ts`
- 已完成验证：
  - `npm run test -- tests/server/build-device-package-script.test.ts tests/server/update-manifest-client.test.ts tests/server/device-package-strategy.test.ts tests/server/update-controller.test.ts tests/server/health-controller.test.ts tests/server/config.test.ts`
  - `npm run build`
- 本轮阶段成果总结：
  - `P4` 的最新入口、包协议、发布校验和运行时兼容语义已基本对齐
  - `P5` 后续做多通道、换源或更细兼容策略时，不再直接依赖散落在 controller / build script / manifest parser 中的重复规则

### 设备包 Node 范围语义补强

- 已复核一条关于 `device-package-contract.ts` 的兼容性 issue：
  - “对象传给字符串版 compareSemver 导致兼容性检查失效”不成立，当前实现本身就是对象对对象比较
  - 真实问题在于 `^` / `~` 对缺失 minor / patch 的范围上界语义不完整
- 已修复：
  - `~1` 现在允许 `>=1.0.0 <2.0.0`
  - `~1.2` 现在允许 `>=1.2.0 <1.3.0`
  - `^0.2.3` / `^0.0.3` 按左侧首个非零位的 semver 规则计算上界
- 已新增 focused test：
  - `tests/server/device-package-contract.test.ts`
- 已验证：
  - `npm run test -- tests/server/device-package-contract.test.ts tests/server/device-package-strategy.test.ts`

## 2026-06-10

### P4 首次真实发布验收阻塞修复

- 已在真实 GitHub Actions 首次执行 `device-package-release.yml` 时确认一个真实阻塞：
  - `Build device package release` 步骤会在复制 `dist/` 时失败
  - 根因是 `scripts/build-device-package.mjs` 原先把 staging 目录放在 `dist/device-package-release/.stage`
  - 当脚本继续整体复制仓库 `dist/` 时，会稳定触发“复制到自己的子目录”错误
- 已按最小范围修复：
  - staging 目录改为系统临时目录，不再落在仓库 `dist/` 子树内
  - 构建主流程增加 `try/finally`，确保 staging 在成功或失败后都清理
  - 保持发布输出目录和 `release-metadata.json` 路径不变，避免影响现有 workflow 后续步骤
- 已补充 focused regression test：
  - `tests/server/build-device-package-script.test.ts`
  - 覆盖“输出目录位于 `dist/device-package-release` 时构建仍可成功完成”
- 本轮范围明确保持收敛：
  - 仅修复首次真实发布的当前阻塞点
  - 暂不扩展到归档内容进一步瘦身或 `dist/device-package-release` 目录排除策略
- 下一步：
  - 运行最小必要 diagnostics 与 focused tests
  - 重新触发 `device-package-release.yml` 验证真实发布链路

### P4 收口文档与设备验收准备

- 已按保守收口方式推进 `P4`：
  - 不重复扩大到默认策略切换
  - 不修改 `source-deploy` 默认入口
  - 先把发布后校验、runbook 和设备侧消费验收准备补齐
- 已更新 `docs/deploy-update-runbook.md`：
  - 明确区分兼容模式和 `device-package` 推荐模式
  - 补充 `release-manifests` 配置示例
  - 补充 Release 资产、`latest.json`、真实下载和 `sha256` 的发布后校验步骤
  - 补充状态文件、日志目录、备份目录和自动回退观测项
- 已更新 `docs/update-distribution/08-validation-and-rollback.md`：
  - 将验证矩阵收敛为发布侧、设备侧、回退侧的可执行检查项
- 已更新 `docs/device-image.md` 与 `scripts/verify-device-image.sh`：
  - 明确镜像基础验收不等于更新链路验收
  - 为镜像验收脚本补充最小更新链路探针，但不在脚本中直接触发升级
- 本轮结论：
  - `P4` 当前剩余主项收敛为“真实 GitHub Actions 复验结果确认”
  - 文档、runbook 和设备侧验收准备已不再是阻塞项

### P4 真实复验二次排查与规范发布策略

- 在继续复验时，已进一步确认本次失败并非 workflow 定义问题，而是“发布对象版本面错位”：
  - 组织仓库 `v0.6.14` tag 仍指向修复前提交 `22e905a8`
  - staging 修复位于后续提交 `db03a684`
  - 组织仓库 `org/main` 也尚未包含该修复，因此 Actions checkout 后仍执行旧版 `build-device-package.mjs`
- 已同时确认：
  - `0.6.14` 已存在于 npm registry
  - 因此不能再以 `v0.6.14` 做规范重发，否则 `npm-publish` 会继续因为重复版本失败
- 已决定采用规范修复路径而非强改旧 tag：
  - 新正式发布版本改为 `0.6.15`
  - 同步更新 `package.json`、`package-lock.json` 与 `.github/device-package-release.json`
  - 下一步要求在包含 staging 修复的组织仓库代码上发布 `v0.6.15`，再执行 `device-package-release.yml` 复验

## 2026-06-11

### 旧设备桥接升级阻塞修复

- 已在现场旧设备 `0.6.14 -> 0.6.17` 排查中确认真实根因：
  - 页面更新失败不是下载或解包问题
  - 根因是 Linux 运行时把 `.sh` 更新脚本当作可执行文件直接 `spawn`
  - 仓库内 `scripts/update-source-deploy.sh` 与 `scripts/install-device-package.sh` 的 git mode 为 `100644`
  - 因此旧设备会稳定命中 `spawn ... EACCES`
- 已按最小范围修复共享脚本执行策略：
  - `packages/server/src/services/update/strategies/script-command.ts`
  - 统一要求先解析 `bash`，再以 `bash <script>.sh` 执行 shell 更新脚本
  - 不再把“脚本文件本身具备执行位”作为页面更新成功的前提
- 已同步 focused tests：
  - `tests/server/source-deploy-strategy.test.ts`
  - `tests/server/device-package-strategy.test.ts`
  - `tests/server/update-controller.test.ts`
  - 统一改为断言 Linux / Windows 都走 bash 包装，缺少 bash 时返回统一结构化错误

### update-only 配置回写修复

- 已确认 `deploy-source-armbian.sh` 的 `write_service_env()` 原先只回写 `source-deploy` 变量
- 该行为会导致设备即使通过 `device-package` 安装成功，只要后续进入 `update-only` 重建，就把 `/etc/default/hermes-web-ui` 中的 manifest 配置覆盖丢失
- 已扩展回写变量集合，补齐：
  - `WEBUI_UPDATE_MANIFEST_URL`
  - `WEBUI_UPDATE_MANIFEST_BASE_URL`
  - `WEBUI_UPDATE_CHANNEL`
  - `WEBUI_UPDATE_PACKAGE_TYPE`
  - `WEBUI_UPDATE_INSTALLER_SCRIPT`
  - `WEBUI_UPDATE_VERIFY_SHA256`
  - `WEBUI_UPDATE_STAGING_DIR`
  - `WEBUI_UPDATE_BACKUP_DIR`
  - `WEBUI_UPDATE_HEALTHCHECK_URL`
  - `WEBUI_UPDATE_STATE_FILE`
  - `WEBUI_UPDATE_LOG_DIR`
  - `WEBUI_UPDATE_HEALTHCHECK_TIMEOUT_MS`
  - `WEBUI_UPDATE_HEALTHCHECK_INTERVAL_MS`
  - `WEBUI_UPDATE_HEALTHCHECK_RETRIES`
  - `WEBUI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS`
- 目标是保证旧设备桥接到 `device-package` 后，后续重建不会再退回 `source-deploy` 配置

### runbook 同步

- 已更新 `docs/deploy-update-runbook.md`：
  - 明确页面触发更新统一走 `bash <script>.sh`
  - 说明旧设备桥接时 `update-only` 必须保留完整 `device-package` 变量
  - 把设备包示例中的健康检查、状态文件、日志目录变量名同步到当前实现
