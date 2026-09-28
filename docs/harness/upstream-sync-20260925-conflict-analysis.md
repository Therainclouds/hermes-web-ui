# 不可合并模块 — 功能与冲突分析（2026-09-25）

> 针对 `upstream/main` `9363b9955` → `main` `0535234f9`。
> 每个模块给出：**它是什么** / **上游代码块在哪** / **冲突怎么发生** / **硬合的代价**。
> 冲突数量来自 `git merge-tree --write-tree --name-only --messages main upstream/main` 实测。

---

## D1｜服务端架构重命名（`modules/**`）

### 它是什么
`#2744 refactor: enforce canonical server module ownership`。
把服务端从「按技术分层」改成「按业务域收编」：扁平的 `services/ controllers/ routes/ db/ middleware/ lib/ shared/`
连同 `config.ts`、`security.ts` 一起，拆进四个领域模块，另加一个 `bootstrap/`。
是纯粹的**工程重构**，不引入用户可见功能。

### 上游代码块
```
packages/server/src/
  modules/hermes/{routes,controllers,services,contracts,repositories,sockets,public,infrastructure}/**
  modules/studio/**
  modules/ekko/**
  modules/coding-agents/**
  bootstrap/**
packages/client/src/api/studio/**        ← 由 api/hermes/* 整体迁来（60 文件，相似度 R087–R100）
```
**同时删除**：`services/ controllers/ routes/ db/ middleware/ lib/ shared/ config.ts security.ts`

### 冲突怎么发生
冲突类型：**`CONFLICT (file location)`**（rename/modify）+ **`CONFLICT (modify/delete)`**。

机制：同一批文件，两边做了互斥的事——

| 上游 | 本地 |
|---|---|
| 把 `services/X.ts` **移动**到 `modules/<域>/services/X.ts` 并**重写** | 在 `services/X.ts` **原位置**被 828 个独有提交持续修改 |

git 既不敢随上游移动（会丢本地 828 个提交的改动），也不敢保留本地原位（上游已删除该路径），于是报
`file location` 冲突，需要人工决定「文件最终应该在哪」。

实测冲突分布：

| 冲突路径 | 数量 |
|---|---|
| `packages/server/src/modules` | 218 |
| `packages/server/src/services`（file location） | 135 |
| `packages/server/src/controllers`（file location） | 19 |
| `packages/server/src/routes`（file location） | 13 |
| `packages/server/src/db`（file location） | 6 |
| `packages/server/src`（add/add、modify/delete） | 29 |

### 硬合的代价
解决这 ~391 个服务端冲突 ≠ 逐个挑 hunks，而是**把整个服务端按新结构重写一遍**，
并且必须把本地全部自研域迁移进去：
`services/update/`（device-package OTA）、`services/usb/`、`services/knowledge/`、
`services/scanner/`、`services/grading/`、`services/meeting-asr/`、`services/hermes/experts/`。

**判定：拒绝。**

---

## D2｜Ekko Studio 品牌化

### 它是什么
上游把自己的产品从 `Hermes Studio` 改名为 **`Ekko Studio`**，连带迁移 MCP 服务名、仓库地址、
官网域名、CLI 名、桌面更新源。四条主提交：`#2966` `#2980` `#2988` `#3147`。
**用户可见的品牌改名**，不含功能增量。

### 上游代码块
全仓 **51 个文件**含 `ekko-studio`，**22 个**含 `EKKOLearnAI`。核心冲突点（已逐项比对）：

| 位置 | 上游值 | 本地值 |
|---|---|---|
| `package.json` `name` | `ekko-studio` | `@quanthermes/hermes-web-ui` |
| `package.json` `version` | `0.7.24` | `0.8.9` |
| `package.json` `homepage` | `https://ekkostudio.xyz` | `https://github.com/tangledup-ai/hermes-web-ui` |
| `package.json` `bin` | `hermes-studio-mcp` + **`ekko-studio-mcp`** | `hermes-web-ui-mcp` + `hermes-studio-mcp` |
| `bin/ekko-studio-mcp.mjs` | 新增（2255 行） | 不存在 |
| `packages/desktop/package.json` / `electron-builder.yml` | appId、productName、publish.url | `com.quanthermes.hermeswebui` / Quanthermes Studio |
| 桌面更新源 / CDN | `download.ekkolearnai.com` | `tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com` |
| `packages/client/src/i18n/locales/*.ts`（11 个） | Ekko 品牌文案 + 用户名 | quanthermes 引用 |
| `packages/website/src/i18n/*.ts` | 全部品牌文案 | Quanthermes 品牌 |
| `services/hermes/agent-bridge/manager.ts` | OpenRouter attribution 上游值 | `Quanthermes Web UI` |
| README / README_zh / DEVELOPMENT / `.gitignore` | 上游仓库与产品名 | 本地品牌 |

