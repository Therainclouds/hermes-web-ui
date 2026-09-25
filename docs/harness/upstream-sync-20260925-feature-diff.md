# 上游 / 本地 功能对照（2026-09-25）

> 上游：`upstream/main` `9363b9955`（Ekko Studio 0.7.24）
> 本地：`main` `0535234f9`（Quanthermes Hermes Web UI 0.8.9）
> 配套文档：`upstream-sync-20260925-triage.md`（同步评审）、`upstream-merge-rules.md`（合并规则）

---

## 〇、一句话结论

**两边的共同底盘是"Hermes Agent 控制台"，但产品线已经分道扬镳：**

- 上游把精力投向 **Ekko Agent 运行时 + 手机 App 生态 + 编码 Agent 矩阵**，并且**彻底删掉了会议、扫描仪、知识库、专家市场、USB**。
- 本地把精力投向 **会议 ASR、知识库 RAG、文档扫描/批改、专家市场、USB、设备 OTA 更新**，并且**没有 Ekko 那套手机 App 生态**。

所以可移植的东西比想象中少，而"我们有他们没有"的资产比想象中多。

---

## 一、双方都有（共同底盘，约 30 个域）

这些功能两边都还在，是 fork 前的共同遗产。同步时只需挑 bugfix，不需要移植整体。

| 域 | 上游路由 | 本地路由 | 备注 |
|---|---|---|---|
| 认证 / 恢复 / 健康 | `auth` `health` `api-docs` | 同 | 本地多了设备码登录、Token Platform 绑定 |
| 会话 / 聊天执行 | `sessions` `chat-run` | 同 | 本地多了自建会话库 |
| Profile / 模型 / Provider | `profiles` `models` `providers` `config` | 同 | 本地多了专家市场绑定 |
| 文件 / 上传 / 下载 | `files` `upload` `download` `app-upload` | 同 | |
| 技能 / 技能包 / 插件 | `skills` `skill-bundles` `plugins` | 同 | |
| 记忆 / MCP | `memory` `mcp` | 同 | 上游拆成 hermes + ekko 两份 |
| 群聊 | `group-chat` | 同 | 本地多了跨机 agent-link / remote-workspace |
| 工作流 / 看板 / 定时任务 | `workflows` `kanban` `jobs` `cron-history` | 同 | |
| TTS / STT | `tts` `stt` | 同 | 本地多了 MiMo、本地 STT 模型管理 |
| 设备 / MCU / 固件 | `devices` `mcu-devices` `mcu-firmware` | 同 | |
| 宠物 / 图鉴 | `pets` `petdex` | 同 | 本地刚从 ekko-studio 移植 |
| 编码 Agent 代理 | `claude-code-proxy` `codex-proxy` `coding-agents` `write-gate` | 同 | 上游多了 Grok / OpenCode / Pi |
| 微信 / 各平台 OAuth | `weixin` `codex-auth` `nous-auth` `copilot-auth` `xai-auth` `anthropic-auth` `minimax-auth` | 同 | |
| 更新 / runtime 版本 | `update` `runtime-versions` | 同 | **但实现完全不同**，见第四节 |
| 日志 / 旅程 / 性能 / 主题 | `logs` `journey` `performance-monitor` `theme` | 同 | |
| Webhook / 媒体 / 旅程 | `chat-webhooks` `media` `journey` | 同 | |

---

## 二、上游有、我们没有（本次更新的主体）

### 2.1 服务端新增路由模块

| 模块 | 是什么 | 移植价值 |
|---|---|---|
| `session-shares` | **会话分享 + 作用域权限**，访客凭令牌访问单个会话，按 scope 授权 | ⭐⭐⭐ 纯服务端，可搬（详见第三节） |
| `jev` | **JEV**：技能匹配、记忆召回、相关性过滤、学习评估（#3159–#3171） | ⭐⭐ 全新模块，你已确认要 |
| `agents` / `agent-status` | 统一 Agent 运行时管理（#2760），把 Hermes / Ekko / 编码 Agent 收敛到一套管理面 | ⭐⭐ 结构性，成本中 |
| `announcements` | 产品公告（#2989，启动弹窗显示最新公告） | ⭐ 含品牌文案，需改造 |
| `social-messages` | 社交消息推送（#2718） | ⚠️ 依赖 App 连接生态，见第三节 |
| `app-connections` | App 连接管理（购买链接、本地化失败提示，#2873） | ⚠️ 含商业化 CTA，需裁剪 |
| `legacy-data-migration` | Ekko 重命名后的旧数据迁移（#2988） | ❌ 纯品牌迁移，不要 |

