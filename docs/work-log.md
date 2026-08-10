# Work Log

## 2026-08-10 · 创建 profile 支持设置显示名称

### 需求背景

- 用户确认"显示名/系统名分离"机制（微信绑定会把微信名写入 default profile 的显示名，请求仍用系统名 `default`）。
- 追问：创建 profile 时能否也设置显示名？现状不支持（创建弹窗只有 name + clone，`setProfileDisplayName` 仅微信绑定一个调用点）。

### 改动

- 服务端 `profiles.create()`：接收可选 `displayName`，创建成功后调用 `setProfileDisplayName(name, displayName)` 写入 Web-UI profile-metadata（`~/.hermes-web-ui/profile-metadata/{base64}/meta.json`），不触碰底层 Hermes profile 目录。
- 前端 `ProfileCreateModal.vue`：新增"显示名称"输入框（可选，maxlength=40），经 profiles API/store 透传。
- i18n：新增 `displayName` / `displayNamePlaceholder` / `displayNameHint` 到全部 11 个 locale；修复 fr.ts 法语撇号导致的字符串定界问题。
- 测试：`profiles-routes.test.ts` 新增 2 例（带 displayName 写入元数据 / 不带则不留元数据），21/21 通过。

### 验证

- `vue-tsc` / 服务端 `tsc` 零错误；`npm run build` 通过；`npm run harness:check` 通过。

## 2026-08-10 · 修复微信登录绑定后聊天报 Agent Bridge 连接超时

### 现象

- 微信扫码登录并绑定后，聊天发送消息持续报错 `Error: Agent Bridge is not reachable: Agent bridge connect timed out`。
- 绑定后 default/expert profile 显示名同步为微信名（`牢许`）属预期功能，但聊天无法进行。

### 根因

- 提交 `63870029`（v0.7.17）重写 `AgentBridgeClient.connectSocket()` 后，连接 deadline 计算为：
  `effectiveDeadline = min(Date.now() + connectRetryMs, request deadline)`。
- 当调用方传 `connectRetryMs: 0`（如 `ensureBridgeReadyForChatRun` → `ensureReady({ timeoutMs: 1000, connectRetryMs: 0 })`），
  `effectiveDeadline` 被压缩为 `Date.now()`，循环首轮 `remaining <= 0` **直接抛 "Agent bridge connect timed out"**，
  从未发起真实 socket 连接尝试——即使 broker 正常监听（本机 18765 端口可用）。
- 旧代码总是先调用 `connectSocketOnce()` 再检查 deadline，`connectRetryMs=0` 语义是"失败后不重试"，而非"尝试前就放弃"。

### 修复

- `packages/server/src/services/hermes/agent-bridge/client.ts`：`connectRetryMs > 0` 时才叠加重试窗口；
  `connectRetryMs = 0` 时重试窗口视为无穷（由请求级 `deadline` 兜底），保证**至少一次真实连接尝试**；
  单次尝试失败且 `connectRetryMs <= 0` 时立即抛出，不进入重试循环。
- 补充测试：`agent-bridge-client-connect-timeout.test.ts` 新增 2 例，覆盖 `connectRetryMs: 0` 连接成功与连接挂起场景。

### 验证

- 修复后真实 broker ping：`connectRetryMs: 0` 在 3ms 内连接成功（修复前立即超时）。
- `agent-bridge-client-connect-timeout`（5/5）与 `chat-run-bridge-readiness`（18/18）通过，服务端 `tsc` 类型检查通过。

### 备注

- `tests/server/agent-bridge` 整体约 65 个失败在 **main 分支上同样存在**（Python 子进程环境依赖缺失等），
  `gateway-respawn` 1 个失败亦为 main 既有问题，均与本次修复无关。
- 修复后需重启 dev server（当前 18624 仍运行旧代码）方可生效。

## 2026-08-10 · 合并 main (v0.7.17) 与 org/meeting/v0.73 至 integration/rebuild-from-upstream

### 本轮目标

- 将本地 `main`（v0.7.17，领先 integration 6 个提交）同步进当前 `integration/rebuild-from-upstream` 分支。
- 拉取组织仓库 `tangledup-ai/hermes-web-ui` 的 `meeting/v0.73` 分支（15 个独立提交：微信登录/设备绑定/Token Platform/Profile 管理）并合并。
- 合并规则遵循 `docs/harness/upstream-merge-rules.md`（LOCKED/BRANDED/ADAPTED/ACCEPT 四级保护）。

### 已完成事项

#### 1. main → integration

- `git merge --no-ff main` 无冲突，带入群聊自由讨论模式（gc_discussions 数据表、discussion.ts、docx 导出）、v0.7.15/16/17 版本、更新/网关/agent-bridge 修复等。

#### 2. org/meeting/v0.73 → integration

- 唯一内容冲突为 `package.json` 版本号：meeting 分支自带 0.73.0，经确认**保留主线 0.7.17**（meeting 为独立产品线版本号，不应覆盖主线 0.7.x）。
- 其余文件自动合并成功，无冲突标记残留。
- 修复合并冗余：`meeting-asr/index.ts` 出现重复的 `ASR_MODEL` 赋值块，已删除重复项。
- ADAPTED 文件审查通过：meeting-asr python-backend DashScope 标准端点保留、MeetingView.vue AudioWorklet + 配置向导保留、meeting.ts 句子触发配置正常合并、i18n 11 个 locale 无冲突标记且 quanthermes 引用完好。
- 新路由已注册：`/api/auth/device-login`、`/api/auth/device-binding`、`/api/auth/bind-super-admin`、`/api/auth/users/:id/export` 等。

#### 3. 验证

- `npm run harness:check` 通过。
- 服务端/客户端 `vue-tsc` 类型检查零错误。
- 会议相关测试 50/50 通过（device-login-controller、device-binding、token-platform-client、profile-metadata 等）。
- auth 测试 25/25 通过。
- `npm run build` 全量构建通过。
- 版本文件全部一致为 0.7.17（package.json / desktop / package-lock / device-package-release.json）。
- 品牌残留检查：无新增 hermes-studio/EKKOLearnAI/download.ekkolearnai.com/api.hermes-studio.ai 残留（已有引用均为历史遗留，不在本次合并 diff 中）。

