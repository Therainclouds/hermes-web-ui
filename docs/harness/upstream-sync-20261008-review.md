# 2026-10-08 上游选择性整合审查

## 基线和策略

本地产品基线：`a3a12b54`；母仓库：`EKKOLearnAI/ekko-studio`，检查到 `86f60d243c2f6e1b9e7b437f083559a20a36446e`。两侧各有大量独立提交，服务器已采用不同模块布局，完整 merge 会产生约 1007 个冲突。按本地保护规则选择移植修复和完整的可选 Ekko runtime，再适配现有服务边界；不合并上游的品牌迁移和发布历史。

本次不是声称把母仓库的每一个修复无条件复制进来：App/P2P、商业分享鉴权、iOS Live Activity、新增原生 Agent、重构后的运行时管理等变更依赖本地不存在或不同的架构，直接复制会破坏既有产品。其相关修复随相应功能一起排除。已有等价修复不重复移植。

## 移植内容与来源

| 范围 | 主要上游提交 | 本地适配 |
| --- | --- | --- |
| 长聊天搜索、未发送草稿、分页统计 | `7139830c`, `2aca7bd3`, `a261b861`, `a20feca1` | 保留本地会话来源、工作区变更与活动请求隔离；分页筛选和总数采用相同条件。 |
| 会话菜单、下载、文件行号预览 | `33088f3e`, `c1505041`, `c63d9a54` | 保留本地实时语音按钮；接口保持 `/api/hermes`；源码预览使用虚拟列表。 |
| 模型 Profile、TTS 恢复与豆包语速 | `7c64fd24`, `ed1354b1`, `601f38a2`, `b34279fb` | 模型页选择不改变全局 Profile；STT/TTS 的读取、保存和删除遵循页面 Profile；保留本地额外语音 Provider。 |
| Hermes 启动、凭证与 MCP 隔离 | `4a80c1b1`, `ba4c781d`, `c418fd94`, `cc87ff50`, `7660f92f`, `4a81f50c` | 保留本地 Python/Hermes 选择、MCP 发现和小智环境配置；worker bootstrap 在接收请求前完成。 |
| Coding Agent 恢复与模型协议 | `85ff3477`, `b036cf24`, `6f3a53c3`, `ff820ddc`, `97203089`, `8564948c`, `d8c7b5e0`, `521c36a3`, `e6e339fe`, `82aeac2f`, `7ecfdcf1` | 只适配已有 Agent；保留本地 launch、权限、日志和会话结构；不带入缺少依赖的新 Agent 分支。 |
| DSH、跨 Profile 会话、标题、环境变量 | `c4c0f901`, `c38a417e`, `cb716634`, `1ecc1115`, `dbdf12b9`, `703bd4f9` | 保留本地 DSH SDK 版本与 Web 插件加载方式；明确同账号可读范围。 |
| 群聊隔离和分享图片 | `0d7c6c3e`, `27544731` | 独立 Socket.IO manager，重连重新加入；只授权当前房间已发布的本地 Agent 图片，排除远程 Agent 路径、HTML、代码和普通链接。 |
| Linux 自启动、启动错误、主题保存 | `2e3bf605`, `942bb78f`, `ebd9ee58` | 自启动标识保持 Quanthermes；限制启动日志大小并保留原错误。 |
| 可选 Ekko runtime | 上游 `packages/ekko-agent` 与对应测试 | 更新工具限额、并行工具、直接记忆捕获、恢复、MCP/模型兼容；保留本地品牌归属、技能导入与媒体接口；JEV 默认关闭。 |

已有本地等价功能包括技能启用开关、代码样式文件预览、Markdown 预览、会话分类折叠、引用箭头、语音跳过 thinking 和语义符号保留。这些继续使用本地实现。

## 保留与排除

保留 npm 包名 `@quanthermes/hermes-web-ui`、版本 `0.8.9`、桌面 `com.quanthermes.hermeswebui` / Quanthermes Studio、本地账号默认、专家中心、专家市场、USB、会议/扫描、实时语音、独立 OSS 更新体系。

不修改 `.github/`、设备安装/更新/发布脚本、受保护更新服务、USB 协议或上游合并规则。OpenRouter 归属采用 `Quanthermes Web UI` 与本仓库 URL；上游运行时及第三方作者的来源归属仍保留。排除购买入口、合作 API 推广、公告广告、Ekko CLI/feed 替换和默认 Agent 切换。

保留 Ekko 名称作为明确可选运行时标识。额外 JEV 技能/记忆评估虽可显式配置，但默认不调用模型；不引入上游新的群聊/工作流 JEV 设置、空闲轮询或商业 App 服务。上游重置旧技能目录的迁移已移除：存在的用户技能不会被清空，初次安装可复制 Hermes 技能，Hermes 源目录不修改。

## 小智接入约定

主链路仍是本仓库的 `/api/xiaozhi/ota/:code` 与 Socket.IO `/global-agent`。`agentRuntime` 缺省、空白或无效均选择 `hermes`；只有显式 `ekko`（允许大小写和前后空格）才选择 Ekko。运行时使用不同会话标识与 Agent 来源字段，避免串会话。原 OTA 摄像头上传、采集、分析保持现有接口。ESP32-C3 v1/v2 的初始化和缺省 NVS 读取同步改为 Hermes，已存储的显式选择不覆盖。发布二进制保持原样，已刷入的旧固件需在设备配置页选择 Hermes；本次不宣称二进制已经更新。