### 2.2 客户端新增页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/social-messages` | `SocialMessagesView.vue` | 社交消息页 |
| `/studio/agents` `/studio/agents/:agentId/:section(skills\|mcp\|settings\|plugins\|presets)` | — | **统一 Agent 管理台**，五大分区 |
| `/ekko/memory` `/ekko/skills` `/ekko/mcp` `/ekko/settings` | `ekko/{Memory,Skills,Mcp,Settings}View.vue` | Ekko Agent 专属四页 |
| `/hermes/agents` | `AgentManagerView.vue` | Agent 管理器 |
| `/hermes/connections` | — | 设备连接页（本地是 `/hermes/devices`） |
| `/hermes/config/settings` | `HermesSettingsView.vue` | Hermes 设置页（与 `/hermes/settings` 并存） |
| — | `CodingAgentConfigView.vue` | 编码 Agent 配置页（#2854） |
| `/hermes/history/group-chat/:roomId` `/hermes/group-chat/history/:roomId` | — | 群聊历史 |

### 2.3 编码 Agent 矩阵（你已确认要）

| Agent | PR | 本地现状 |
|---|---|---|
| **Grok** | #2832 | 无 |
| **OpenCode** | #2890 #2932 #2996 #3010 | 无（含免费 provider、无需 key 的代理） |
| **DSH（DeepSeek Harness）** | #3020 #3026 #3038 #3156 | **本地已有**（刚从 ekko-studio 移植） |
| **Pi** | #2991 #2888 | 无 |
| 全局隔离模式 | #2828 | 无 |
| Skills/MCP 视图统一 | #2871 | 无 |

### 2.4 Ekko Agent 运行时（170 文件，最大一块）

记忆体系（生产库化 + 遗忘复核）、上下文压缩、并行工具调用、浏览器工具、工具失败自愈、
任务计划持久化（#2952）、独立 MCP 工具（#3053）。

⚠️ **注意**：这块现在是上游 "Ekko" 品牌的组成部分，且 `packages/ekko-agent` 与服务端 `modules/ekko` 是**两套东西**：
- `packages/ekko-agent/`（独立包）—— 本地自分叉以来 **0 改动**，上游改 170 文件 → **可整包同步**
- `modules/ekko/`（服务端模块）—— 与品牌、重构深度耦合 → 只能手工移植

---

## 三、我们有、上游没有（本地自研资产，重点保护）

用全树文件命中数对比，结论非常干净：

| 功能域 | 上游文件数 | 本地文件数 | 说明 |
|---|---|---|---|
| **会议 ASR** | **0** | **117** | 实时转写、说话人分离、AI 纪要、HTML 报告、Omni 实时语音、口语对练 |
| **知识库 RAG** | **0** | **128** | vault / 抽取 / 切块 / 向量嵌入 / FTS5+vec0 混合检索 / USB 卷扫描 / 配额 |
| **文档扫描 + 批改** | **0** | **55** | UVC 摄像头扫描、边缘检测、OCR、可搜索 PDF、教师批改工作台 |
| **USB 监控** | **0** | **41** | USB 设备枚举、插拔事件、挂载 bot（`hermes_data/bots/usb/`） |
| **专家市场** | **0** | **33** | 市场目录、安装/升级/卸载、profile 绑定 |

其余本地独有：

- **客户端插件体系** `packages/client/src/plugins/`（scanner / paper-grading / knowledge）—— 上游**根本没有 plugins 目录**，这是本地独有架构
- **device-package OTA 更新系统** —— 上游的 `update` 路由是普通 npm/源码更新，本地是自研的设备包 + manifest 指纹 + 身份戳体系
- **设备二维码登录（Token Platform）**、**LAN peer 互连**、**跨平台 P2P 终端**
- 本地 `/hermes/meeting`、`/hermes/usb`、`/hermes/experts`、`/hermes/client-plugins` 等页面上**游均不存在**

> **含义**：这五个域上游一个字节都没有，意味着**以后不会有上游冲突**，但也意味着
> 上游永远不会帮我们维护它们。它们是纯粹的本地负债 + 本地资产。