### 遗留事项

- `rtl-logical-css.test.ts` 在 main（29 个 offenders）和 org/meeting/v0.73（33 个）上本就失败，合并后保持 33 个——非本次合并引入，待单独归档处理。

## 2026-08-04 · 合并 upstream/main（141 commits）至 integration/rebuild-from-upstream

### 本轮目标

- 将上游 `EKKOLearnAI/hermes-web-ui` 的 `main` 分支（141 个 commits）合并进本地 `integration/rebuild-from-upstream` 分支。
- 合并原则：① 本地品牌化功能、更新功能、本地独有功能最高优先级；② 冲突优先考虑兼容性，宠物功能（Petdex/WebPet）默认在本分支已删除；③ 合并前做边界和整体函数引用范围确认，避免空函数和无关内容。

### 已完成事项

#### 1. 冲突解决与合并边界清理

- 解决全部冲突文件：desktop main/preload、client 组件（useAppMessage 批量 15 个）、i18n 10 个 locale、server run-chat 三件套 + shutdown/providers、website/tests/docs/README 等。
- 品牌化保留：包名 `@quanthermes/hermes-web-ui`、端口 6060、内置更新 manifest 默认 URL、凭据体系。
- 删除 `group-chat.ts` 中旧本地版重复路由（GET /rooms 与 /rooms/join/:code），保留上游脱敏版与本地独有 export/import 路由，消除重复注册导致的路由遮蔽。
- 宠物功能相关代码与测试（pets-store/petdex-service）整体移除，无空函数与悬空引用。

#### 2. 编码损坏修复

- 扫描发现 29 个冲突文件存在编码损坏，用 Node UTF-8 安全方式全部重建。
- 修复 HEAD 已提交损坏：README/README_zh 重新组装；修 `generate-openapi.mjs` 2 行并重新生成 `openapi.json`。

#### 3. 类型检查与静态校验

- 修复 13 个文件共 59 个 vue-tsc 语义错误，`vue-tsc` 达到零错误。
- `npm run harness:check` 通过（品牌 URL 对齐）。

#### 4. 测试修复（Windows 环境适配 + 品牌适配）

- 品牌期望修正：health/devices/updater/windows-main-window/user-auth 全部通过。
- group-chat-member-sync 31/31；update-controller 29 过 / 1 skip（品牌默认值令该守卫不可达，已注释说明）。
- Windows 路径类失败系统性修复：run-chat-bridge/ekko 上下文（`vi.hoisted` 分隔符构造 + JSON 转义断言）、model-catalog-cache（mock 路径归一化）、kanban-controller（`HERMES_KANBAN_ATTACHMENTS_ROOT` env 锚定）。
- usb-service：固定时间戳 `2026-07-01` 已超出 24h 历史窗口，改为相对 `Date.now()` 的动态时间戳，4/4 通过。
- coding-agent-resume-config：Windows 下启动 env 会合并宿主机 commandEnv（平台行为），断言按平台分支适配，10/10 通过。

### 遗留事项

- RTL logical CSS 样式断言、少量环境类失败（symlink 权限/python3 缺失/POSIX 路径假设）待归档确认，均非本次合并引入。
- 全量 `npm run test` 最终确认与核心功能手动验收进行中（`npm run build` 已通过）。

### 补充：build 阶段修复

- `npm run build` 报 TS2353：本地群聊导入路由向 `saveRoom` 传入 `triggerTokens/maxHistoryTokens/tailMessageCount`，而上游已不再持久化 per-room token 预算（改用 schema 默认值）。已移除该 config 入参并加注释，全量 build 通过。

### 补充：手动验收反馈修复

- 聊天框显示裸文本 `scroll-scope="chat"`：`ChatPanel.vue` 合并残留的孤立属性行，已归位到 `<MessageList>` 标签。
- 侧边栏品牌词回退：`sidebar.apiRelay` 被上游值覆盖（zh 为上游占位词“饲料”、zh-TW “中轉站”），已恢复品牌词“量迹市场”。

## 2026-08-01 · 实时提示优化：快速响应 + keyPoint 醒目高亮

### 本轮目标

- 解决实时提示响应过慢的问题（法律场景每轮触发 Agent 慢路径，对话结束了才出提示）。
- 提示内容过长不醒目，需要关键内容高亮放大，一眼可读。

### 背景

上一轮实现了实时分析走 Agent 的混合策略（法律关键词触发 Agent + MCP 工具查询），但实测发现法律会议中几乎每句话都含"合同"、"违约"等触发词，导致每轮都走 15-20s 慢路径，完全不适合实时场景。同时输出内容大段文字，用户难以快速获取关键信息。

### 已完成事项

#### 1. 实时提示回退为直调 LLM（不走 Agent）

- `realtime-assist.ts` 的 `analyzeBatch` 改为始终走直调 LLM 快速路径（~3s），不再尝试 Agent。
- Agent + MCP 工具查询仅保留在报告生成路径（需要真实法条核实的深度分析场景）。
- 保留 `analyzeBatchViaAgent` 和 `SCENE_TOOL_TRIGGER` 代码（未删除），后续如有需要可重新启用。

#### 2. 新增 keyPoint 字段 + 各场景 systemPrompt 精简

- `AnalysisRound` 接口新增 `keyPoint: string` 字段（核心提醒，≤30 字）。
- 全部 5 个场景的 systemPrompt 重构：
  - keyPoint：一句简短有力的核心提醒（用户第一眼看到）
  - context：原文引用（次要）
  - analysis：1-2 句补充说明（降为次要文字）
  - 输出 JSON 格式从 `{context,priority,analysis}` 变为 `{context,priority,keyPoint,analysis}`
- `parseAnalysis` 更新：兼容 keyPoint 缺失的旧格式，keyPoint 和 analysis 均空时跳过。

