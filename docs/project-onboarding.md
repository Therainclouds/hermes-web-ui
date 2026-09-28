# Hermes Web UI（Hermes Studio）项目接手笔记

> 生成日期：2026-09-24 · 版本：v0.8.9 · 分支：`main`（与 `origin/main` 同步，工作区干净）

本文档面向新接手的开发者 / 编码 agent，是 `AGENTS.md` 的补充（不是替代）。
`AGENTS.md` 是规则速查，本文档是上下文地图。

---

## 1. 项目是什么

围绕 **Hermes Agent** 的自托管 AI 控制台。一个 TypeScript monorepo，同时产出：

- 浏览器 Dashboard（Vue 3 客户端 + Koa BFF 服务端）
- Electron 桌面应用（Windows / macOS / Linux）
- npm CLI 包 `@quanthermes/hermes-web-ui`（`hermes-web-ui start`）
- Docker 镜像
- **设备包（device-package）** —— 面向 ARM64 盒子（Armbian）的 OTA 更新产物

核心能力：Agent 会话聊天（Socket.IO 流式）、多 Profile / 多模型 / Provider 管理、8 个平台渠道接入、定时任务与看板、群聊多 Agent、文件浏览与 Web 终端、会议模式（ASR + 说话人分离 + AI 纪要）、文档扫描仪、知识库 RAG、语音 TTS/STT/实时对话、编码 Agent 接入。

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3（`<script setup lang="ts">`）、Vite、Naive UI、Pinia、vue-router（hash 模式）、vue-i18n（11 locale）、SCSS、markdown-it、highlight.js |
| 后端 | Koa 2 + `@koa/router`、Socket.IO、node-pty（终端）、`node:sqlite`（DatabaseSync）+ FTS5 + sqlite-vec |
| 外部进程 | Python Hermes Agent（agent-bridge 子进程 / JSON-RPC）、uvicorn（会议 ASR）、uv/pip |
| 测试 | Vitest（360+ server 用例 / 258 client 用例）、Playwright（25 e2e）、pytest（Python 侧） |
| 构建 | esbuild（`build-server.mjs`）、vue-tsc、`vite build` |

Node 要求 `>=23`。本地实测 `v24.14.0` / npm `11.9.0`，`node_modules` 已安装，`npm run harness:check` 通过。

---

## 3. Git 远程与分支策略（重要）

| Remote | 仓库 | 用途 |
|---|---|---|
| `origin` | Therainclouds/hermes-web-ui | **代码镜像**，无 release tag、无 GitHub Releases |
| `org` | tangledup-ai/hermes-web-ui | **发布主仓库**（真正的发布发生地） |
| `upstream` | EKKOLearnAI/hermes-web-ui | 上游源仓库，定期同步进 `main` |

硬规则：**tag 只推 `org`**（`git push org <tag>`），绝不推 `origin`。同步上游走 `docs/harness/upstream-sync-runbook.md`。

常见分支：`main`、`merge/*`、`sync/*`、`release/*`、`phase{1,2,3}-reconciliation`。

---

## 4. 目录地图

```
hermes-web-ui/
├─ packages/
│  ├─ client/src        Vue 客户端（views / components / stores / api / i18n / plugins / composables）
│  ├─ server/src        Koa BFF（routes / controllers / services / db / middleware / lib / shared）
│  ├─ desktop/          Electron 壳 + 打包 + 内置 Python/Hermes runtime
│  ├─ ekko-agent/       独立 agent 子包
│  ├─ skills/           内置 Hermes 技能（启动时注入）
│  ├─ website/          官网 Vite 站点（vite.config.website.ts）
│  ├─ certs/            TLS 自签证书（存在时服务端起协议嗅探单端口）
│  └─ esp32-c3/         MCU 固件
├─ scripts/             部署/更新/打包/校验脚本（.sh + .mjs，必须 100755）
│  └─ _lib/             被 source 的库脚本（atomic-swap、fixup-script-modes 等）
├─ tests/               client / server / e2e / desktop / release / python
├─ docs/                adr、harness、knowledge、planning、update-distribution、user-guide
├─ .github/
│  ├─ workflows/        build、playwright、npm-publish、device-package-release、docker、desktop-* 等 15 个
│  └─ device-package-release.json   device 包发布中央配置（packageAllowlist / sourcePathAllowlist）
└─ bin/                 hermes-web-ui.mjs、hermes-studio-mcp.mjs
```

---

## 5. 服务端架构（`packages/server/src`）