---

## 四、三组待定功能：到底能不能搬

### 4.1 消息推送（social message push，#2718）

**是什么**：不是 APNs 直推。从改动面看（`api/social-messages.ts` 186 行 + `ChatInput.vue` +
`AppConnectionsPanel.vue` + 11 个 locale），它是**通过已建立的 App 连接，把会话消息推送到绑定的手机端**，
是一个"消息出站通道"，推送目标是 App 而非系统通知。

**面向谁**：装了他们手机 App 并已绑定 App Connection 的用户。

**依赖**：App 连接体系（app-connections / app-relay）。**没有他们的 App，这个功能就是个死 UI。**

**能不能搬**：⚠️ 半残。能搬的部分是消息出站的事件与文案；搬了也没用的是 App 端投递。
且 `docs/app-relay.md` 里云端地址仍是上游品牌 `api.hermes-studio.ai` / `cn.hermes-studio.ai`，
搬之前必须按 `upstream-merge-rules.md` 做品牌清理。

### 4.2 iOS Live Activities（#3111）

**是什么**：把正在跑的 Agent 任务进度实时渲染到 iPhone **锁屏 / 灵动岛**（ActivityKit），
不用解锁就能看到进度。改动集中在服务端：
`modules/studio/services/notifications/live-activity.ts`（249 行）、
`live-activity-store.ts`、`live-activity-runtime-store.ts`、`live-activity-catchup.ts`、
`live-activity-registration.ts`，外加 `sockets/chat-run.ts` 推送钩子。

**面向谁**：**仅 iOS App 用户**。

**依赖**：Apple 开发者账号 + **APNs p8 密钥/证书** + App 的 Push Notifications capability + 客户端 ActivityKit 实现。
上游还有 `docs/live-activity/recovery-and-priority.md` 专门讲恢复与优先级。

**能不能搬**：❌ **完全不能搬，搬了也没用**。iOS 独占 + APNs 证书强依赖，我们没有对应 App 和证书。
后续 #3151 #3152 #3167 三个 fix 也是围绕它，一并放弃。

### 4.3 会话分享与作用域权限（session shares，#3121–#3144）⭐

**是什么**：把**一个会话通过分享令牌发给别人（访客无需账号）**，访客只拿到按 scope 授权的那一小部分能力。

**实现位置**（纯服务端，无客户端 App 依赖）：
```
modules/studio/routes/session-shares.ts
modules/studio/controllers/session-shares.ts
modules/studio/contracts/session-shares.ts
modules/studio/repositories/session-shares-store.ts
modules/studio/services/session-shares/{service,settings,app-identity,http-access}.ts
```

**scope 档位**（从提交标题归纳）：

| scope | 控制什么 | PR |
|---|---|---|
| 身份 scope | 校验访客身份，决定可见的购买/权益信息 | #3121 |
| 会话设置 scope | 访客能改哪些会话设置（默认大多不可改） | #3122 |
| 语音 scope | 共享 TTS / 语音模式需单独授权 | #3129 |
| 上下文/模型 scope | 共享会话的上下文上限按模型权限二次校验；scoped 编码 Agent 必须用宿主上下文与压缩设置 | #3128 #3134 |
| 文件 scope | 会话内上传附件纳入共享访问白名单；Agent 公开发布的图片给访客副本而非暴露原路径 | #3144 `27544731b` |

**访客能做什么 / 不能做什么**：与本仓**已有的群聊邀请分享**高度同构
（`SharedGroupChatView.vue` + `docs/chat-chain-changes/2026-08-07-group-chat-invite-share-page.md`）：
能读写该会话消息、@Agent、访问该会话目录内附件；不能做房间管理、工作区操作、中断/审批、跨会话文件访问。

**能不能搬**：✅ **可以搬，而且是这三组里唯一真正值得搬的**。纯服务端 + Web 能力，
无 APNs / 无 App 依赖，且是**安全加固**性质——我们已有的群聊分享是同源设计，移植路径清晰。

---

## 五、已确认的决策