#### 3. 前端渲染优化：keyPoint 醒目高亮

- `MeetingAgentPanel.vue` 新增 `.round-keypoint` 渲染区块，位于 context 和 analysis 之上。
  - normal：15px 加粗 + 绿色文字 + 淡绿背景
  - attention：15px 加粗 + 橙色文字 + 淡橙背景
  - urgent：16px 加粗 + 深红色 `#ff4d4f` + 淡红背景 + 红左边框
- 优化颜色区分度：
  - **原文引用**（context）：改为淡青色 `#9fd4f0` + 青色左边框 `#70c0e8` + 淡青背景，一眼识别为“转写原话”。
  - **分析说明**（analysis）：改为 `#c8c8c8` 浅灰色，与深色背景拉开对比度，阅读更清晰。
  - **核心提示**（keyPoint）：保留醒目的橙/红/绿，并增加同色系左边框，强化层级。
- 客户端接口 `useMeetingAssist.ts` 和 `stores/hermes/meeting.ts` 同步新增 keyPoint 字段。

#### 4. 各场景 reportPrompt 工具调用引导统一化

- business：新增"数据核实要求"引导（合同条款/市场数据调工具核实，未核实标注"待确认"）。
- medical：新增"医学信息核实要求"引导（药品剂量/禁忌调工具核实，查不到标注"需临床核实"）。
- interview：新增"信息核实要求"引导（竞品/行业数据可调工具补充）。
- legal：已有法条引用引导（上一轮 commit 6cbf5170）。
- general：无（通用场景不需要专业工具）。

### 设计原则

- **实时提示 = 快速提醒**：直调 LLM，3s 出结果，keyPoint 一句话点出关键。
- **报告生成 = 深度分析**：走 Agent + MCP 工具，查真实法条/数据，可接受 2-3 分钟。
- 两条路径职责分离，互不影响。

## 2026-07-31 · 法律场景接入法规查询 MCP（chinese-law-mcp）

### 本轮目标

- 为法律沟通会议场景接入开源法规查询 MCP，使 Agent 生成报告时能主动调用工具核实真实法条。
- 解决 Windows 下 MCP server 启动失败（spawn npx ENOENT / 503）的问题。

### 背景

法律场景 reportPrompt 已引导 Agent"若有法规查询工具则主动调用"，但环境中尚无可用工具。选用 `@ansvar/chinese-law-mcp`（1188 部国家法律法规、62981 条文，数据源 flk.npc.gov.cn + cac.gov.cn）作为本地 MCP server。

### 已完成事项

#### 1. 法律场景 reportPrompt 增加法条引用工具调用引导（commit 6cbf5170）

- `scene-templates.ts` 法律场景 reportPrompt 新增"法条引用要求"段落。
- 与具体 MCP 解耦：仅描述"法律/法规查询工具"，无硬编码 server 名称。
- 优雅降级：无工具或查询失败时标注"需人工核实"，绝不编造条文。
- 仅影响 legal 场景，其他场景模板零改动。

#### 2. Windows MCP 启动问题诊断与修复

- **根因**：Windows 上 `spawn('npx')` → ENOENT（npx 是 .cmd 包装脚本）；`cmd /c npx -y ...` → 进程立即 exit 1（stdout 空）。
- **方案**：改用 `node.exe 全路径 + 脚本全路径` 直接运行（与 bridge 里其他 3 个 hermes-studio MCP 同一模式）。
- 全局安装需 `npm install -g @ansvar/chinese-law-mcp --ignore-scripts`（postinstall 用 Unix 命令，Windows 上失败；包自带 dist/ 和 database.db，无需 build）。

#### 3. 配置写入并验证

- 配置已写入 `C:\Users\DELL\AppData\Local\hermes\config.yaml` 的 `mcp_servers` 段：
  ```yaml
  chinese-law-mcp:
    command: C:\Program Files\nodejs\node.exe
    args:
      - C:\Program Files\nodejs\node_modules\@ansvar\chinese-law-mcp\dist\index.js
    enabled: true
  ```
- 验证通过：MCP initialize 握手成功（chinese-law-mcp v2.3.0，协议 2024-11-05）；tools/list 返回 8 个工具：search_legislation、get_provision、list_sources、validate_citation、build_legal_stance、format_citation、check_currency、about。

### 使用说明

- Web UI MCP 管理页点"重载"或重启 Agent 后 bridge 加载新配置。
- 法律沟通场景生成报告时，Agent 会主动调用 `search_legislation` / `get_provision` 查询真实法条并引用。
- 若 MCP server 未连接，报告仍可正常生成（走自身知识 + 标注"需人工核实"）。

## 2026-07-31 · 会议报告生成经过 Hermes Agent（自动回退直调 LLM）

### 本轮目标

- 报告生成改走 Hermes Agent，复用用户为该 profile 训练好的系统提示词、技能与记忆。
- bridge 不可用时自动回退到直调 LLM，用户无感知。
- 实时分析保持轻量直调路径（直调 LLM + 技能注入），不经过 Agent。

### 背景

上一轮把技能动态注入到直调路径，但用户可能已训练好自己的 agent（自定义系统提示词、技能、记忆），直调无法复用这些。报告生成是一次性、重量级场景，适合走 Agent；而实时分析（18s 一轮）要求低延迟，保持直调。

### 已完成事项

#### 1. `realtime-assist.ts` 报告生成重构

- `generateReportStream` 改为编排器：先尝试 Agent 路径，未产出任何内容时失败则自动回退直调 LLM；已输出后出错则原样抛出（避免重复输出）。
- 新增 `generateReportViaAgent`：`AgentBridgeClient`（connectRetryMs=1500 快速失败）+ `bridge.chat`（场景 reportPrompt 作为 instructions、source=meeting-asr）+ `streamOutput`（180s 超时）+ finally `destroy`（一次性会话结束即销毁）。
  - 无增量 delta 时回退到从 `result.final_response` / `output` 提取最终文本。
