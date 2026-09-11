# 更新、部署、发布开发规则

- 状态：active
- 负责人：Cloud
- 最后更新时间：2026-07-02
- 适用范围：设备更新、源码部署、设备包发布、页面内更新编排相关改动

## 目标

本文件用于约束设备更新、源码部署和发布契约相关改动，确保执行阶段不偏离已确认边界，并为后续追溯提供统一规则基线。

## 当前开发目标

- 当前阶段先做“边界显式化 + 模块收敛”。
- 当前阶段优先兼容现有 `source-deploy`、`npm-package` 和 `device-package` 三条链路。
- 当前阶段优先减少职责混杂，不追求一次性重写全部脚本。
- 当前阶段不强制统一所有现场设备目录结构。

## 已确认边界

- `Web UI` 默认数据目录继续保持在用户家目录下，即 `HERMES_WEB_UI_HOME` 默认策略不变。
- 需要保护的真实数据至少包括：
  - `HERMES_WEB_UI_HOME` / `HERMES_WEBUI_STATE_DIR`
  - `UPLOAD_DIR`
  - `HERMES_HOME_DIR` / `HERMES_HOME`
- 更新保护以“真实路径识别”为准，不再只依赖固定目录名。
- 当前 `HERMES_HOME_DIR=${DEPLOY_DIR}/hermes_data` 属于历史兼容布局，第一阶段兼容处理，不强制迁移。
- `Web UI Product`、`Hermes Agent Product`、`Device Runtime Product`、`Release And Distribution Product` 必须分开建模。
- Desktop 更新链路不属于设备页面内更新链路。
- 首次安装、日常更新、故障修复不能继续依赖同一个“万能入口脚本”作为长期目标结构。

## 术语规则

- `Web UI update`：页面内发起的 Web UI 版本切换流程。
- `source deploy`：通过源码树同步和重建完成的运行时更新方式。
- `device package`：设备端最小交付包，不等于源码 archive。
- `bootstrap`：设备首次安装和宿主机准备。
- `runtime reconcile`：把确定产物应用到现有运行时并恢复健康状态。
- `release contract`：版本、channel、兼容性、allowlist、manifest schema 等交付契约。

禁止继续使用模糊词汇混指多种概念，例如把 `device package`、源码部署产物和 npm 包都叫“更新包”。

## 实施规则

- 先补共享模块，再改 controller 和 shell 脚本。
- `health` 与 `update` 的重复版本比较逻辑必须收敛到共享模块。
- 更新前必须经过统一 preflight，不允许 controller 直接跳过。
- `source-deploy` 与 `npm-package` 都必须走同一套目录保护判断。
- 页面内更新只负责编排，不负责宿主机初始化。
- Hermes Agent 升级必须显式建模为独立步骤或独立 adapter，不允许继续作为所有 Web UI 更新路径的默认隐式副作用。
- 发布契约字段必须有单一事实源，运行时代码只能消费，不允许重复发明。
- 目录风险采用分级策略：
  - 低风险：正常更新
  - 中风险：告警但允许更新
  - 高风险：阻止更新
- `Web UI` 数据目录与上传目录采用强保护策略。
- `Hermes` 数据目录采用兼容保护策略，避免规则过死导致新的权限纠纷。
- 页面内更新默认只编排 `Web UI update`，不自动升级 Hermes Agent。
- 若某次版本必须同时升级 Hermes Agent，必须在需求评审和发布说明中显式批准，并通过单独开关开启。

## 全流程规则

- 需求评审阶段必须明确本次变更属于哪一类：产品功能、运行时修复、更新链路、发布契约、部署脚本。
- 需求评审结论必须写清楚影响产品面、影响环境、回滚方式和责任团队，未完成前禁止进入执行。
- 开发阶段若修改更新、部署、发布相关代码，必须同步更新本目录规则或仓库级规则文档。
- 提测阶段必须同时提交功能验证、失败路径验证和回滚验证，不允许只验证 happy path。
- 版本更新阶段必须明确本次是 `npm-package`、`source-deploy` 还是 `device-package`，禁止混用“更新包”一词。
- 源码部署阶段必须区分 bootstrap、runtime reconcile、修复性重建和 Agent 升级，不允许继续以同一脚本承担全部长期职责。

## 提交与合并规则

- 任何涉及更新脚本、发布 workflow、manifest 契约的改动，提交说明必须明确“修复了什么风险”。
- PR 描述必须写明本次改动触达的产品边界、是否引入兼容性变化、是否需要运维动作。
- 若改动触发新的边界约束，必须同时回写 `ARCHITECTURE.md`、`DEVELOPMENT.md` 或 `docs/harness/*`。
- 未补齐规则文档、验证矩阵或排障信息的更新类 PR，不允许标记 ready。

## 禁止事项

- 不自动迁移 `HERMES_HOME_DIR`。
- 不把目录保护建立在单一固定目录名保留上。
- 不在 controller 中继续堆积 planner 和 executor 双重职责。
- 不把 Node 安装、用户创建、sudoers 写入、`systemd` 安装混进页面内更新 service。
- 不把 Hermes Agent 升级默认绑定进所有 Web UI 更新路径。
- 不让 workflow、manifest builder、installer、controller 各自维护一套发布契约字段语义。
- 不混入与边界收敛无关的重构。
- 不允许通过现场手工经验替代规则约束，例如依赖口头提醒去保留端口、区分固定版本 manifest 或决定是否升级 Agent。