### 分层
`routes/`（注册） → `controllers/`（请求级） → `services/`（副作用 / IO / 子进程） → `db/`（SQLite store）。
**路由必须保持薄**，业务逻辑下沉到 service；控制器不塌陷成万能文件。

### 启动主流程（`src/index.ts#bootstrap()`）
1. 建目录 → 登录限流 → 技能注入 → MCP 注入 → `startAgentBridgeManager()`
2. `initAllStores()` → webhook dispatcher → USB → 安全头 / CORS / bodyparser
3. `registerRoutes(app, [requireUserJwt, resolveUserProfile])`
4. 静态托管 `packages/client` + SPA 回退
5. 监听端口（默认 **6060**，`PORT` 覆盖）；有 `certs/server.crt|key` 时起「HTTPS/HTTP 协议嗅探」单端口，并额外开一个 `127.0.0.1` 明文 loopback（HTTPS 端口+1）供本机进程调用
6. 挂载 WS / Socket.IO，最后注册 **upgrade catch-all**（不在白名单直接 destroy）
7. 关停钩子、LAN 发现、版本检查、reconcile 循环

### 路由注册顺序（硬规则）
`routes/index.ts`：public → authMiddleware → protected。**本地 API 必须先于 proxy catch-all 注册**。
唯一的正则 catch-all 是 `routes/coding-agents.ts` 的 DSH UI 隧道，所以 `update / scanner / knowledge / realtime-model / speech-practice` 必须排在它前面。

### 主要路由域
`/api/auth/*`、`/api/hermes/{sessions,profiles,config,models,providers,skills,plugins,mcp,files,download,memory,logs,jobs,kanban,workflows,group-chat,tts,stt,media,experts,journey}/*`、`/api/knowledge/*`、`/api/scanner/*`、`/api/update/*`、`/api/meeting-asr/*`、`/api/meeting-storage/*`、`/api/usb/*`、`/api/app-relay/*`、`/api/devices/*`，以及 proxy（claude-code / codex / tts / stt）。

### 关键 service
- `services/hermes/agent-bridge/` —— 托管 Python agent 子进程的 broker（长驻；`ipc:///tmp/hermes-agent-bridge.sock` 或 Windows TCP）
- `services/hermes/run-chat/` —— `/chat-run` 核心：会话运行、流式增量、压缩、usage、workspace diff
- `services/hermes/group-chat/` —— 群聊（`/group-chat`、`/group-chat-agent-relay`）
- `services/update/*` —— manifest 拉取、preflight、下载重试、任务状态机、reconcile、identity 戳
- `services/meeting-asr/`、`services/meeting-storage/`、`services/scanner/`、`services/knowledge/`、`services/workflow-*`、`services/app-relay/`、`services/global-agent/`、`services/lan-*`、`services/grading/`
- `services/auth.ts` —— JWT 与口令（鉴权集中地）
- `services/hermes/hermes-profile.ts` —— Profile 解析（**不要手工拼路径**）

### Socket.IO 命名空间
`/chat-run`、`/group-chat`、`/group-chat-agent-relay`、`/workflow`、`/grading`、`/usb`、`/meeting-assist`、`/app-relay`、`/global-agent`。
裸 WS：`/api/hermes/terminal`、`/api/hermes/kanban/events`、LAN peer socket、`/ws/asr`、`/ws/diarize`、`/ws/omni-realtime`。

### 数据（SQLite，统一 `getDb()` from `db/index.ts`，只开一个连接）
users、sessions/conversations、usage、compression 快照、devices、app-connections、chat-webhooks、group-chat documents、workflow（定义/运行/定时/workspace 变更）、tts/stt/realtime 设置、provider-audit、experts、mcu-devices、user-theme、knowledge（vaults/documents/chunks/references/embeddings_meta，FTS5 + vec0）。

### 配置（`config.ts`）
- `getWebUiHome()` —— **唯一**的 Web UI 主目录解析器（`HERMES_WEB_UI_HOME` 或别名 `HERMES_WEBUI_STATE_DIR`，默认 `~/.hermes-web-ui`），等价于 `config.appHome`
- `config.uploadDir`（`UPLOAD_DIR`）、`config.port`（6060）、`config.host`、`getLoopbackPort()`、`config.corsOrigins`、`config.update.*`

---

## 6. 客户端架构（`packages/client/src`）