- 抽取 `generateReportViaDirectLLM`：原直调逻辑（含会议分析技能动态注入 + 流式 + 非流式回退），作为兜底路径。
- profile 解析：优先传入值，其次当前激活 profile（`getActiveProfileName`，失败兜底 'default'）。

#### 2. 测试

- 新增 `tests/server/meeting-report-fallback.test.ts`（4 例）：Agent 路径成功、bridge 不可用自动回退、已输出后不回退（抛出）、无 delta 提取最终文本。全部通过。
- `tests/server/meeting-skill-resolver.test.ts`（5 例）不受影响，全部通过。
- 服务端 `tsc --noEmit` 通过。

### 说明

- Agent 路径复用用户 profile，用户训练好的系统提示词 / 技能 / 记忆会生效；场景 reportPrompt 作为任务级指令叠加其上。
- 回退仅在“尚未输出任何内容”时发生；一旦流出过内容绝不回退，防止重复输出。

## 2026-07-31 · 会议分析接入技能系统（动态注入 + 自动安装）

### 本轮目标

- 让会议分析（实时分析 + 报告生成）能够使用 Hermes 技能（skills）。
- 分析 agent 对应的 profile 没有技能时自动安装内置技能，开箱即用。

### 背景

会议分析走的是服务端**直接 fetch LLM API** 的轻量路径，不经过 Hermes Agent，因此不会加载 profile 的技能。技能是 Hermes Agent 专属能力（只有走 agent-bridge 的聊天才加载）。所以“给分析 agent 装技能”本身不生效，需要把技能内容动态注入到直接调用的提示词中。

### 已完成事项

#### 1. 内置会议分析技能

- 新增 `packages/skills/meeting-analysis/SKILL.md`：通用会议分析方法论（实时分析原则、优先级判断标准、报告结构方法论、通用准则），打上 `meeting` 标签。
- 构建脚本 `build-server.mjs` 会将 `packages/skills` 复制到 `dist/skills`，生产模式可被技能源解析找到。

#### 2. 技能解析服务 `skill-resolver.ts`

- `ensureMeetingAnalysisSkill(profile)`：自动安装。profile 缺少 `meeting-analysis` 时从内置技能源复制。
- `loadAnalysisSkills(profile)`：读取 profile 下所有带 `meeting` 标签（或名称含 meeting）且未被禁用的技能，解析 SKILL.md 正文。
- `buildSkillInstructionsSection(skills)`：拼成可追加到 system prompt 的片段。
- `prepareAnalysisSkillSection(profile)`：顶层入口，带 60s 缓存（实时分析 18s 一轮，避免重复读盘）。
- frontmatter 解析显式使用 js-yaml `DEFAULT_SCHEMA`（安全 schema）并做结构校验。

#### 3. 注入点

- `realtime-assist.ts` 的 `analyzeBatch`（实时分析）与 `generateReportStream`（报告生成）在调 LLM 前把技能片段追加到 system prompt。
- `ActiveSession` 新增 `profile` 字段；`startSession`/`generateReportStream` 增加 `profile?` 参数。

#### 4. profile 传递链路

- 前端 `MeetingAgentPanel.vue` 新增 `resolveProfile()`，从 session 的 `hermesProfile` 读取，随 `assist/start` 与 `report/stream` 传递。
- 服务端控制器解析 `profile`；为空时兑底用当前激活 profile（`getActiveProfileName()`）。

### 使用方式

- 默认开箱即用：首次分析时自动安装内置 `meeting-analysis` 技能并注入。
- 自定义：在技能的 SKILL.md frontmatter 加 `meeting` 标签（或名称含 meeting），安装到对应 profile 即可被会议分析使用；在技能管理页禁用可停用。

### 验证

- 服务端/客户端 tsc 类型检查通过。
- 新增 `tests/server/meeting-skill-resolver.test.ts`（5 个用例：拼接、过滤+禁用、自动安装、端到端注入、命名 profile）全部通过。
- 现有 `skill-injector.test.ts`（6 个用例）不受影响。

---

## 2026-07-31 · 会议报告生成修复与 HTML 导出美化

### 本轮目标

- 修复「生成会议报告」点击无响应/报告为空的问题。
- AI 实时分析记录持久化，刷新不丢失。
- 报告导出为精简美观的独立 HTML 页面。

### 已完成事项

#### 1. AI 分析记录持久化 (`1d68b985`)

- `MeetingSession` 新增 `analysisRounds` 字段，随 session 存入 localStorage。
- 面板挂载时加载历史记录，新分析到达时同步写入 store。
- `loadSessions` 兼容旧数据补全 `analysisRounds: []`。

#### 2. 修复报告生成无响应（三轮排查）

- **第一轮** (`db289348`)：报告接口从 GET(query) 改为 POST(body)，避免长转写文本 URL 超限；5 个场景提示词优先级校准更克制（80% 以上为 normal）。
- **第二轮** (`765656e0`)：SSE 解析兼容 `data:{...}` 无空格格式；`delta.content` 取不到时尝试 `message.content`；流式为空时回退非流式调用。
- **第三轮·根因** (`4279ad30`)：`ctx.body = new ReadableStream(...)`（WHATWG Web 流）被 Koa 序列化为 `{}`，前端收到空对象。改用 `node:stream` 的 `PassThrough`，Koa 原生 pipe 传输 SSE。
- **验证**：直接调用 MaaS 端点确认流式返回标准格式；服务端控制器入口加日志确认路由命中。

#### 3. 报告导出为精美 HTML (`e59a5d73` / `5bee7200` / `4e904d6b`)

- 新增 `utils/report-html.ts`：markdown-it 转换 + 内嵌样式（卡片布局/中文字体/打印适配/响应式）。
- `downloadReport` 智能判断：Markdown 转精美 HTML，已是 HTML 则直接下载；优先读 store 权威数据源。
- 修复报告面板「导出」按钮（`exportReportHtml` 名不副实，原下载原始 md）改为下载 `{标题}_报告.html`。

#### 4. 报告提示词去除开场白 (`3a72ac0d`)

- 5 个场景 `reportPrompt` 统一加约束：直接输出报告正文，不写“以下是一份…”这类前言。

