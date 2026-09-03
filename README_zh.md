<p align="center">
  <strong>Hermes Studio</strong>
  <a href="./README.md">English</a>
</p>

<p align="center">
  面向 Hermes Agent 的桌面应用、本地运行时和 Web 控制台。<br/>
  聊天、模型与 Profile 管理、平台渠道接入、任务自动化、<br/>
  文件查看、Coding Agent 和本地运行环境都在一个界面中完成。
</p>

<p align="center">
  <code>npm install -g hermes-web-ui && hermes-web-ui start</code>
</p>

## 核心能力

| 模块 | Hermes Studio 能做什么 |
|---|---|
| Agent 聊天 | 运行 Hermes Agent 对话，支持流式回复、工具调用轨迹、文件上传下载和本地持久化会话。 |
| 本地控制台 | 在一个仪表盘中管理 Profile、Provider、模型、凭证、记忆、技能、插件、日志和运行时设置。 |
| 自动化 | 围绕同一套 Hermes Profile 配置平台渠道、Cron 任务、Kanban 任务、群聊房间和 MCP Server。 |
| 工作区工具 | 提供文件浏览器、Web 终端、语音输入输出、Coding Agent、设备发现和性能视图。 |
| 分发形态 | 支持 Windows/macOS/Linux 桌面应用、npm CLI 包和 Docker 镜像。 |

## 功能特性

### AI 聊天

- 聊天前端通过 Socket.IO `/chat-run` 实时流式更新；聊天运行通过 Hermes agent bridge 执行
- 多会话管理 — 创建、重命名、删除、切换会话
- **自建会话数据库** — Web UI 会话使用本地 SQLite；Hermes state.db 仅作为只读来源用于 Hermes 历史 API
- 按来源分组会话（Telegram、Discord、Slack 等），可折叠手风琴面板
- 活跃会话实时指示器 — 正在进行的会话置顶并显示旋转图标
- 按最新消息时间排序会话列表
- Markdown 渲染，支持语法高亮和代码复制
- 工具调用详情展开（参数 / 结果）
- 按 Profile 隔离的文件上传
- 文件下载支持 — 按解析后的路径下载用户上传文件和 Agent 生成文件，兼容 local、Docker、SSH、Singularity 等多种 terminal backend
- 会话搜索 — Ctrl+K 搜索 Web UI 本地会话库；不包含只读 Hermes 历史会话
- 按账号授权 Profile 汇总模型选择器 — 只展示当前账号可访问的 Hermes Profile 中可用的模型
- 每个会话显示模型标签和上下文 Token 用量

### 平台渠道

在一个页面统一配置 **8 个平台**：

| 平台 | 功能 |
|---|---|
| Telegram | Bot Token、提及控制、表情回应、自由回复聊天 |
| Discord | Bot Token、提及、自动线程、表情回应、频道白名单/黑名单 |
| Slack | Bot Token、提及控制、Bot 消息处理 |
| WhatsApp | 启用/禁用、提及控制、提及模式 |
| Matrix | Access Token、Homeserver、自动线程、私信提及线程 |
| 飞书 | App ID / Secret、提及控制 |
| 微信 | 扫码登录（浏览器扫码，自动保存凭证） |
| 企业微信 | Bot ID / Secret |

- 凭证管理写入 `~/.hermes/.env`
- 渠道行为设置写入 `~/.hermes/config.yaml`
- 每个平台已配置/未配置状态检测

### 用量分析

- Token 总用量明细（输入 / 输出）
- 会话数及日均统计
- 预估费用追踪及缓存命中率
- 模型使用分布图
- 30 天每日趋势（柱状图 + 数据表格）

### 定时任务

- 创建、编辑、暂停、恢复、删除 Cron 任务
- 立即触发执行
- Cron 表达式快捷预设

### Kanban

- 按 Profile 管理的 Kanban 看板，用于规划和跟踪 Agent 工作
- 可在仪表盘中创建任务、更新任务并移动状态
- 复用 Web UI 本地状态和认证体系

### 模型管理

- 从凭证池自动发现模型（`~/.hermes/auth.json`）
- 从每个 Provider 端点获取可用模型（`/v1/models`）
- 添加、更新、删除 Provider（预设 & 自定义 OpenAI 兼容）
- OpenAI Codex 和 Nous Portal OAuth 登录
- Provider URL 自动检测，支持非 v1 API 版本（如 `/v4`）
- Provider 级别模型分组，支持切换默认模型

### 多配置文件

- 创建、重命名、删除、切换 Hermes 配置文件（Profile）
- 克隆现有配置文件或从归档导入（`.tar.gz`）
- 导出配置文件用于备份或分享
- 按 Profile 隔离配置、缓存、上传、会话、任务、用量、记忆、技能、插件、Provider 和模型可见性
- 账号绑定 Profile 权限：超级管理员可以管理全部 Profile；普通管理员只能查看和使用分配给自己的 Profile

### 文件浏览器

- 浏览远程后端文件（local、Docker、SSH、Singularity）
- 上传、下载、重命名、复制、移动和删除文件
- 上传文件保存到当前选择/请求的 Hermes Profile 目录下；下载按真实路径解析，支持下载上传目录外的 Agent 产物
- 创建目录
- 查看文件内容，支持语法高亮