| # | 决策 |
|---|---|
| JEV（#3159–#3171） | ✅ 要 |
| Grok / OpenCode 编码 Agent | ✅ 要 |
| 不可逆分叉 + 选择性 merge | ✅ 确认，后续同步一律走 cherry-pick / 手工移植 |
| **iOS 功能（Live Activities 等）** | ❌ **不需要**（2026-09-25 确认） |
| **消息推送（social message push）** | ❌ **完全不需要**（2026-09-25 确认） |
| 上游品牌残留 | ✅ 确认要清理，见第六节 |
| `packages/ekko-agent` 整包同步 | ⏸ 暂缓，待功能对照看清后再定 |
| 会话分享权限 | ⭐ 列入 L3 手工移植（三组里唯一可搬的） |

---

## 六、下一步建议顺序

1. **先做 L2**：60 个纯 bugfix cherry-pick（风险最低，立刻见效）
2. **再做 L3-a**：会话分享权限（安全收益实在，且我们有同构的群聊分享可参照）
3. **再做 L3-b**：Grok / OpenCode 编码 Agent（纯新增，不碰存量）
4. **最后 L3-c**：JEV（上游自己也还在规划，最后一个提交仍是 docs plan，可以再观察一轮）
5. **暂缓**：`packages/ekko-agent` 整包、`agents` 统一管理台（结构性改造，成本高）
6. **放弃**：Live Activities、品牌迁移、Ekko 品牌相关

---

## 七、上游品牌残留清理（2026-09-25）

判定标准：本地是否有对应的自有基础设施。**有**（OSS / tangledup-ai 仓库）→ 替换；
**没有**（上游云服务 API）→ 不能简单替换，改为移除硬编码、由环境变量显式配置，或随功能一起废弃。

### 已清理（7 处，零功能影响）

| 文件 | 旧值 → 新值 |
|---|---|
| `services/runtime-version-manager.ts:12` | fallback `hermes-studio.ai/versions.json` → 与本地 OSS 主地址一致 |
| `packages/website/.../StarHistorySection.vue:13,50` | `EKKOLearnAI/hermes-studio` → `tangledup-ai/hermes-web-ui` |
| `README.md:659,665` | 一键安装脚本 URL → `tangledup-ai/hermes-web-ui` |
| `README_zh.md:804,806` | star-history 图表与链接 → `tangledup-ai/hermes-web-ui` |
| `docs/deploy-armbian.md:40,60` | 仓库地址 → `tangledup-ai/hermes-web-ui` |
| `.github/ISSUE_TEMPLATE/config.yml:4,7` | issue / discussions 链接 → `tangledup-ai/hermes-web-ui` |
| `packages/desktop/README.md:9` | 发布页链接 → `tangledup-ai/hermes-web-ui` |

### 待决策（绑定"是否保留 App 云中继"，不能盲改）

| 位置 | 残留 | 为什么不能盲改 |
|---|---|---|
| `config.ts:251` | `appRelay.url` 默认 `https://api.hermes-studio.ai` | 这是手机 App 云中继入口。我们没有对应云服务，改成 OSS 地址语义错误；改成空则 App 中继不可用。`work-log.md:1677` 既定方案是「空（需显式配置）」 |
| `services/app-relay/route.ts:7` | `CLOUDFLARE_APP_RELAY_URL = https://cn.hermes-studio.ai` | 同上，是 cloudflare 备用路由 |
| `client/src/api/studio-versions.ts:1` | `api.hermes-studio.ai/api/studio/versions` | 版本清单取自上游云服务 |
| `esp32-c3/v1/v2/src/main.cpp` | `kRemoteDeviceLookupUrl = https://api.hermes-studio.ai` | 固件硬编码的远程设备查询地址；改源码后需**重新编译**，`release/*/firmware.bin` 里的旧域名才会消失 |
| `services/hermes/local-stt-model-manager.ts:14,15` | `download.ekkolearnai.com` / `EKKOLearnAI/hermes-studio` | 本地 STT 模型下载源，OSS 上没有对应模型包，替换后功能会失效 |
| `.github/workflows/website-deploy.yml:93` | `DEPLOY_DIR=/var/www/ekkolearnai.com/current` | 官网部署目标目录，需确认现网实际路径 |

> 改 `config.ts` / `route.ts` / `studio-versions.ts` 会连带失败 6 处测试断言
> （`app-relay-route.test.ts`、`studio-version-manifest.test.ts`、`mcu-login-controller.test.ts`、
> `app-relay-controller.test.ts`、`runtime-version-manager.test.ts`），需一并更新。