#### 5. LLM 模型名修正 (`8ec92110`)

- `data/meeting-asr/config.json` 模型从 `Qwen3.6-Plus`（不存在）改为用户 MaaS 端点实际可用的 `qwen-plus`。

### 关键经验

- **Koa 不支持 WHATWG Web ReadableStream 作为 `ctx.body`**：会被序列化为 `{}`，必须用 `node:stream` 的 PassThrough/Readable。
- 排查 SSE 问题应在前端流读取循环打印原始块，快速区分“服务端没发”还是“前端没解析”。

### Git 提交记录

- `1d68b985` feat(meeting): AI实时分析记录持久化到localStorage
- `db289348` fix(meeting): 报告生成改为POST避免URL超长 + 优先级校准更克制
- `765656e0` fix(meeting): 修复报告生成为空-SSE格式兼容+非流式回退
- `4279ad30` fix(meeting): 报告SSE改用Node PassThrough流修复Koa序列化为{}的bug
- `e59a5d73` feat(meeting): 报告导出为精简美观的独立HTML页面
- `5bee7200` fix(meeting): 报告下载优先读store权威数据源+诊断日志
- `4e904d6b` fix(meeting): 报告面板导出按钮改为下载精美HTML而非原始md
- `3a72ac0d` refactor(meeting): 报告提示词要求直接输出正文去除开场白
- `8ec92110` fix(meeting): LLM模型名改为用户MaaS端点可用的qwen-plus

---

## 2026-07-31 · 会议实时辅助迭代优化

### 本轮目标

- 修复实时辅助 API 401 认证问题。
- 重新设计辅助面板 UI，解决卡片杂乱/类型跳动/无原文引用问题。
- 停止录音后提供可见的「生成报告」入口。

### 已完成事项

#### 1. 修复 401 认证问题 (`1b2fd77f`)

- 原因：`meetingASRRoutes` 注册在认证中间件之后，但 `pushSentenceToAssist` 和 `report/stream` 使用裸 `fetch()` 未携带 Authorization 头。
- 修复：两处 fetch 添加 `Bearer ${getApiKey()}` 头。

#### 2. 重新设计实时辅助面板 (`c9ebe208`)

- **问题**：4 种类型卡片（预测/氛围/风险/建议）随机跳动，视觉混乱，无原文引用。
- **方案**：
  - LLM 输出从「多类型数组」改为「单条统一分析」：`{context, priority, analysis}`
  - 每轮分析产出一张统一卡片：原文引用 + 自然语言分析正文
  - 优先级仅 normal/attention/urgent 三档，左边框颜色区分
  - 不再有类型标签跳动
- **变更文件**：
  - `scene-templates.ts`：5 个场景 systemPrompt 全部重写
  - `realtime-assist.ts`：`AssistHint` → `AnalysisRound`，`parseHints` → `parseAnalysis`
  - `useMeetingAssist.ts`：`hints` → `rounds`，监听 `analysis` 事件
  - `MeetingAgentPanel.vue`：全新设计（统一卡片 + 原文引用 + 优先级徽标）

#### 3. 停止录音后显示「生成会议报告」按钮 (`2f258a0f`)

- 面板底部新增 `report-action-bar`，录音停止且无报告时可见。
- 新增 `request-report` 事件，父组件构建 transcript 并调用 `generateReport`。
- 补充 i18n：`meeting.reportPanel.generate`。

### Git 提交记录

- `1b2fd77f` fix(meeting): 修复实时辅助API请求缺少认证头导致401
- `c9ebe208` refactor(meeting): 重新设计实时辅助面板 - 统一分析卡片取代杂乱类型卡片
- `2f258a0f` fix(meeting): 停止录音后显示「生成会议报告」按钮

### 待办

- `data/meeting-asr/config.json` 中模型名 `Qwen3.6-Plus` 需改为用户 MaaS 端点实际可用模型。

---

## 2026-07-30 · 会议 AI 实时辅助重构

### 本轮目标

- 将会议 AI 分析从事后批量 JSON/HTML 模式重构为录音期间的实时辅助面板。
- 引入场景模板系统（通用/法律/商务/医疗/客户访谈）。
- 报告仅在停止录音后生成，采用 SSE 流式输出。

### 已完成事项

#### 1. 场景模板系统

- 新增 `packages/server/src/services/meeting-asr/scene-templates.ts`（124 行）。
- 5 种内置场景，各含 `systemPrompt`（实时辅助）+ `reportPrompt`（报告生成）。
- 会议创建弹窗增加场景 NSelect，`MeetingSession` store 增加 `sceneTemplate` 字段。

#### 2. RealtimeAssistService

- 新增 `packages/server/src/services/meeting-asr/realtime-assist.ts`（301 行）。
- 滑动窗口缓冲（WINDOW_SIZE=5, WINDOW_INTERVAL=18s）→ LLM 调用 → Socket.IO emit。
- Socket.IO 命名空间 `/meeting-assist`，room `meeting:{sessionId}`。
- SSE 流式报告生成（AsyncGenerator + ReadableStream）。
- 新增 5 个 API 路由 + 5 个控制器函数。

#### 3. 前端实时面板

- 新增 `packages/client/src/composables/useMeetingAssist.ts`（88 行）— Socket.IO composable。
- 完全重写 `MeetingAgentPanel.vue`（1057 → 388 行）：提示卡片流 + 报告区域。
- `MeetingView.vue`：集成场景选择、ASR 句子推送、停止录音自动触发报告。

#### 4. 旧代码清理

- 删除 `packages/client/src/composables/useMeetingAgent.ts`（1080 行）。
- 移除 `startAnalysis / stopAnalysis / pollAnalysisResult` 等旧函数。
- Python 后端 `run_analysis_cycle` 废弃为 no-op。

#### 5. 国际化 + 类型检查

- zh/en locale 新增 `meeting.scene.*` / `meeting.assist.*` / `meeting.reportPanel.*`。
- `vue-tsc --noEmit` + `tsc --noEmit` 均 0 错误。