- 入口 `main.ts`（先读 localStorage 主题防 FOUC → Pinia → i18n → router → `installClientPlugins()`）
- `App.vue`：`NConfigProvider` + 明暗/漫画主题 + 全局 Message/Dialog
- 路由 `router/index.ts`：hash 模式；`meta.public` 放行、无 `hermes_api_key` 跳登录、`meta.requiresSuperAdmin` 校验角色
- 页面集中在 `views/hermes/`：ChatView、HistoryView、GroupChatView、GlobalAgentView、WorkflowView（204 KB，最大）、MeetingView（103 KB）、KanbanView、FilesView、ModelsView、ProfilesView、SettingsView、TerminalView、DevicesView、USBView、CodingAgentsView、VersionPreviewView 等
- Store 在 `stores/hermes/`：`chat.ts`（142 KB，已拆出 chat-core / chat-messages / chat-queue / chat-subagents / chat-interactions）、`group-chat.ts`、`meeting.ts`、`kanban.ts`、`files.ts`、`profiles/settings/models/...`
- API：`api/hermes/`（51 个模块）+ `api/client.ts` 统一出口（`request()`：Bearer `hermes_api_key`、自动 `X-Hermes-Profile` 头、401/403 处理）
- 插件系统 `plugins/`：`scanner`、`paper-grading`（依赖 scanner）、`knowledge`；启用清单在 `plugins/index.ts`，启停持久化在 localStorage
- i18n：11 locale（en/zh/zh-TW/ja/ko/fr/es/de/pt/ru/ar），文件 `i18n/locales/<locale>.ts`；**新增文案至少改 `en.ts`（fallback），再补其他 10 个**

---

## 7. 状态与数据所有权（硬边界）

- **Web UI 状态**：`getWebUiHome()`（`~/.hermes-web-ui`）之下 —— token、账号库、日志、SQLite、上传、会议数据
- **Hermes Agent 状态**：Hermes Profile 目录之下，**与 Web UI 状态严格分离**
- 有状态 service 必须走 `getWebUiHome()`，**禁止** `process.env.HERMES_WEB_UI_HOME` 直读，**禁止** `process.cwd()` 兜底
- 五个产品边界：Web UI / Hermes Agent / Device Runtime / Release & Distribution / Desktop —— 不得互相渗透

---

## 8. 最容易踩的坑（来自真实生产事故）

1. **`+x` 位**：`scripts/` 下所有 `.sh` 和有 shebang 的 `.py` 必须 git 记录为 `100755`。Windows 上要 `core.filemode=true` 或每次 `git update-index --chmod=+x`。四层防御：git index → `build-device-package.mjs#assertArchiveScriptModes` → `_lib/fixup-script-modes.sh` → `deploy-source-armbian.sh` 自检。
2. **状态路径**：直接读 `process.env.HERMES_WEB_UI_HOME` 会漏掉 `HERMES_WEBUI_STATE_DIR` 别名（曾导致会议音频 404 且无日志）。
3. **`chown -R`**：部署脚本禁止跨挂载点递归改属主，必须走 `chown_r_mount_safe`（USB 挂载在 `$HERMES_WEB_UI_HOME/mnt/usb`，exFAT/NTFS 会让整个部署失败）。
4. **`sourcePathAllowlist`**：设备端 `npm run build` 从解包后的源码根目录跑，`docs/`、`tsconfig.*.json`、`vite.config.ts` 必须都在白名单里，否则 `ENOENT docs/openapi.json` / `TS5083`。
5. **`packageType` 契约**：manifest 的 `packageType` 必须等于设备 `WEBUI_UPDATE_PACKAGE_TYPE`；默认是 **`source-deploy`**（`device-package` 仅 opt-in）。
6. **manifest 字段**：`source-deploy` 必须有 `sourceUrl` + `sourceSha256`；`device-package` 必须有 `installerScriptSha256`。改了 `packageAllowlist` 里的脚本就必须发新设备包，否则设备报 `update_installer_script_stale`。
7. **绝不把 `WEBUI_UPDATE_MANIFEST_URL` 钉到带版本/candidate 的路径**：钉住会「永远回答成功」，设备静默冻版本（6.6.6.73 曾冻在 0.8.6）。v0.8.9 已加 `manifest_pinned_stale` 检测。
8. **Phase (a) 更新不变量**：升级路径**绝不**调用 `deploy-source-armbian.sh`（它只做 bootstrap/首次安装）；升级由 `scripts/update-orchestrator.sh` 独占。回滚只保留一代（`lastgood`，rename 式、禁用 `cp -al`）。`state/identity.json` 的 `agentManifestSha` 在 phase (c) 前是哨兵 `"0.0.0-noop"`。
9. **发布两阶段**：tag 推送只写 `candidates/<channel>/<version>.json`；`releases/<channel>/latest.json` 只能由手动 promote 工作流改（候选 ≥24h）。**禁止**加自动 promote。promote 重跑必须新 dispatch，**不要**用 "Re-run jobs"。
10. **Hermes Agent 升级绝不能是 Web UI 更新的默认副作用**。
11. **本地 bridge 陈旧 broker**：工作目录被删后 worker spawn 报裸 `[Errno 2]`。恢复：`lsof /tmp/hermes-agent-bridge.sock` → kill → `rm -f` → 重启服务端。