### 群聊

- 多 Agent 聊天房间，通过 Socket.IO 实时通信
- @提及路由 — 提及 Agent 触发上下文回复
- 上下文压缩 — 历史消息超过 Token 阈值时自动摘要压缩
- 输入状态和回复进度指示器
- 房间创建、删除和邀请码管理
- Agent 管理 — 添加/移除房间中的 Agent，支持独立 Profile
- SQLite 消息持久化
- 移动端响应式布局，可折叠侧边栏

### Coding Agents

- 在 Web 仪表盘中启动和监控本地 Coding Agent 会话
- 为 Codex 和 Claude Code 集成提供独立代理路由
- 支持 DeepSeek Harness（`deepseek-harness`）托管 Coding Agent，通过 JSON-RPC stdio 驱动并复用同一流式事件管道
- 持久化 Agent 输出和 reasoning 元数据，便于后续查看

### 技能与记忆

- 浏览和搜索已安装的技能
- 查看技能详情和附件
- 用户笔记和档案管理

### 日志

- 查看 Agent / Server / Error 日志
- 按日志级别、日志文件和关键词过滤
- 结构化日志解析，HTTP 访问日志高亮

### 管理与运行时

- 设备和局域网 Peer 页面，用于本地网络发现和 Peer 工具能力
- MCP 管理器，用于托管的 `hermes-studio` MCP Server 和 Profile 自动注入
- Runtime Version 和 Version Preview 工具，用于隔离测试新版本
- 面向超级管理员的性能监控视图

### 认证

- 基于 Token 的认证（首次运行自动生成或通过 `AUTH_TOKEN` 环境变量设置）
- 用户名/密码登录，并在设置页提供账户管理
- 默认登录名/密码为 `admin` / `123456`；登录后会提示尽快修改默认账户和密码
- 超级管理员可以管理用户和 Profile 绑定；普通管理员只能管理自己的账户信息

CLI 维护命令：

```bash
# 删除持久化的登录 IP 锁记录
hermes-web-ui clear-login-locks

# 删除登录锁并重启正在运行的 Web UI 进程
hermes-web-ui clear-login-locks --restart

# 创建或重置默认超级管理员登录名/密码为 admin / 123456
hermes-web-ui reset-default-login
```

`clear-login-locks` 会删除 `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/.login-lock.json`。如果服务正在运行，需要重启服务才能清理内存中的锁定状态。`reset-default-login` 会更新 Web UI 账户数据库；如果已存在 `admin` 用户，则会把密码重置为 `123456`，并启用为超级管理员账户。

登录页在 IP 被锁（HTTP 429/503）时会显示两个按钮 ——「清除登录锁定」和「重置默认密码」，由统一的恢复密码保护，默认与出厂 admin 密码一致（`12345678`）；可通过 `HERMES_WEB_UI_RECOVERY_PASSWORD` 环境变量配置为独立的值。

### 设备扫码登录（Token Platform）