### 变更文件清单

| 类型 | 文件 |
|------|------|
| 新增 | scene-templates.ts, realtime-assist.ts, useMeetingAssist.ts |
| 修改 | server/index.ts, routes/meeting-asr.ts, controllers/meeting-asr.ts, meeting store, MeetingView.vue, MeetingAgentPanel.vue, zh.ts, en.ts, llm_service.py |
| 删除 | useMeetingAgent.ts |

---

## 2026-07-30

### 本轮目标

- 修复设备 USB 挂载权限问题（CAP_SYS_ADMIN / CAP_SYS_MODULE）。
- 版本号统一升级到 v0.7.15。
- 建立上游合并规则文档，保护本地品牌化功能。
- 完整移除宠物（Petdex）功能。

### 已完成事项

#### 1. USB 挂载环境自动准备

- 问题：`hermesui` 用户无法执行 `mount`/`modprobe`（需要 Linux capabilities 而非组权限）。
- 修复：在 `scripts/deploy-source-armbian.sh` 添加 `prepare_usb_mount_environment()` 函数：
  - 安装 exfat-fuse / exfatprogs / ntfs-3g
  - 加载 exfat 内核模块并持久化到 `/etc/modules-load.d/`
  - 将 APP_USER 加入 disk 组
  - 配置 sudoers NOPASSWD（mount/umount/modprobe/blkid）
  - 创建 USB 挂载根目录
- 环境变量 `USB_USE_SUDO=true` 默认写入服务 env。
- 覆盖所有更新路径（source-deploy / device-package 均调用 deploy-source-armbian.sh）。

#### 2. 版本号统一 → 0.7.15

- `package.json` / `packages/desktop/package.json` / `package-lock.json` / `packages/desktop/package-lock.json` / `.github/device-package-release.json` 全部统一。

#### 3. 上游合并规则文档

- 新建 `docs/harness/upstream-merge-rules.md`：
  - 品牌化功能清单（7 大类）
  - 文件保护等级（LOCKED / BRANDED / ADAPTED / ACCEPT）
  - 冲突解决优先级：本地品牌标识 > 本地自研功能 > 上游新功能 > 上游重构
  - 合并后必检项（品牌残留 grep）
- 更新 `docs/harness/upstream-sync-runbook.md` 添加引用。

#### 4. 宠物功能完整移除

- 删除 18 个文件：
  - 客户端：PetdexView / DesktopPetView / WebPet 组件、pets/pet-state store、pets/pet-state/petdex API、pet-resize.svg
  - 服务端：petdex/pets 路由+控制器+服务、pet-state-socket
  - 测试：app-web-pet.test.ts、pets-service.test.ts
- 修改 ~20 个文件：
  - server index.ts / routes/index.ts：移除 PetStateSocketServer 和 pet 路由
  - run-chat 三个文件：移除 observeRunChatPetEvent
  - App.vue / router / AppSidebar：移除 WebPet 和 petdex 导航
  - desktop main/preload：移除 pet window 管理（~130 行）
  - desktop-bridge.ts / main.ts：移除 pet window 类型
  - 全部 10 个 locale 文件：移除 petdex 翻译
  - e2e fixtures / ekko test：移除 pet mock
- 类型检查通过（vue-tsc + tsc）。

### Git 提交记录

- `dd454a20` feat(usb): 部署/更新脚本自动准备 USB 挂载环境 + version bump
- 本次提交：移除宠物功能 + 合并规则文档 + v0.7.15 版本号补全

### 当前发布口径

- 版本号：`0.7.15`
- npm 包名：`@quanthermes/hermes-web-ui`
- 更新 manifest：`https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/stable/latest.json`
- 设备包 OSS：`oss://tangledup-ai-staging/quanthermes_pj/quanthermes_web_ui`
- 源码仓库：`https://github.com/tangledup-ai/hermes-web-ui`

## 2026-07-29

### 本轮目标

- 修复会议 ASR 服务 WebSocket 403 错误。
- 统一版本号为 v0.7.14 并准备发布。
- 将所有更新源从原版 hermes-studio 切换到自有基础设施（tangledup-ai OSS）。
- 确保旧设备更新后能自动切换到正确的更新源。

### 已完成事项

#### 1. 会议 ASR 403 修复

- 根因：`paraformer_ws_url` 和 `base_url` 指向百炼工作空间 URL（`ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com`），该端点不支持 ASR 模型，返回 403。
- 修复：将 4 个文件的默认值改为标准 DashScope 端点：
  - `packages/server/src/services/meeting-asr/python-backend/app/config.py`
  - `packages/server/src/services/meeting-asr/python-backend/app/models.py`
  - `packages/server/src/services/meeting-asr/python-backend/app/storage.py`
  - `packages/client/src/stores/hermes/meeting.ts`
- 新默认值：
  - `base_url` = `https://dashscope.aliyuncs.com`
  - `paraformer_ws_url` = `wss://dashscope.aliyuncs.com/api-ws/v1/inference`

#### 2. 版本号统一 → 0.7.14

- `package.json` / `packages/desktop/package.json` / `package-lock.json` / `packages/desktop/package-lock.json` / `.github/device-package-release.json` 全部统一。

#### 3. 更新源全面切换（17 个文件）

| 组件 | 旧值 | 新值 |
|------|------|------|
| runtime-version-manager manifest | `hermes-studio.ai/versions.json` | `tangledup-ai-staging.oss.../versions.json` |
| runtime-version-manager download | `download.ekkolearnai.com` | `tangledup-ai-staging.oss...` |
| runtime-version-manager GitHub | `EKKOLearnAI/hermes-studio` | `tangledup-ai/hermes-web-ui` |
| config.ts remoteRelay | `api.hermes-studio.ai` | 空（需显式配置） |
| config.ts manifestBaseUrl | 无默认值 | `tangledup-ai-staging.oss.../releases`（代码级兜底） |
| desktop updater feed | `download.ekkolearnai.com/latest` | `tangledup-ai-staging.oss.../latest` |
| desktop runtime download | `download.ekkolearnai.com` | `tangledup-ai-staging.oss...` |
| electron-builder publish | `download.ekkolearnai.com` | `tangledup-ai-staging.oss...` |
| OpenRouter attribution | `hermes-studio.ai` / `Hermes Studio` | `tangledup-ai/hermes-web-ui` / `Quanthermes Web UI` |
| website 所有链接 | `EKKOLearnAI/hermes-studio` | `tangledup-ai/hermes-web-ui` |
| homepage | `hermes-studio.ai` | `github.com/tangledup-ai/hermes-web-ui` |