完整事故复盘见 `docs/harness/update-system-overview.md`（7 个真实事故）与 `docs/harness/meeting-asr-safety-audit.md`。

---

## 9. 更新与发布体系

三种更新策略（互斥，各自拉不同产物、跑不同脚本）：

| 策略 | 产物 | 脚本 | 校验强度 |
|---|---|---|---|
| `source-deploy` | 源码 tarball | `update-orchestrator.sh`（升级）/ `deploy-source-armbian.sh`（仅首次） | 松（有 npm registry 回退） |
| `device-package` | 预构建设备 tarball | `install-device-package.sh` | 严（manifest 是唯一真相 + 脚本指纹） |
| `npm-package` | npm tarball | `update-npm-package` 路径 | 松 |

- 发布产物通道：npm registry / OSS（device tar + wheelhouse）/ GitHub Releases / `release-manifests` 分支
- 设备身份：`state/identity.json` + `POST /api/update/identity/repair`（漂移修复 = 用当前部署重打戳，不是强制重装）
- 已知开放问题：无人校验「设备上跑的代码 == manifest 声明的代码」（v0.7.0 客户事故）；`install-device-package.sh:36` 的 `PORT=8648` 默认值会静默改端口

---

## 10. 当前进度与下一步

- **当前版本 v0.8.9**（最新提交 `0535234f9`）。本轮已完成：知识库 task-12（自动 vault、配额、USB 按需扫描、半自动任务归档）、`manifest_pinned_stale` 检测 + 部署守卫、Qwen STT/TTS、虚拟宠物 Petdex、MCU 设备目录、DeepSeek Harness 管理 UI。
- **TRPG 插件已在 `dfccceab5` 中被剥离**，代码里只剩 2 处注释级残留。**但 `README.md` 与 `AGENTS.md` 仍在大量描述 TRPG** —— 文档陈旧，需要清理。
- **下一个规划任务：task-13「Hermes Agent update seam」(v0.8.10)**，规范见 `docs/harness/agent-update-seam-spec.md`：
  - 新增 `updates/policy.json` 的 `agentUpdate: off | prompt | auto`（**默认 off**）
  - `scripts/update-orchestrator.sh` 新增 `agent_upgrade` 阶段（journal → preflight → 下载验 sha256 → 快照 → pip install → 重启 bridge → healthcheck → 失败回滚）
  - 新增 `/api/hermes/agent-update/{status,apply,tasks/:id}`（注册在 proxy catch-all 之前）
  - `/health` 增加 `agent_version / agent_latest / agent_update_available / agent_update_policy`
  - 激活 `identity.json` 的 `agentManifestSha`（64-hex）
  - Settings 更新卡片改成两行（Web UI / Hermes Agent 各自独立）
- 知识库插件 specs：`docs/knowledge/specs/task-01..12`（T1–T11 已落地 v0.8.8，T12 落地 v0.8.9）

---

## 11. 常用命令

```bash
npm run dev                 # Vite(6060) + Koa(nodemon) 并行
npm run build               # openapi:generate → vue-tsc -b → vite build → tsc server → build-server.mjs
npm run test                # vitest run
npm run test:coverage       # 覆盖率（CI 用的就是它）
npm run test:e2e            # playwright
npm run harness:check       # 仓库级不变量（PR 必跑）
npm run build:device-package
npm run test:device-package-release
```

最小验证矩阵见 `docs/harness/validation.md`（按改动类型选最小集；涉及 update/deploy/release 还要 `npm run build:device-package` 并核对 manifest 字段）。

PR 规则：从 `main` 拉短分支、一次提交只做一件事、PR 正文含 what/why/impact/validation、关联 issue（`Closes #123`）。自检清单 `docs/harness/pr-review.md`。

---

## 12. 建议的下一步动作（备选）

1. 清理 `README.md` / `AGENTS.md` 中已剥离的 TRPG 描述（低风险、立即改善可读性）
2. 启动 task-13（Hermes Agent update seam，v0.8.10）
3. 修 `install-device-package.sh` 的 `PORT` 默认值问题（已记录为开放问题）
4. 给 device-package 加「dist 版本串 == manifest 版本」的发布期断言（收口 v0.7.0 事故）