本机另一个 persona 固件服务采用 `/ws/device`、Opus 帧和播放 ACK，它不等价于本链路。本次不替换该服务、不刷固件、不执行硬件动作。软件契约测试通过不等于真实设备录音、播放、网络重连和摄像头已经验收。

邀请页还修复了两个本地问题：匿名页面不启动 USB/私有配置读取；交付用量状态先初始化，再注册立即执行的 watcher，且访客不读取私有讨论/交付接口。

可选 Ekko 的持久数据库恢复后，现有宿主需要在活动运行结束后重启才能重新连接持久库；本次没有搬入上游的新宿主自动重载管理器。

## 性能

相同 Node 26.7.0 下的构建产物比较（全部 JS/CSS 分别 gzip 后求和，包含按需模块）：前端从 8,400,140 到 8,407,916 字节，增加 7,776 字节（约 0.09%）；后端 bundle 从 10,559,413 到 11,381,749 字节，增加 822,336 字节（约 7.79%，主要为更新后的可选 runtime）。这不是首屏下载量或实机吞吐基准。

长源码预览虚拟化、会话分页、取消草稿历史加载有助于减少大数据开销。JEV 默认为关闭。性能测量不承诺所有模型/硬件场景；还需要真实设备端到端延迟验收。

## 验证

- 原 `main` 全量 Vitest：655 文件通过、30 文件失败；5965 测试通过、71 失败、13 跳过。
- 整合后的全量 Vitest：692 文件通过、28 文件失败；6514 测试通过、66 失败、13 跳过。失败文件全部属于基线已有失败文件；Coding Agent launch 和会话 controller 的基线失败已解决。
- Coverage 全量检查已执行，但未通过：基线失败仍在，另外 scanner 的 CPU 密集测试在 coverage 插桩下超时；不能宣称全量测试或覆盖率门禁全绿。
- `npm run build` 通过，包括 Vue/服务器类型检查与构建；保留已有大 chunk 提示。
- `npm run harness:check` 通过。
- Web 构建和使用桌面锁定 TypeScript 5.6.3 的 `npm --prefix packages/desktop run build:main` 均通过。
- Ekko runtime 与宿主：32 文件、512 测试全部通过。
- 关键浏览器链路覆盖长会话搜索、模型/语音 Profile、菜单、下载、各类文件预览、小智摄像头与匿名群聊图片。
- 完整浏览器套件已执行：124 通过、16 失败、28 未执行（serial 文件内前置失败会跳过后续测试）。发现了遗留 `/api/studio` mocks、登录页设备二维码 mock、URL 查询参数与服务端 Profile 模拟不一致，已修正并复测，16 项契约回归全部通过。另有评分插件、群聊中断审批、会议音频、扫描与 Petdex 背景的未解决测试/界面问题；相关功能源码未在本次替换，尚未逐项进行原版浏览器对照，故不能宣称浏览器套件全绿。
- 小智固件默认值、运行时选择与 GlobalAgent：41 测试通过。本机无 PlatformIO，固件 C++ 编译未执行；此次 Web 构建复制的仍是既有发布二进制。
- 真实设备 Opus、播放 ACK、录音和摄像头端到端兼容未执行。

剩余全量失败集中在原有更新/设备登录测试环境、知识库 mocks、品牌预期、i18n/RTL 与已有群聊断言，详细失败列表见下节。保护范围未为通过测试而替换上游实现。

## 仍失败的基线测试文件

- `tests/client/chat-panel-session-click.test.ts`
- `tests/client/device-connections-locales.test.ts`
- `tests/client/ekko-display-name.test.ts`
- `tests/client/i18n-coverage.test.ts`
- `tests/client/meeting-right-panel.test.ts`
- `tests/client/meeting-scene-picker.test.ts`
- `tests/client/profile-card-config-edit.test.ts`
- `tests/client/router-login-redirect.test.ts`
- `tests/client/rtl-logical-css.test.ts`
- `tests/server/agent-bridge-profile-env.test.ts`
- `tests/server/app-connections-auth.test.ts`
- `tests/server/device-login-controller.test.ts`
- `tests/server/group-chat-agent-handoff-guard.test.ts`
- `tests/server/group-chat-agent-workspace.test.ts`
- `tests/server/group-chat-approval.test.ts`
- `tests/server/health-controller.test.ts`
- `tests/server/hermes-web-ui-mcp.test.ts`
- `tests/server/knowledge-controller.test.ts`
- `tests/server/knowledge-watcher.test.ts`
- `tests/server/lan-discovery.test.ts`
- `tests/server/npm-local-stt-runtime.test.ts`
- `tests/server/schema-sync.test.ts`
- `tests/server/studio-mcp-autoinject.test.ts`
- `tests/server/tts-synthesize-controller.test.ts`
- `tests/server/unbind-wechat.test.ts`
- `tests/server/update-controller.test.ts`
- `tests/server/update-orchestrator/orchestrator-dry-run.test.ts`
- `tests/server/update-orchestrator/recover-interrupted.test.ts`