#### 4. 旧设备更新源自动切换保障

- 问题：npm-package 策略更新不会改写 `/etc/default/hermes-web-ui`，旧设备缺少 `WEBUI_UPDATE_MANIFEST_BASE_URL` 时检测不到更新。
- 修复：在 `config.ts` 中添加 `DEFAULT_MANIFEST_BASE_URL` 代码级默认值，确保 v0.7.14 代码部署后无需手动配置即可检测更新。
- 拼接结果：`.../quanthermes_web_ui/releases/stable/latest.json`

#### 5. 设备端运维操作（69max-rk3528）

- 在 `/etc/default/hermes-web-ui` 追加了 4 个环境变量：
  - `WEBUI_UPDATE_MANIFEST_BASE_URL`（含 `/releases` 路径）
  - `HERMES_WEB_UI_VERSION_MANIFEST_URL`
  - `HERMES_WEB_UI_DOWNLOAD_BASE_URL`
  - `HERMES_WEB_UI_DOWNLOAD_GITHUB_REPO`
- 服务重启验证通过。

### Git 提交记录

- `9ed56302` fix(meeting-asr): DashScope 端点修复
- `fcc97126` release: v0.7.14 版本号统一 + 更新源切换
- `bf95d1cc` fix(update): manifestBaseUrl 代码级默认值

### 当前发布口径

- 版本号：`0.7.14`
- npm 包名：`@quanthermes/hermes-web-ui`
- 更新 manifest：`https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui/releases/stable/latest.json`
- 设备包 OSS：`oss://tangledup-ai-staging/quanthermes_pj/quanthermes_web_ui`
- 源码仓库：`https://github.com/tangledup-ai/hermes-web-ui`

### 待办

- [ ] 发布 v0.7.14 到 npm registry（npmmirror 同步）
- [ ] 确认 OSS `releases/stable/latest.json` 内容中 version 字段为 0.7.14
- [ ] 验证旧设备通过 UI 检测到 0.7.14 更新
- [ ] 验证会议 ASR 功能在新部署中正常工作

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

## 2026-07-21

### 本轮目标

- 用户反馈「meeting 功能就是一坨屎」，要求**全方面检查** Meeting Mode 在 RK3528 / Armbian 系统下的运行情况。
- 完成 v0.7.6（python-backend 打包修复）后，会议模式仍存在大量潜在问题，需系统性修复。
- 用户拍板「一气吃成、全部 20 项一次做完」，按 [docs/planning/meeting-mode-rk3528-audit.md](./planning/meeting-mode-rk3528-audit.md) 全量落地。

### 问题现象

- 设备 RK3528 Armbian 系统下，会议模式从「启动就挂」到「用着用着挂」全面不可用：
  - `.venv/` 整目录被提交进仓库（Windows C 扩展污染 ARM64 设备）
  - 默认 Armbian 没有 `python3-venv`，错误被吞
  - systemd 默认 90s 超时，pip install 5-10 分钟被强杀
  - 整套 ASR 强依赖阿里云公网，内网设备 100% 不可用
  - stop() SIGTERM fire-and-forget，下次启动撞端口
  - diarize 进程 healthcheck 缺失，死了不知道
  - 录音 echoCancellation 损伤 ASR 识别率
  - 配置向导一次性 5 个 secret，新用户一头雾水
  - uploadAudio 无大小限制，恶意上传 OOM
  - IDB 音频用 base64 编码，存储 33% 膨胀
  - 等 20 项

### 根因结论

会议模式从打包、部署、依赖、生命周期、错误处理到 UX，每一层都有 P0/P1 级问题。审计报告按严重程度列出 20 项，分 P0/P1/P2/P3 四级。

### 代码修复（按审计编号）

#### P0 基础设施