## 代码规则

- controller 保持薄层，请求校验、响应映射留在 controller，目录判断和更新执行下沉到 `services/update/*`。
- Update Service 需要逐步拆成 planner 和 executor 两层，避免单个文件同时拥有版本发现、任务编排和执行控制职责。
- 路径判断必须使用标准化绝对路径，避免字符串包含判断。
- shell 调用保持参数数组形式，避免字符串拼接。
- 对 `.sh` 更新脚本的执行命令构造必须收敛到共享逻辑，避免各策略重复拼装和分叉行为。
- Windows 下调用 `.sh` 更新脚本时，必须先显式校验 `bash` 可执行文件是否存在；找不到时必须在 `spawn` 前失败，不允许把问题延后成运行时 `ENOENT`。
- 对这类执行环境或配置缺失问题，统一使用 `UpdateError` 和结构化错误码，不允许抛通用 `Error`。
- 对页面内更新相关环境变量，必须通过共享类型和 runner allowlist 统一声明，不允许脚本私自消费未登记字段。
- 新增错误码和类型定义必须放在共享模块，不允许散落在多个 controller。
- 日志要能区分：普通更新失败、兼容布局告警、危险布局阻止。
- 首装逻辑和日常更新逻辑需要逐步拆分，不允许长期共用同一个脚本入口并仅靠环境变量切模式。
- 页面内更新触发的 `source-deploy` / `device-package` 默认采用 `web-ui-only` 作用域；Hermes Agent 升级必须显式开关开启并有发布说明。
- 发布契约字段命名要在 build script、workflow、运行时配置之间保持一致，不允许一处写 `source deploy`、另一处写成另一套含义相近但不等价的词。
- 设备包发布协议中的 `channel` 必须使用安全路径 segment，只允许字母、数字、点、下划线和短横线；构建端、发布端、消费端必须复用同一套规则。
- 设备包 Node 兼容性必须使用范围语义，不允许再退回“major 完全相等”这种过窄判断。
- 设备包契约的最小结构、manifest 核心字段和兼容性语义必须优先收敛到共享模块，不允许在 build script、controller 和安装脚本中各自演化。
- 发布工作流的验收不能只验证 `manifest.json` / `latest.json`，还必须验证最终设备包资产真实可下载且摘要一致。

## 异常应急规则

- 固定版本引导必须使用目标版本 `manifest.json`，禁止使用持续前移的 `stable/latest.json` 代替。
- 任何手工安装或引导操作都必须显式继承设备当前 `PORT`、`BIND_HOST`、`DEPLOY_DIR` 和状态目录配置。
- 若页面内更新没有生成 runner request、状态文件或更新日志，必须立即按“入口分流异常”处理，而不是继续重试发布。
- 若设备更新后服务健康检查失败，必须优先执行回退和日志收集，不允许直接在现场继续覆盖部署目录。

## 监督与校验机制

- 架构监督：边界规则以 `ARCHITECTURE.md` + 本目录文档为准，二者不一致时禁止合并。
- 提交流程监督：更新相关 PR 必须通过 `npm run harness:check` 和对应 server 测试。
- 发布监督：发布 workflow 必须验证最终资产真实可下载且摘要一致，不能只验证元数据文件存在。
- 运维监督：现场引导、更新、回滚后必须保留任务状态文件、日志路径和执行命令记录。
- 复盘监督：每次更新事故都必须回写 `13-update-events-audit.md` 或 `change-log.md`，禁止只在聊天记录中留痕。

## 测试与验证规则

- 至少补以下测试：
  - 目录事实源解析
  - preflight 风险分级
  - `health` 版本比较逻辑不回归
  - `update` 在 `source-deploy` / `npm-package` 下的 preflight 接入
  - planner / executor 职责拆分后的回归路径
  - Windows 下 `.sh` 更新脚本执行命令解析
  - Windows 缺少 `bash` 时的结构化失败路径
  - 非法 `channel` 的显式失败路径
  - `compatibleNodeRange` 的兼容性判断与旧字段兼容归一
  - 发布工作流对真实设备包资产的发布后校验
- 若触碰 bootstrap、runtime reconcile 或 Hermes Agent upgrade 逻辑，必须额外补“职责未串线”的回归检查。
- 本轮最低验证命令：

```bash
npm run test -- tests/server/config.test.ts
npm run test -- tests/server/health-controller.test.ts
npm run test -- tests/server/update-controller.test.ts
```

- 若新增共享服务测试文件，应把对应测试命令补充到验证记录中。

## 交付规则

- 每次关键边界确认都要同步到：
  - `07-implementation-plan.md`
  - `open-questions.md`
  - `change-log.md`
- 当专项规则上升为仓库级规则时，必须同步回写 `ARCHITECTURE.md`。
- 代码实施完成后，需要把本轮实际结果回写到 `change-log.md`。
- 若实现中发现边界与现有代码冲突，必须先暂停并回到文档澄清。