硬件 Hermes 设备（QuantClaw / 量迹龙虾盒子等）首次开机时，可在登录页扫描微信二维码绑定 [Token Platform](https://api.quantclaw.vip) 账号 —— 设备端无需手动输入用户名密码。绑定后设备持有专属 API key + 模型白名单，每次开机自动恢复，无需重复扫码。

流程：

1. 设备首次开机，LoginView 渲染微信二维码（`WeChatQrPanel.vue`）。
2. BFF 调 Token Platform `POST /api/device-login/request`，传入设备的稳定 `hardware_id`（随机 UUID，持久化在 `HERMES_WEB_UI_HOME/device-id`，缺失时重新生成），拿到 `{appid, state, redirect_uri}`。
3. 用户用微信扫码并在手机端确认。
4. 设备轮询 `GET /api/device-login/status?login_id=..`；批准后 Token Platform 一次性返回 `{api_base, api_key, models, device_id}`（`KeyDelivered` 标志防泄漏）。
5. BFF `POST /api/auth/device-login` 用 `verifyDeviceApiKey` 校验设备 API key，取绑定的用户资料，首次运行时自动在本地引导出 `admin` 超级管理员，签发 Hermes JWT，并把绑定持久化到 `${HERMES_WEB_UI_HOME}/device-binding.json`（含 `api_base / api_key / models / display_name / username / bound_at / expires_at`）。
6. 后续开机由 `useDeviceBinding` 读取 `device-binding.json`，调 `POST /api/auth/device-login/restore` 重新签发 JWT，无需重新扫码。

环境变量：

- `TOKEN_PLATFORM_BASE_URL`（默认 `https://api.quantclaw.vip`）—— Token Platform 地址。
- `HERMES_WEB_UI_HOME` —— 存放 `device-id` 和 `device-binding.json` 的目录。

Web UI BFF 端点：

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `POST` | `/api/auth/device-login` | 无 | 用 `{api_base, api_key, device_id, device_name, models}` 完成扫码登录。 |
| `POST` | `/api/auth/device-login/restore` | 无 | 后续开机从持久化绑定恢复 JWT。 |
| `GET`  | `/api/auth/device-binding` | 需要 | 读取当前持久化的绑定。 |
| `DELETE` | `/api/auth/device-binding` | 需要 | 清除绑定，下次开机重新显示二维码。 |

解绑：**设置 → 设备绑定 → 解绑**，或调 `DELETE /api/auth/device-binding`。解绑只清本地绑定文件，Token Platform 上的账号和设备 API key 仍然有效，要彻底作废请去 `https://api.quantclaw.vip` 后台删除设备。

### 设置

- 显示（流式输出、紧凑模式、推理过程、费用显示）
- Agent（最大轮次、超时时间、工具强制执行）
- 记忆（启用/禁用、字符限制）
- 会话重置（空闲超时、定时重置）
- 隐私（PII 脱敏）
- 模型设置（默认模型 & Provider）
- Profile 和 Provider 配置

### 语音 / TTS / STT

- 可在聊天和群聊消息中朗读 Assistant 回复。
- Provider 支持：浏览器 Web Speech、内置 Edge TTS、OpenAI 兼容 `/audio/speech`、自定义 OpenAI 兼容 TTS 端点、MiMo。
- MiMo 支持预置音色、音色设计提示词、音色复刻参考音频（`.mp3`/`.wav`，最大 10 MB），并可选择鉴权请求头模式（`Authorization`、`api-key` 或两者同时发送）。
- Edge / OpenAI 兼容 / 自定义 / MiMo 播放统一走 Web UI 后端 `/api/hermes/tts/synthesize`，停止/暂停状态一致，并会在可行时中断进行中的 fetch。
- Provider API Key 和 MiMo 复刻参考音频保存在服务端 TTS 设置中，浏览器只显示脱敏后的 secret 状态。
- 使用 OpenAI / 自定义 / MiMo 播放前，先在 Settings → Voice 保存 provider 设置。消息播放只发送文本和非敏感播放参数，后端合成时读取当前用户保存的私钥。
- 聊天输入框支持回合制语音输入：通过麦克风按钮开始/停止一轮录音，转写结果会先填入当前输入框，用户可以编辑后再用普通发送按钮发送。
- 语音输入 / STT 可在支持时使用浏览器语音识别，也可使用在 Settings → Voice 中配置的服务端 provider。
- 当 Assistant 音频正在播放时，开始新的语音输入会先停止播放。这个 barge-in 只打断音频，不会隐式取消正在运行的 Agent；停止 run 仍然需要显式操作。
- 支持的设置项、安全边界和当前非目标范围见 [`docs/voice-dialogue.md`](./docs/voice-dialogue.md)。
- 限制：浏览器/服务端中断后，外部 TTS Provider 仍可能继续处理请求；自定义 / OpenAI 兼容 / MiMo base URL 必须是公网 `http`/`https` 端点，不能指向 localhost 或私网。

### 会议模式

实时语音转写与 AI 会议分析功能，支持说话人分离和智能会议纪要生成。

**核心功能：**

| 功能 | 说明 |
|---|---|
| 实时语音转写 | 通过 WebSocket 连接 ASR 服务，实时将语音转为文字 |
| 说话人分离 | 基于阿里云 DashScope Paraformer 模型，自动识别不同说话人 |
| 说话人重命名 | 点击说话人标签可自定义名称，重命名后自动同步到所有相关句子 |
| 说话人数设置 | 支持自动识别或手动指定 2-8 人，提升分离精准度 |
| 音频录制与回放 | 录制会议音频，支持进度条拖拽、点击句子跳转播放 |
| AI 分析 | 支持 Hermes Agent 或自定义模型分析，生成摘要、要点、待办事项 |
| 多格式导出 | 支持下载音频（WebM）、转写文本（TXT）、JSON 结构化数据、HTML 报告 |

**说话人分离模式：**

- 开启说话人分离后，系统会自动识别不同说话人
- 可手动设置说话人数（2-8 人）以提高识别准确度
- 说话人 ID 会自动映射为可读名称（说话人 1、说话人 2...）
- 支持重命名说话人，重命名后所有历史记录同步更新

**JSON 导出格式：**

```json
{
  "title": "会议标题",
  "createdAt": "2026-07-17T10:00:00.000Z",
  "speakers": [
    { "id": "0", "displayName": "张三" },
    { "id": "1", "displayName": "李四" }
  ],
  "sentences": [
    {
      "index": 1,
      "text": "会议发言内容",
      "startTimeMs": 1000,
      "endTimeMs": 3500,
      "speakerId": "0",
      "speakerName": "张三"
    }
  ],
  "analysis": {
    "summary": "会议摘要",
    "meeting_type": "项目汇报",
    "key_points": ["要点1", "要点2"],
    "action_items": [
      { "task": "撰写上线方案", "assignee": "张三", "deadline": "2026-07-25" }
    ],
    "decisions": ["v0.74 灰度发布，先开功能开关"],
    "risks": ["ASR 后端仍是单节点"],
    "learnings": [],
    "feedback": { "positive": [], "negative": [] },
    "topics": ["主题1", "主题2"]
  }
}
```

**分析流水线（v0.74）：**

- **可配置触发模式。** 每个会议可选择三种触发方式：
  - `sentences`：每 N 句自动分析一次（默认 10，范围 1–100）。
  - `time`：每 N 秒自动分析一次（默认 60，范围 10–600）。
  - `both`：满足任一条件即触发。
  在右侧面板工具栏的齿轮按钮中配置，或通过 `MeetingSession` 上的 `analysisTriggerMode` / `analysisIntervalSentences` / `analysisIntervalSeconds` 字段设置。
- **会议类型识别。** LLM 先判断会议属于 *会议纪要* / *客户回访* / *头脑风暴* / *项目汇报* / *培训分享* / *其他*，并按类型输出对应字段（decisions / feedback / risks / learnings）。
- **结构化待办事项。** `action_items` 现在为 `[{ task, assignee, deadline }]`，前端 store 和 Python 后端一致；旧的 `string[]` 数据依旧能渲染，保持向后兼容。
- **HTML 报告生成。** 服务端在每次分析后输出一份完整的自包含 HTML 文档（CSS/JS 内联，仅在含 `relationships` 时引入 ECharts），风格根据会议类型自适应。客户端缓存 `html_content`，Agent 面板提供"查看 HTML"快捷入口和报告已就绪的提示横幅。
- **复用工具。** `useMeetingAnalysis`（`packages/client/src/composables/useMeetingAnalysis.ts`）负责从 Agent 输出中提取平衡 JSON、转义 HTML、识别分析结构，由 `tests/client/useMeetingAnalysis.test.ts` 覆盖。

**稳定性补丁（v0.74.1）：**

- **更稳健的 HTML 报告提取。** `useMeetingAgent.ts` 现在从三类来源抽取 AI 生成的 HTML 报告——工具调用参数（`write_file` 及其他）、对应的工具执行结果、以及 assistant 消息中的 ` ```html ` 代码块（包括需要拼接多条 assistant 消息才能完整取出的情况）。三者都不命中时才回退到内置模板，避免 agent 直接内联报告时报告查看区空白。
- **防重入。** `sendMessage` 与 `runAgent` 在已经有 run 进行中时通过 `isRunning` 标志短路返回，防止重复点击触发器重复拉起 agent run，也避免 `isRunning` 状态被回调和并发调用互相覆盖。
- **对齐 Python 端 LLM 配置访问器。** `meeting-asr/python-backend/app/llm_service.py` 将已废弃的 `storage.get_llm_config()` 切换为 `storage.get_config().llm`，与 v0.74 引入的存储重构保持一致；旧的访问器下线后，分析与 HTML 渲染流程不再会因为这一处不一致抛出错误。

**字幕纠错（v0.74.2）：**

- **AI 字幕纠错。** Agent 面板新增 "纠错字幕" 按钮，把当前句子发给 Hermes 做 ASR 校对，agent 返回 `{index, original, corrected}` 数组，前端按序号回写到当前会话并刷新 `finalSentences`。由 `useMeetingAgent.ts` 的 `correctTranscript()` 实现，`MeetingAgentPanel.vue` 暴露按钮，`MeetingView.vue` 通过 `onAgentCorrectTranscript` 写回 store。
- **完成自动关闭面板。** 分析 run 结束时面板会发出 `completed` 事件；`MeetingView.onAgentCompleted` 在已生成 HTML 报告时自动关闭面板，让报告视图直接顶上，省一次点击。
- **多语言字符串。** `meeting.correctTranscript` 与 `meeting.correctTranscriptHint` 已加入中英文 locale 文件；其它 locale 暂以英文兜底，待后续翻译。

**ASR 模型选择与节省模式（v0.74.3）：**

- **会话级 ASR 模型选择。** 新建会议对话框新增 ASR 模型选择器，支持 `paraformer-v2` / `fun-asr` / `fun-asr-mtl` 三种模型，中英文 locale 都附带简短说明。选中的模型保存在 `MeetingSession.asrModel`，启动 ASR websocket 时随运行时配置下发。
- **节省模式（仅说话人分离）。** `MeetingView` 新增 `saveMode` 开关：开启后改连独立的 `diarize` websocket，不再走实时 ASR 流。音频上传到说话人分离服务后端，扬声器标签异步回流，足以支撑后续分析与 HTML 报告生成；DashScope 按秒计费的实时 ASR 跳过，配额紧张的用户可以省下来。
- **ASR-only 分支。** `startRecording` 把 websocket 接线分成三条显式分支——`saveMode`（仅说话人分离）、`useDiarize`（ASR + 说话人分离并行）、新增的纯 ASR-only——不需要说话人标签的用户可以彻底跳过 diarize websocket。
- **重命名即时同步。** `confirmRenameSpeaker` 现在把 store 里更新后的 `speakerMap` 一并回写到 `MeetingView` 的本地 ref（之前只回写 `finalSentences`），重命名立刻可见，无需重载会话。

**字幕纠错加固（v0.74.3）：**

- **更稳健的纠错抽取。** `useMeetingAnalysis.ts` 的 `extractCorrections()` 现在对每条解析结果做 schema 校验（`index` 必须为数字、`original`/`corrected` 必须为字符串），并兼容 LLM 偶发的三种返回形态：纯 JSON 数组、`corrections = [...]` 赋值式行、夹杂在自然语言中的 JSON 块。校验失败的负载直接返回 `null`，不再返回残缺的数组。
- **更严格的纠错 prompt。** `useMeetingAgent.correctTranscript` 中的 prompt 重写，明确 ASR 校对角色并禁止调用工具；运行参数中同时下发 pinned `instructions`，防止 Hermes 中途跑去搜网页或写文件。
- **测试覆盖。** `tests/client/extractCorrections.test.ts` 新增 6 条用例覆盖上述形态与校验分支（16/16 全绿）。

**Agent 面板优化（v0.74.4）：**

- **切换会话重载。** `MeetingAgentPanel.vue` 现在 `watch` `sessionId`，切换时从 store 重新加载 `messages` / `analysisResult` / `reportHtml`，并重置 `isRunning` / `error` / `completed` / `correctedSentences`。之前用户在 `MeetingView` 切到另一个会话时，面板还停留在上一个会议的对话上。
- **Assistant 内容走 Markdown 渲染。** 把 `<div class="assistant-content">{{ msg.content }}</div>` 替换为异步加载的 `MarkdownRenderer`，分析结果会按 Markdown 渲染（标题、列表、表格、代码块），不再是被转义的纯文本。
- **报告生成 prompt 加固。** `useMeetingAgent.generateReport` 现在通过 `sendMessage` 的第二个参数下发 pinned `instructions`，带上会议标题，并把已有 `analysisResult` 以及之前 assistant/system 消息以 `### Previous analysis result` / `### Previous conversation` 块的形式拼进 prompt。再点一次 "生成报告" 会基于之前的分析结果增量补全，而不是从头再来；严格的 instructions 同时强制 `write_file + ```html` 契约，与 `extractHtml` 的抽取规则对齐。
- **HTML 检测放宽。** `looksLikeHtmlDocument` 现在同时接受 `<!DOCTYPE html>` 开头，最小长度阈值从 200 字符降到 100 字符，短的（不含 ECharts 图表的）报告也能被识别为完整 HTML 文档。

### 口语对练 / 口语教练（v0.8.0）

AI 驱动的实时语音对话与口语练习辅导。

**核心功能：**

| 功能 | 描述 |
|---|---|
| 实时语音对话 | 基于 WebSocket 的 Omni 实时对话，支持流式回复 |
| 口语教练模式 | 严格目标语言纪律，配备专属教练人格 |
| 肢体语言评分 | 练习过程中基于摄像头的手势与姿态分析 |
| 定时练习 | 可配置的练习时长与节奏控制 |
| 会话类型分流 | 语音入口按会话类型自动路由（教练 vs. 实时对话） |
| 双主题天体 | 跟随亮色/暗色主题切换的月亮/太阳矢量素材 |
| 声纹可视化 | 64 根径向柱状均衡器显示音频 |

**视觉设计（v0.8.0）：**

- 天体素材重塑为跟随主题切换的月亮/太阳 SVG
- 声纹改为 64 根径向柱状均衡器
- 控件沉底，气泡不再与文字重叠
- 亮色模式舞台配有晨光渐变背景层与高对比度控件
- 全局统一单色水墨配色 + 紫蓝高光

**教练人格：**

- 独立于 Agent SOUL 的专属口语教练人格 — 不再产生人格冲突
- 严格目标语言执行：教练全程使用练习语言回复
- 会话入口按类型自动分流

**音频与报告增强（v0.8.0）：**

- **优雅停播：** 定时练习到点后先等当前句子播完再断开 — AI 语音不再被截断
- **跨工具调用修复：** AI 跨多工具调用的回复不再因新响应到达时音频还在播放而被截断
- **回声误打断防护：** 改善了 Linux/弱 AEC 扬声器的 barge-in 阈值 — AI 不再打断自己
- **Qwen3.5-Omni 全模态报告：** 每次练习结束后，录音和摄像头画面提交给 DashScope Qwen3.5-Omni 生成 AI 全模态深度分析，追加到确定性报告末尾
- **流式 AI 报告：** AI 分析结果实时流式渲染为 Markdown — 无需等待完整结果
- **报告下载：** 保存后，报告文件作为附件出现在聊天页面 — 关闭对练舞台后仍可下载

**旧版语音下线（v0.8.0）：**

- 旧版实时语音页面已下线
- 所有语音入口统一到全新 Omni 实时对话
- 语音会话可无缝续接文字聊天上下文

### Web 终端

- 集成终端，基于 node-pty 和 @xterm/xterm
- 多会话支持 — 创建、切换、关闭终端会话
- 通过 WebSocket 实时传输键盘输入和 PTY 输出
- 支持窗口大小调整

### 桌面应用与自动更新

- Windows、macOS 和 Linux 原生 Electron 桌面壳
- 内置 Web UI 运行时，并自动启动本地 Hermes Studio 服务
- 桌面自动更新优先使用 Cloudflare 下载端点获取更新元数据和安装包
- 如果 Cloudflare 更新源不可用，会回退到 GitHub Releases `latest` 资源
- Windows 升级时会先尝试关闭已有 Hermes Studio 进程，再替换文件

---

## 快速开始

### 桌面应用（推荐）

请从你们自己的发布渠道下载最新的 **Hermes Studio** 桌面安装包。

桌面版会发布 macOS、Windows 和 Linux 构建；适用时会区分不同 CPU 架构。
桌面应用内置 Web UI 运行时，Hermes Agent 数据会保存到原生 Hermes 目录：

- Windows：`%LOCALAPPDATA%\hermes`（找不到时回退到 `%APPDATA%\hermes`）
- macOS/Linux：`~/.hermes`

桌面壳自身的 Web UI 状态会单独保存到 `~/.hermes-web-ui`，除非设置了
`HERMES_WEB_UI_HOME`。

桌面自动更新应优先读取你们自己的更新元数据地址和安装包分发地址。

### npm 安装

```bash
npm install -g @quanthermes/hermes-web-ui
hermes-web-ui start
```

打开 **http://localhost:8648**

### 一键安装与 WSL

请使用你们自己维护的安装脚本或部署文档，不再引用官方远程安装脚本。

> WSL 使用与其他本地安装相同的 Web UI 后台启动流程；Web UI 不再单独启动 gateway 服务。

### Docker Compose

单容器部署，内置 Hermes Agent 运行时：

```bash
# 使用预构建镜像（推荐）
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# 或从源码构建
docker compose up -d --build

docker compose logs -f hermes-webui
```

打开 **http://localhost:6060**

- Hermes 持久化数据目录：`./hermes_data`
- Web UI 认证 Token 存储在 `./hermes_data/hermes-web-ui/.token`
- 首次启动并开启认证时，Token 会打印到容器日志中
- 运行参数全部由 `docker-compose.yml` 环境变量驱动

更详细的说明与排错见：[`docs/docker.md`](./docs/docker.md)

### 源码部署提醒

如果你要在 Armbian / Ubuntu 上走宿主机源码部署，请先阅读 [`docs/work-log.md`](./docs/work-log.md) 再开始执行部署步骤。

- `2026-05-19` 的工作日志记录了一个真实坑点：Hermes 被装到了 `root` 目录下，但 `hermes-web-ui.service` 实际以 `hermesui` 用户运行
- 这种安装归属错位会导致 agent bridge 报 `run_agent.py not found`，随后聊天链路出现 `ENOENT /tmp/hermes-agent-bridge.sock`
- 源码部署完成后，请优先检查 `/home/hermesui/.local/bin/hermes` 是否归属 `hermesui`，不要链接到 `/root/.local/...`

### Hermes Agent 运行时发现

Web UI 启动后端聊天能力时，会优先使用包含 `run_agent.py` 的源码目录，例如
`~/.hermes/hermes-agent`。如果找不到源码目录，会退回到已安装 `hermes` 命令所使用
的 Python 环境，再退到系统 Python。因此源码安装和 `pip install hermes-agent` 这类
包安装方式都可以兼容。

## Web UI 环境变量

这些变量只用于配置 Hermes Web UI 自身。Provider API Key 和 Hermes Agent 相关设置仍通过 Hermes profile 管理。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8648` | Web UI 监听端口。 |
| `BIND_HOST` | `0.0.0.0` | Web UI 绑定地址。如需 IPv6，可显式设置为 `::`。 |
| `HERMES_LAN_ADVERTISE_URL` | 未设置 | App 局域网二维码使用的可访问 Studio 地址。Docker 中若通过 `localhost` 打开，请设置为宿主机局域网 URL，例如 `http://192.168.1.20:6060`。 |
| `HERMES_APP_ENTITLEMENT_REQUIRED` | `true` | App 局域网 Relay 必须携带有效的云端签名。仅在临时兼容排查时设置为 `false`。 |
| `HERMES_APP_ENTITLEMENT_PUBLIC_KEY` | 内置 | 可选的 RS256 App 签名 PEM 公钥覆盖。签名 issuer 为 `hermes-studio-server`，audience 为 `ekko-studio`。 |
| `HERMES_WEB_UI_HOME` | `~/.hermes-web-ui` | Web UI 数据目录，用于认证 token、登录凭据、日志、数据库和默认上传目录。兼容支持 `HERMES_WEBUI_STATE_DIR` 作为别名。 |
| `HERMES_WEBUI_STATE_DIR` | 未设置 | `HERMES_WEB_UI_HOME` 的兼容别名。 |
| `HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT` | 未设置 | 关闭启动时向 Hermes profile 配置自动注入托管的 `hermes-studio` MCP server。 |
| `HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT` | 未设置 | 当 `HERMES_WEB_UI_HOME` 位于临时目录（例如 Version Preview runtime）时，仍允许托管 MCP 自动注入。 |
| `UPLOAD_DIR` | `$HERMES_WEB_UI_HOME/upload` | 覆盖上传根目录。文件会保存在按 Profile 隔离的子目录下。 |
| `CORS_ORIGINS` | 仅同 host | HTTP、Socket.IO、WebSocket 跨源 allowlist，支持逗号或空格分隔。只有明确需要旧版 wildcard CORS 时才设置为 `*`。 |
| `AUTH_TOKEN` | 自动生成 | 显式指定 bearer token。未设置时，Web UI 会在 `HERMES_WEB_UI_HOME` 下自动生成。 |
| `PROFILE` | `default` | 启动/默认 Hermes profile。运行时请求使用前端当前选择且当前账号有权限访问的 Profile。 |
| `LOG_LEVEL` | `info` | Server 日志级别。 |
| `BRIDGE_LOG_LEVEL` | `$LOG_LEVEL` 或 `info` | Bridge 日志级别。 |
| `MAX_DOWNLOAD_SIZE` | `200MB` | 最大文件下载大小。 |
| `MAX_EDIT_SIZE` | `10MB` | 最大可编辑文件大小。 |
| `WORKSPACE_BASE` | 当前用户 Home 目录 | Workspace 浏览根目录。 |
| `HERMES_HOME` | 平台默认值 | Hermes 数据目录。Windows 使用 `%LOCALAPPDATA%\hermes`；macOS/Linux 使用 `~/.hermes`。 |
| `HERMES_BIN` | `hermes` | 自定义 Hermes CLI 二进制路径。 |
| `HERMES_AGENT_ROOT` | 自动发现 | 包含 `run_agent.py` 的 Hermes Agent 源码目录。 |
| `HERMES_AGENT_BRIDGE_PYTHON` | 自动发现 | 用于启动 agent bridge 的 Python 解释器。 |
| `HERMES_AGENT_BRIDGE_UV` | 自动发现 | 可用时用于启动 agent bridge 的 `uv` 可执行文件。 |
| `UV` | 自动发现 | `uv` 可执行文件 fallback。 |
| `PYTHON` | 自动发现 | agent bridge 的 Python 可执行文件 fallback。 |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | 平台默认值 | Agent bridge broker endpoint。Windows 默认 `tcp://127.0.0.1:18765`；macOS/Linux 默认 `ipc:///tmp/hermes-agent-bridge.sock`。 |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | `120000` | Node 请求 bridge broker 的响应超时。 |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | `5000` | 连接 bridge socket 失败时的短重试窗口。 |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | `120000` | 等待 Python bridge ready 的超时。 |
| `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN` | 开启 | Web UI 关闭和重启时是否停止 bridge broker；设为 `0`、`false`、`no` 或 `off` 才会在重启时保留 broker。 |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | 开启 | bridge broker 意外退出后是否自动重启；设为 `0`、`false`、`no` 或 `off` 可关闭。 |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | `1000` | bridge 自动重启退避的基础延迟。 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | `cli` | 传给 Hermes Agent 的 platform 标识。 |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | 平台默认值 | Profile worker transport。设为 `tcp` 使用 loopback TCP；设为 `ipc`/`unix` 使用 Unix domain socket；默认 Windows TCP、macOS/Linux IPC。 |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | `18780` | TCP worker endpoint 起始端口。 |
| `HERMES_BRIDGE_PROVIDER` | profile/默认值 | bridge 运行时的 provider 覆盖。 |
| `HERMES_BRIDGE_TOOLSETS` | profile/默认值 | bridge 运行时的 toolset 覆盖。 |
| `HERMES_BRIDGE_MAX_TURNS` | profile/默认值 | bridge 运行时的最大轮数覆盖。 |
| `HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT` | `cli` | 控制传给 Hermes Agent 的 bridge platform hint suppression。 |
| `HERMES_OPENROUTER_APP_REFERER` | 未设置 | bridge 运行发送给 OpenRouter 的 attribution referer；如需使用，请改成你们自己的公网站点。 |
| `HERMES_OPENROUTER_APP_TITLE` | `Hermes Web UI` | bridge 运行发送给 OpenRouter 的 attribution title。 |
| `HERMES_OPENROUTER_APP_CATEGORIES` | `cli-agent,personal-agent` | bridge 运行发送给 OpenRouter 的 attribution categories。 |
| `HERMES_WEB_UI_MANAGED_GATEWAY` | 默认开启 | 控制 Web UI 托管 Hermes gateway 进程；设为 `0`、`false`、`no` 或 `off` 时改用 `hermes gateway start`。 |
| `HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART` | 未设置 | 跳过启动时的 gateway 检查/自动启动；dashboard-only 部署中如果由其它服务管理 Hermes gateway，可设为 `1`、`true`、`yes` 或 `on`。 |
| `HERMES_WEB_UI_DISABLE_SKILL_INJECTION` | 未设置 | 跳过启动时的内置 skill 注入；如果内置 skills 由 Hermes Web UI 外部管理，可设为 `1`、`true`、`yes` 或 `on`。启用注入时，Web UI 只更新自己此前安装的 skills 或内容完全相同的既有内置副本；本地修改和用户拥有的同名 skills 会跳过。 |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | 生产环境默认开启 | Web UI 关闭时是否同时停止托管的 gateway 进程；设为 `0` 或 `false` 可让 gateway 分离运行。 |
| `GATEWAY_HOST` | `127.0.0.1` | 旧 gateway 兼容配置中写入 profile 的默认 gateway host。 |
| `HERMES_WEB_UI_PREVIEW_REPO` | package repository | Version Preview 使用的 GitHub 仓库。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | 平台默认值 | Version Preview broker transport。设为 `tcp` 可让预览环境在 macOS/Linux 上也使用 loopback TCP；未设置时会跟随 `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp`。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | 隔离的预览 endpoint | 直接覆盖 Version Preview 的 broker endpoint。 |
| `HERMES_WEB_UI_BACKEND_PORT` | `8648` | Vite dev proxy 使用的后端端口。 |
| `HERMES_WEB_UI_FRONTEND_PORT` | `8649` | 前端 Vite dev server 端口。 |
| `HERMES_WEB_UI_MEETING_ASR_TLS` | `false` | 设为 `true` 时，meeting ASR 的 Python 子进程将携带 `--ssl-keyfile/--ssl-certfile` 启动，Node WS 代理改为 `tls.connect`。设备镜像上 uvicorn 需要 TLS 时开启；本地开发保留默认 `false`。 |
| `HERMES_WEB_UI_SSL_CERTFILE` | `{product_dir}/certs/server.crt` | 覆盖自签 TLS 证书路径。Node HTTPS server 与 meeting ASR uvicorn 子进程共用。 |
| `HERMES_WEB_UI_SSL_KEYFILE` | `{product_dir}/certs/server.key` | 覆盖 TLS 私钥路径。 |

### CLI 命令

| 命令 | 说明 |
|---|---|
| `hermes-web-ui start` | 后台启动（守护进程模式） |
| `hermes-web-ui start --port 9000` | 自定义端口启动 |
| `hermes-web-ui stop` | 停止后台进程 |
| `hermes-web-ui restart` | 重启后台进程；默认会关闭 bridge broker |
| `hermes-web-ui status` | 查看运行状态 |
| `hermes-web-ui update` | 更新到最新版本并重启 |
| `hermes-web-ui upgrade` | `update` 的别名 |
| `hermes-web-ui -v` | 显示版本号 |
| `hermes-web-ui -h` | 显示帮助信息 |
| `hermes-web-ui-mcp [api\|browser\|devices\|use]` | 运行一个受管 Web UI MCP 工具集（等同于 `hermes-studio-mcp`） |

`update` / `upgrade` 会先尝试执行 `npm cache clean --force`，再执行 `npm install -g @quanthermes/hermes-web-ui@latest` 并重启。缓存清理是 best-effort；如果清理失败，只提示 warning，升级安装会继续执行。

## npm 发布

- 发布包名：`@quanthermes/hermes-web-ui`
- 全局安装：`npm install -g @quanthermes/hermes-web-ui`
- 运行命令：`hermes-web-ui start`
- 发布工作流：推送 `v*` tag 后触发 [`.github/workflows/npm-publish.yml`](./.github/workflows/npm-publish.yml)
- 发布说明：[`docs/npm-release.md`](./docs/npm-release.md)

### 自动配置

启动时 BFF 服务器会自动：

- 初始化 Web UI 数据目录、本地数据库和内置技能
- 启动 `/chat-run` 使用的 Hermes agent bridge
- 启动成功后自动打开浏览器

---

## 开发

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173
- BFF 服务器：http://localhost:8648

```bash
npm run build   # 构建输出到 dist/
```

项目开发规范见：[DEVELOPMENT.md](./DEVELOPMENT.md)。

## 架构

```
```
Browser → BFF (Koa, :6060) → Socket.IO /chat-run
                ↓
                ↓
           Hermes CLI / profiles
           profile config.yaml    (渠道/Provider 配置)
           profile auth.json      (凭证池)
           腾讯 iLink API         (微信扫码登录)
```

前端采用 **多 Agent 可扩展架构** — 所有 Hermes 相关代码都按命名空间组织在 `hermes/` 目录下（API、组件、视图、Store），可以方便地并行接入新的 Agent。

BFF 层负责：Socket.IO 聊天流式推送、Hermes agent bridge、按 Profile 隔离的上传和按路径解析的下载（多 Backend 支持：local/Docker/SSH/Singularity）、会话 CRUD、分账户分 Profile 管理、配置/凭证管理、微信扫码登录、模型发现、技能/记忆/插件管理、TTS/STT、Coding Agent 代理、MCP/Runtime 管理、日志读取和静态文件服务。

## 技术栈

**前端：** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**后端：** Koa 2（BFF 服务器）+ node-pty（Web 终端）

## Star 历史

[![Star 历史图表](https://api.star-history.com/svg?repos=EKKOLearnAI/hermes-studio&type=Date)](https://star-history.com/#EKKOLearnAI/hermes-studio&Date)

<!-- 如上方图表未加载，可访问 https://star-history.com/#EKKOLearnAI/hermes-studio -->

## 许可证

[BSL-1.1](./LICENSE)

该许可证覆盖 Hermes Studio、原 Hermes Web UI 名称、`hermes-web-ui` npm 包和
CLI、桌面应用、固件、发布产物、文档以及本仓库内的关联文件。