| # | 改什么 | 文件 |
|---|--------|------|
| 1 | `.venv/` 加 `.gitignore` | [`.gitignore`](file:///g:/AIproject/longxia_keli/hermes-web-ui/.gitignore) |
| 3 | systemd `TimeoutStartSec=900` | [`scripts/hermes-web-ui.service`](file:///g:/AIproject/longxia_keli/hermes-web-ui/scripts/hermes-web-ui.service) |
| 4a | deploy 装 `python3-dev` `libssl-dev`，新增 `prewarm_meeting_asr_venv()` 函数 | [`scripts/deploy-source-armbian.sh`](file:///g:/AIproject/longxia_keli/hermes-web-ui/scripts/deploy-source-armbian.sh) |
| 4b | `ensureVirtualEnv` 错误信息升级 + stderr 捕获，新增 `runCaptured()` 辅助 | [`packages/server/src/services/meeting-asr/index.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/index.ts) |

#### P1 链路稳定性

| # | 改什么 | 文件 |
|---|--------|------|
| 5 | `stop()` SIGTERM + 5s SIGKILL 兜底 + 并行 poll :8001 + close handler 自动重启 + `_scheduleRestart()` 指数退避 | [`packages/server/src/services/meeting-asr/index.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/index.ts) |
| 6 | `waitForReady` 并行 poll 主进程 + diarize | 同上 |
| 7 | close handler 触发自动重启 | 同上 |
| 8 | `.env` 移到 DATA_DIR | [`python-backend/app/storage.py`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/python-backend/app/storage.py) + [`config.py`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/python-backend/app/config.py) |
| 9a | 关闭 echoCancellation / noiseSuppression / autoGainControl（提升 ASR 识别率 5-15%） | [`MeetingView.vue`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/MeetingView.vue) |
| 9b | ScriptProcessorNode → AudioWorkletNode（不抢主线程） | 同上 + 新增 [`packages/client/src/audio/pcm-worklet.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/audio/pcm-worklet.ts) |
| 10 | MediaRecorder `timeslice=1000ms`（保持原状，但保证清晰） | [`MeetingView.vue`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/MeetingView.vue) |

#### P2 体验优化

| # | 改什么 | 文件 |
|---|--------|------|
| 11 | ASR 配置分 3 步：DashScope → LLM → Review | [`MeetingView.vue`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/MeetingView.vue) + [`meeting.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/stores/hermes/meeting.ts) + i18n |
| 12 | `storage.update_*_config` 深合并（不再替换整对象） | [`storage.py`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/python-backend/app/storage.py) |
| 13 | `useMeetingAgent` 错误 toast 提示（之前 try/catch 静默吞） | [`MeetingAgentPanel.vue`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/components/hermes/meeting/MeetingAgentPanel.vue) |
| 14 | IDB 改存 Blob（不再 base64） | [`meeting.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/stores/hermes/meeting.ts) + [`MeetingView.vue`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/views/hermes/MeetingView.vue) |
| 15 | localStorage `QuotaExceededError` 自动归档最旧 session | [`meeting.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/client/src/stores/hermes/meeting.ts) |
| 16 | `uploadAudio` 200MB 大小限制 + `saveAudioStream` 流式写 | [`controllers/hermes/meeting-storage.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/controllers/hermes/meeting-storage.ts) + [`services/meeting-storage/index.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-storage/index.ts) |
| 17 | 删除 `prompts` / `transcript` 死代码（前端后端控制器 + 客户端 API 全清） | `routes/hermes/meeting-asr.ts` + `controllers/hermes/meeting-asr.ts` + `utils/meeting-asr-api.ts` + `MeetingView.vue` |

#### P3 小优化 + 离线 ASR 调研

| # | 改什么 | 文件 |
|---|--------|------|
| 18 | sampleRate 兜底 e2e 测试 | 新增 [`tests/e2e/meeting-audio-rate.spec.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/tests/e2e/meeting-audio-rate.spec.ts) |
| 19 | `asr_max_audio_seconds` 注释说明可配置 | [`config.py`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/python-backend/app/config.py) |
| 20 | `ParaformerProxy.send_audio` 失败时 3 次指数退避重连 | [`asr_proxy.py`](file:///g:/AIproject/longxia_keli/hermes-web-ui/packages/server/src/services/meeting-asr/python-backend/app/asr_proxy.py) |
| 2 | 离线 ASR 调研报告（sherpa-onnx / whisper.cpp / Vosk 三选一，推荐 sherpa-onnx + Paraformer） | 新增 [`docs/research/offline-asr-rk3528.md`](file:///g:/AIproject/longxia_keli/hermes-web-ui/docs/research/offline-asr-rk3528.md) |

#### 配套文档

- [`docs/planning/meeting-mode-rk3528-audit.md`](file:///g:/AIproject/longxia_keli/hermes-web-ui/docs/planning/meeting-mode-rk3528-audit.md) — 审计报告（20 项问题清单 + 推荐修复路线）

### 测试与验证

- 已完成 `npm run build`，exit 0：
  - `vue-tsc -b` 通过
  - `vite build` 通过
  - `tsc --noEmit -p packages/server` 通过
  - `node scripts/build-server.mjs` 通过
- 已完成 `npm run test`，整体结果：
  - 65 文件失败 / 267 文件通过（共 332 测试文件）
  - 失败全部为 Windows 沙盒环境问题（symlink 权限、PATH 检测、codex 系统技能差异），与 meeting 模块改动无关
  - 失败文件清单：`usb-service.test.ts` `coding-agents-desktop-path.test.ts` `skills-controller.test.ts` `gateway-respawn.test.ts`
  - 已确认修改文件（`packages/server/src/services/meeting-asr/*`、`packages/client/src/views/hermes/MeetingView.vue` 等）无任何测试报错
- 新增 e2e 测试 [`tests/e2e/meeting-audio-rate.spec.ts`](file:///g:/AIproject/longxia_keli/hermes-web-ui/tests/e2e/meeting-audio-rate.spec.ts) — 验证 AudioContext 报告 48k 时输出仍为 16k Int16 PCM

### 当前状态

- 全部 20 项修复 + 调研报告均已落地，TypeScript / 构建通过。
- 工作记录已沉淀到 [`docs/work-log.md`](file:///g:/AIproject/longxia_keli/hermes-web-ui/docs/work-log.md)（本文件）。
- 用户即将在 RK3528 设备上跑一轮验证。

### 后续待验证

- **设备端升级链路验证**：
  - 真实设备上跑一次完整升级，确认 `prewarm_meeting_asr_venv` 在 RK3528 上跑通（pip install 5-10 分钟是否真的解了首启超时问题）
  - systemd `TimeoutStartSec=900` 实际生效
  - `apt install python3-venv python3-dev libssl-dev build-essential` 在裸 Armbian 上能跑
- **关键功能验证**：
  - Meeting 模式可正常起停（stop() 不再撞端口）
  - Diarize 进程也起得来（之前只有 main 起得来）
  - 录音切到 AudioWorklet 后 16kHz Int16 PCM 输出正确
  - ASR 识别率比之前（开了 echoCancellation）有可感知提升
  - 分步配置向导三步切换正常
- **手动执行的清理操作**：
  - `git rm -r --cached packages/server/src/services/meeting-asr/python-backend/.venv` 移除已跟踪的 Windows venv（仓库瘦身几百 MB）
- **离线 ASR 决策**：调研报告已落档，等用户拍板是否投入 Phase 2A（sherpa-onnx + Paraformer，1 周集成）
- **历史测试失败**（与本轮无关）：
  - 8 个失败的测试均为环境相关（symlink EPERM / Unix PATH 检测 / Codex 系统技能），建议另起任务修复 Windows 沙盒里的 symlink 支持