### 冲突怎么发生
冲突类型：**内容冲突（content）**，逐个字段互斥。

它不是"合并不进去"，而是**合进来就等于把本地品牌擦掉**——
同一行 JSON、同一个 i18n key、同一个 electron-builder 字段，两边各写各的值。

### 硬合的代价
`upstream-merge-rules.md` 的 LOCKED / BRANDED 清单里这些文件优先级最高，
接受上游 = 主动丢弃 Quanthermes 品牌。

**判定：拒绝。**

---

## D3｜iOS Live Activities

### 它是什么
把正在运行的 Agent 任务进度，实时渲染到 iPhone **锁屏 / 灵动岛**（Apple ActivityKit），
用户不解锁就能看到进度。伴随三个修复：陈旧 destination 回收 `#3167`、
与旧的"会话推送关闭"开关解耦 `#3151`、App 语言透传 `#3152`。

### 上游代码块
```
packages/server/src/modules/studio/services/notifications/live-activity.ts        (249 行)
packages/server/src/modules/studio/services/notifications/live-activity-catchup.ts
packages/server/src/modules/studio/services/notifications/live-activity-registration.ts
packages/server/src/modules/studio/repositories/live-activity-store.ts
packages/server/src/modules/studio/repositories/live-activity-runtime-store.ts
packages/server/src/modules/studio/repositories/live-activity-usage.ts
docs/live-activity/recovery-and-priority.md
tests/server/live-activity{,-catchup,-usage}.test.ts
```
提交：`e7e4fdd8e`(#3111) `7be044018`(#3167) `3d2fe623f`(#3151) `2ef4c445f`(#3152)

### 冲突怎么发生
**这一条的关键：它不是 git 冲突，是运行时依赖冲突。** 三重不可解：

1. **路径冲突（附带）** —— 全部落在 `modules/studio/` 下，天然带 D1 的 file-location 冲突。
2. **证书依赖** —— 需要 Apple 开发者账号 + **APNs p8 密钥/证书** + App 的 `Push Notifications` capability。
3. **客户端依赖** —— 需要 iOS App 内的 ActivityKit 实现来渲染锁屏 UI。

服务端那条 249 行的 `live-activity.ts` 只是**编排层**，真正的推送下发走 Apple APNs、
真正的界面渲染在 iOS App 里。我们没有 App、没有证书、也没有 iOS 端代码。

### 硬合的代价
搬进来的是一个**永远返回失败或不触发的死链路**：能编译，但没有任何一端的对等实现去消费它。
纯负债。

**判定：拒绝（用户 2026-09-25 已确认 iOS 功能不需要）。**

---

## D4｜消息推送 / 手机 App 生态

### 它是什么
在直聊 / 群聊 / 工作流产生事件（Agent 完成、待审批、新消息）时，
向**已绑定的手机 App** 推送消息出站，而不是只发浏览器通知。
含 iOS/Android 两侧、设备级推送偏好、通知预览文案、前台通知等一组提交。

> 注意：它**不是** APNs 裸推。从改动面看（客户端占大头），
> 它是**经 App 连接体系把消息投递到已配对手机**的出站通道 + 一个社交消息收件箱页面。

### 上游代码块
```
服务端（modules/studio）：
  services/notifications/run-push.ts
  services/notifications/push-registration.ts
  services/notifications/user-push-registration.ts
  services/notifications/push-secrets.ts
  services/notifications/notification-preview.ts
  services/notifications/run-push-snapshot.ts
  routes/app-connections.ts
  controllers/push-registration.ts

客户端：
  packages/client/src/api/social-messages.ts                    (186 行，新增)
  packages/client/src/views/social-messages/SocialMessagesView.vue（新增页面 /social-messages）
  packages/client/src/components/hermes/chat/ChatInput.vue
  packages/client/src/components/hermes/connections/AppConnectionsPanel.vue
  packages/client/src/components/hermes/settings/PlatformSettings.vue
  packages/client/src/i18n/locales/*.ts（11 个）

测试：tests/client/social-messages-view.test.ts 等
```
提交：`f8f854fa2`(#2718) `66066fc5b`(#2940) `f9e002e52`(#3131) `002fcec16`(#3135)
`85e1f0d52`(#3146) `133fc71be`(#3133) `25bcec6d9`(#3127)

### 冲突怎么发生
三重冲突：

1. **路径冲突** —— 服务端全在 `modules/studio/`，带 D1 结构冲突。
2. **依赖冲突** —— 需要对方的手机 App 与已建立的 App Connection；我们没有 App。
3. **能力重叠冲突（最容易被忽略）** —— 本地**已经有一套**通知实现：

   | 本地已有 | 说明 |
   |---|---|
   | `packages/client/public/notification-sw.js` | Service Worker，处理 `notificationclick` 跳回 `/hermes/...` |
   | `packages/client/src/utils/completion-notification.ts` | 完成通知（含多标签去重、文案脱敏） |

   合并后会同时存在**两套通知通道**（浏览器/桌面 SW 通知 + App 推送出站），
   触发点、开关、去重逻辑互不知情，而 App 那条永远是死路。

### 硬合的代价
引入一条跑不通的出站链路 + 一套重复的通知状态。

**判定：拒绝（用户 2026-09-25 已确认完全不需要）。**

---

## D5｜版本发布与 changelog

### 它是什么
上游一个月发了 9 个版本：`0.7.11 → 0.7.24`，共 15 个 `chore(release) / bump / changelog` 提交。
纯粹的版本号递增 + 本地化变更日志。

### 上游代码块
```
package.json                        → version
package-lock.json                   → version（2 处）
packages/desktop/package.json       → version
packages/desktop/package-lock.json  → version（2 处）
.github/device-package-release.json → version
packages/client/src/data/changelog.ts → 变更日志内容
```
提交：`48c420957` `470cc6a34` `fe9a36000` `2d59a3caf` `11dc1deff` `292a675d6`
`dfb86f3c6` `ee728bdc7` `6e9e68717` `8d964022d` `e8145feee` `b0555a0b3`
`4935b0a7a` `c346b4108` `4805c44b1`

### 冲突怎么发生
**数值冲突**：上游版本线 `0.7.x` 与本地 `0.8.9` 不在同一条线上。

接受上游 = **版本号倒退**（`0.8.9` → `0.7.24`），并让 `changelog.ts` 记录一串我们从未发布过的版本。
按 `upstream-merge-rules.md`「版本号取本地较高版本」，本地胜出。

### 硬合的代价
版本号回退会直接影响 device-package 更新判定（设备据此决定是否升级）。

**判定：拒绝，保留本地 0.8.9。**

---

## D6｜（防御项）上游删除的 242 个文档

### 它是什么
上游删除了 `docs/**` 下的 **242 个文件**，其中绝大部分是 `docs/chat-chain-changes/*.md`。

### 冲突怎么发生
**这些文件与本地现存文件完全重名**（实测 242/242 重叠）。

merge 时的行为：本地未改动过的同名文件会被**直接删除**；本地改动过的会报
`CONFLICT (modify/delete)` 等人工裁决。无论哪种，结果都是本地这批文档被清空。

### 为什么必须拦
`AGENTS.md` 明确要求：改动 Chat session chain / Agent Bridge / compression / Group Chat
必须新增一个 `docs/chat-chain-changes/*.md` fragment。这批文件是**流程强制产物**，不是历史垃圾。

### 处理
cherry-pick 路线天然不跟随删除；若任何时候走 merge，必须显式保护这批路径。

---

## 汇总

| 模块 | 冲突性质 | 冲突量 | 判定 |
|---|---|---|---|
| D1 架构重命名 | file location / modify-delete | ~391（服务端） | 拒绝，结构不可解 |
| D2 品牌化 | content（逐字段） | 51 文件含品牌值 | 拒绝，会覆盖本地品牌 |
| D3 Live Activities | 运行时依赖（APNs + iOS App） | 7 文件 + 3 测试 | 拒绝，合了也跑不起来 |
| D4 消息推送 | 依赖 + 与本地通知能力重叠 | 10 服务端 + 5 客户端 + 11 locale | 拒绝，用户已确认不需要 |
| D5 release/changelog | 数值倒退 | 6 个版本文件 × 15 提交 | 拒绝，取本地 0.8.9 |
| D6 文档删除 | delete / modify-delete | 242 文件，100% 重叠 | 必须拦截，不得跟随删除 |
