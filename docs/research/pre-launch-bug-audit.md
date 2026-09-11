# Hermes Web UI 上线前 BUG 调研报告

> **范围**：覆盖客户端、服务端、跨端集成与发布流程的潜在上线风险
> **视角**：产品经理 + 终端用户 + On-call 工程师
> **审计时间**：2026-09-04（基于仓库当前 `main` 分支 HEAD）
> **覆盖度**：读取 50+ 关键文件，扫描 100+ 处高风险模式
> **分级**：P0 数据损坏/崩溃/安全、P1 功能失效/静默失败、P2 体验摩擦/粗糙、P3 锦上添花

---

## ⚠️ 2026-09-05 复核修正（代码级逐条验证后的结论）

本报告初版为静态扫描产物。修复前对每条 P0 做了代码级复核，以下初版发现在**业务流程上不成立**，属于误报，未做修复：

| 初版编号 | 误报原因 |
|---|---|
| P0-S1/S2（roomId 路径穿越） | room ID 全部由服务端生成（`routes/hermes/group-chat.ts:197` generateId，纯字母数字），且 `managedRoom()` 要求 `getRoom(roomId)` 在数据库命中才放行，`../` 永远 404 在路径拼接之前。**不可达。** |
| P0-C4（meeting-asr dataDir 绕过 getWebUiHome） | 设备上部署脚本显式设置 `MEETING_ASR_DATA_DIR=/var/lib/hermes-web-ui/meeting-asr`（deploy-source-armbian.sh:1179）；`cwd/data/meeting-asr` 是文档化的 dev-only 兜底。改掉会破坏设备上已预热 venv 与已存 key 的复用。**有意设计。** |
| P1-1/P1-2（裸 JSON.parse 列表） | 初版引用了 v0.7.7 审计的旧清单。当前代码中 ChatInput.vue:503、ChatPanel.vue:708、completion-notification.ts:144/199/210、HistoryView.vue:152、meeting.ts 全部已有 try/catch + fallback 保护。**已修复，无残留。** |
| P0-C3（archiveOldSessions 竞态误删） | 单线程 JS 内无竞态；"quota 满时删最旧会议"是作者注释里声明的最后手段。真实缺陷只有一条：截断循环未排除**正在录音的会议**（见已修复项 #5）。 |
| P0-C5（auto-restart 误判 SIGTERM） | `stop()` 在发 SIGTERM 前同步置 `_autoRestart=false`；Node close 事件对 SIGTERM 报 `code=null`，`(code ?? 0) !== 0` 为 false，不会重启。**时序实际安全。** |

实际修复的缺陷（均为复核后确认的真实问题）：

1. `useMeetingAudio.ts` — `detachBeforeUnloadAudioBackup` 用未注册的 `noop` 做 removeEventListener，监听器永不卸载（每次进会议页泄漏一组 beforeunload/pagehide + audioChunks 闭包）。
2. `useMeetingAudio.ts` — `stopRecording` 中 `ws = null` 先于 500ms 延迟关闭执行，`ws?.close()` 永远 no-op，socket 半开残留。
3. `useMeetingAudio.ts` — `startRecording` 中途失败（如 worklet 被 CSP 拦截、WS 建连异常）时麦克风流与 AudioContext 不回收，麦克风持续占用。
4. `MeetingView.vue` — `saveCurrentMeeting` 服务端保存失败仅 console.error，用户在换设备/清浏览器数据后会静默丢数据；现补 toast（新增 `meeting.errorSaveMeetingFailed`，zh/en/zh-TW）。
5. `meeting.ts` — quota 兜底截断循环按 `activeSessionId` 保护当前活跃会话，不再截断正在录音的会议的转写。（初版按 `status === 'recording'` 保护是死代码：录音期间没有任何代码把 status 置为 'recording'，已在二次复核中纠正。）

其余未在上述清单内的发现仍需按条复核后再修。

---

## 第 0 章 — Executive Summary（必须先看）

**最严重的 5 个风险**：

1. **【P0-安全】** 路径穿越风险：`group-chat-document.ts:85` 直接将 `ctx.params.roomId` 拼接到 `join(config.appHome, 'group-chat-docs', ctx.params.roomId, fileId)` ——若 roomId 含 `../`，可写到 `appHome` 之外的目录（如 `~/.ssh/...`）。需要 `isPathWithin` 校验或正则白名单。
2. **【P0-崩溃】** `useMeetingAudio.ts:147-153` `detachBeforeUnloadAudioBackup()` 用 `noop` 函数 `removeEventListener`，但注册时是真正的 `backup` —— **这个函数没有任何效果**。每次录音/卸载都泄漏一份 `beforeunload`/`pagehide` 监听器，长会议反复暂停会触发回调爆炸，最终未卸载组件持有 audioChunks 大 Blob，浏览器内存飙升。
3. **【P0-崩溃】** `useMeetingAudio.ts:584-588` 中 `ws.send({type:'stop'})` 后 `setTimeout(() => ws?.close(), 500)`，但 `ws` 在 500ms 内被 line 588 赋值为 `null` —— timeout 内 `ws?.close()` 是 no-op。WebSocket 实际上从未被显式关掉（虽然浏览器最终会回收），但如果有未 flush 的帧，会泄漏到对端。
4. **【P0-数据丢失】** `meeting.ts:218-244` `archiveOldSessions` 在 localStorage quota 爆掉时按 `updatedAt` 升序裁剪，但接着二次写入失败后，line 234 `sessions.filter(s => s.id !== oldest.id)` —— 这里 `sorted[0]` 是 `updatedAt` 最早，但已被裁剪的不一定是同一份。**结果：可能误删用户最关心的、刚刚结束的会议**。
5. **【P0-崩溃】** `meeting-asr/index.ts:240` `speech-practice-omni.ts:240` 直接 `process.env.MEETING_ASR_DATA_DIR` 绕过 `getWebUiHome()`，违反 AGENTS.md 硬规则。已经在 PR review 里发现过同类事故（meeting-storage 写到了 `cwd` 而非 `appHome`）。

**潜在连锁影响**：用户首启 → 录音 → 路径/内存问题 → 服务端 500 → 数据无法落库 → 重新刷新页面 → 上面 #4 把唯一一份录音 metadata 删除 → 用户丢完整场会议。

**必须修复后上线**：P0 全部；P1 中至少 §2.1、§2.2、§2.3、§2.6 全部、§2.7 全部。

---

## 第 1 章 — P0 致命级（必须修）

### 1.1 安全 / 路径穿越

#### P0-S1 【路径穿越】group-chat-document 上传可越权写文件
- **文件**：`packages/server/src/controllers/hermes/group-chat-document.ts:85`
- **代码**：`docsRoot = join(config.appHome, 'group-chat-docs', ctx.params.roomId, fileId)`
- **场景**：恶意用户 POST `/api/hermes/group-chat/:roomId/documents/upload`，`roomId` 含 `../../etc/cron.d`。`managedRoom(ctx)` 仅校验 room 是否存在 + 是否有权限，但 roomId 中含 `../` 时仍能通过。最终文件写到 `appHome/group-chat-docs/../../etc/cron.d/<uuid>` —— 即 `/etc/cron.d/<uuid>`。
- **修复**：`if (!isPathWithin(docsRoot, join(config.appHome, 'group-chat-docs'))) return 400`
- **优先级**：🔴 P0（上线阻塞）

#### P0-S2 【路径穿越】group-chat-workspace 也有相同风险
- **文件**：`packages/server/src/controllers/hermes/group-chat-workspace.ts:18`（同模式）
- **场景**：任何 roomId 含 `..` 的接口都可能成为入口。
- **修复**：在 `managedRoom()` 顶部加 `if (!/^[A-Za-z0-9_-]{1,64}$/.test(ctx.params.roomId))`。
- **优先级**：🔴 P0

#### P0-S3 【限流缺失】未认证的 API 完全无限流
- **文件**：`packages/server/src/middleware/login-limiter.ts`、`packages/server/src/middleware/user-auth.ts`
- **现状**：登录限流只覆盖 password / token / pairing 三类。**所有 API（包括 chat、file、meeting、upload、workflow）只要带任意 bearer token 即不计数**。一次 token 泄露可以无限调用任意接口。
- **场景**：设备部署在公网 / 用户 token 被窃 → 攻击者可刷爆 SQLite、写满磁盘（upload）、触发 venv pip install 把磁盘吃满。
- **修复**：所有 `/api/*` 路径基于 bearer token + IP 双维度做计数（如：每 token 每分钟 60 次读、5 次写）。
- **优先级**：🔴 P0（生产环境公网暴露时为高危）

### 1.2 资源泄漏 / 崩溃

#### P0-C1 【内存泄漏】meeting 录音 beforeunload 监听器从未卸载
- **文件**：`packages/client/src/composables/useMeetingAudio.ts:147-153`
- **代码**：
```js
function detachBeforeUnloadAudioBackup() {
  if (!beforeUnloadHandlerAttached) return
  beforeUnloadHandlerAttached = false
  const noop = () => {}
  window.removeEventListener('beforeunload', noop)  // ❌ 引用的是 noop，不是 backup
  window.removeEventListener('pagehide', noop)
}
```
- **场景**：每次 `stopRecording()` 都会调 `detachBeforeUnloadAudioBackup()`。但注册时是 `backup` 函数，移除时却传 `noop` —— **removeEventListener 无效**。用户在录音 → 暂停 → 录音反复切换 N 次后，每次页面卸载都会触发 N 个 `backup` 回调；回调内还尝试 `meetingStore.saveAudioData()` 写入 IndexedDB，会出现并发写入。SPA 内切换 MeetingView 也泄漏。
- **影响**：浏览器内存 + IndexedDB 写入压力；最坏情况 audioChunks 闭包永远不释放，长会议录音内存爆炸。
- **修复**：把 `backup` 提升为模块级 `let backupHandler = () => {}`，注册/移除都引用同一引用。
- **优先级**：🔴 P0

#### P0-C2 【状态错乱】MeetingView 停止录音后 ws/diarizeWs 实际未关闭
- **文件**：`packages/client/src/composables/useMeetingAudio.ts:584-595`
- **代码**：
```js
if (ws && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ type: 'stop' }))
  setTimeout(() => ws?.close(), 500)
}
ws = null  // ⚠️ 先于 timeout 触发，把 ws 引用清空
```
- **场景**：line 588 `ws = null` 在 `setTimeout` 之前。500ms 后 timeout 内 `ws?.close()` 因 `ws` 为 null 而跳过。WebSocket 句柄被 GC，但底层 socket 没显式 close，半连接状态可能拖到后端才察觉。
- **修复**：在 setTimeout 之前先 `const wsRef = ws; ws = null; setTimeout(() => wsRef?.close(), 500)`。
- **优先级**：🔴 P0（高频录制场景）

#### P0-C3 【数据丢失】quota 兜底逻辑可能误删活跃会议
- **文件**：`packages/client/src/stores/hermes/meeting.ts:218-244`
- **代码**：
```js
function archiveOldSessions(sessions: MeetingSession[]) {
  const sorted = [...sessions].sort((a, b) => a.updatedAt - b.updatedAt)
  // 裁剪到 50 句
  // 二次失败：
  const oldest = sorted[0]
  const next = sessions.filter(s => s.id !== oldest.id)
  // ❌ sorted[0] 是裁剪前的；但用户可能在裁剪过程中刚结束了一个长会议（updatedAt 现在最大）
  //   若两次操作中间有新建会议，sorted[0] 反而是旧的——但 updateSession 顺序不保证。
}
```
- **场景**：A 用户开了 3 个会议，1 个旧的（updatedAt=昨天）+ 2 个新的。quota 触发：先裁剪旧句，失败，再删 `sorted[0]`（旧的）—— 这是预期的。但如果中间 `addSentence` 把旧的 `updatedAt` 改成刚刚，则 `sorted[0]` 变成另一个，结果混乱。
- **修复**：兜底删除前明确问用户（modal "本地存储已满，是否删除最旧的会议？"）。
- **优先级**：🔴 P0

#### P0-C4 【违反硬规则】process.env 直接读 STATE_DIR
- **文件**：`packages/server/src/services/meeting-asr/index.ts:240`（沿用 MeetingASRConfig）；`packages/server/src/services/speech-practice-omni.ts:240`
- **代码**：`return process.env.MEETING_ASR_DATA_DIR || path.join(process.cwd(), 'data', 'meeting-asr')`
- **场景**：与 AGENTS.md 硬规则冲突 —— 当 `HERMES_WEBUI_STATE_DIR` 设置而 `HERMES_WEB_UI_HOME` 未设置时，应优先用 `HERMES_WEBUI_STATE_DIR`，但这里写死了 `MEETING_ASR_DATA_DIR` env。/ 已存在 meeting-storage 同类事故（v0.8.0）。
- **修复**：统一通过 `getWebUiHome()` 派生。
- **优先级**：🔴 P0

#### P0-C5 【崩溃】`meeting-asr/index.ts:382-385` auto-restart 误判
- **文件**：`packages/server/src/services/meeting-asr/index.ts:382-385`
- **代码**：`if (this._autoRestart && (code ?? 0) !== 0) { this._scheduleRestart('main process exited unexpectedly') }`
- **场景**：Python 进程 `exit code = 1` 即视为崩溃，自动重启。但 Python 主动 stop（如收到 SIGTERM 后退出码是 143 = 128+15）也会进 auto-restart 分支。同时 `stop()` 设置 `_autoRestart = false` 是同步，但 `close` 事件是异步触发 —— 在 `_autoRestart = false` 之前就 close，可能误重启。
- **修复**：把 `_autoRestart = false` 在 spawn 之前设为 false 永不回弹，或者用 stop 信号区分（如 mainProcess.signalCode === 'SIGTERM' 则不重启）。
- **优先级**：🔴 P0

### 1.3 数据一致性 / 崩溃

#### P0-D1 【崩溃】Meeting view 录音开始失败时不清理已分配资源
- **文件**：`packages/client/src/composables/useMeetingAudio.ts:540-560` catch 块
- **代码**：try 块中已经创建了 `audioContext`、`mediaStream` 等资源，catch 时仅 `isConnecting.value = false`，未释放已分配的资源。
- **场景**：第二次重试时 `new AudioContext()` 触发浏览器警告 + 麦克风权限被多份 stream 卡住；最坏情况 OOM。
- **修复**：catch 块增加 `mediaStream?.getTracks().forEach(t => t.stop()); audioContext?.close()`。
- **优先级**：🔴 P0

#### P0-D2 【崩溃】`meetingStorageApi.saveMeeting` 失败静默
- **文件**：`packages/client/src/views/hermes/MeetingView.vue:635-637`
- **代码**：`catch (err) { console.error('Failed to save meeting to server:', err) }`
- **场景**：服务端 502/网络断了，用户看到列表里还有这条会议，以为安全。**实际只在 IndexedDB / localStorage 中有，服务端没有**。如果用户清浏览器数据，本地也没了，最终什么都没保存。
- **修复**：失败时弹 toast `message.error(t('meeting.errorSaveToServer'))` + 按钮"重试"。
- **优先级**：🔴 P0

#### P0-D3 【崩溃】同步服务端会议时无限重试+无 UI
- **文件**：`packages/client/src/stores/hermes/meeting.ts:530-574` `syncSessionsFromServer`
- **代码**：失败仅 `console.error`；每次进 MeetingView 都会重试（`onMounted` → `syncSessionsFromServer`）。
- **场景**：服务端 502 时进 MeetingView 阻塞、慢、用户不知道为什么。
- **修复**：失败时设 `syncError` ref + UI 提示重试按钮。
- **优先级**：🟡 P1（用户体验）

### 1.4 服务端启动 / 关闭

#### P0-S4 【崩溃】`shutdown.ts` 直接 `Number(process.env[name])` 不校验
- **文件**：`packages/server/src/services/shutdown.ts:18`
- **代码**：`const value = Number(process.env[name])`
- **场景**：`Number(undefined) === NaN`，下游 `setTimeout(() => ..., NaN)` 立即触发，shutdown 流程可能误触发。
- **修复**：`const parsed = Number(...); if (Number.isFinite(parsed)) ...`。
- **优先级**：🟡 P1

---

## 第 2 章 — P1 高优先级

### 2.1 localStorage 未保护 JSON.parse（v0.7.7 已识别未修）

#### P1-1 【崩溃】`meeting.ts:127, 195, 248, 290` 多处裸 `JSON.parse(localStorage...)`
- **文件**：`packages/client/src/stores/hermes/meeting.ts:127, 195, 248, 290`
- **场景**：用户从老版本升级 / 手动清空 localStorage / 浏览器 quota 截断 → JSON 损坏 → store 启动崩溃 → MeetingView 整个挂掉。
- **修复**：已存在 `packages/client/src/utils/safe-storage.ts` 但只有注释未强制使用。grep 显示仍有 5 处裸调用：`ChatInput.vue:503`、`ChatPanel.vue:708`、`completion-notification.ts:144, 199, 210`。
- **优先级**：🟠 P1

#### P1-2 【崩溃】`HistoryView.vue:152` 直接 `JSON.parse(value)` 无 try
- **文件**：`packages/client/src/views/hermes/HistoryView.vue:152`
- **修复**：wrap try/catch + safe-storage。
- **优先级**：🟠 P1

#### P1-3 【崩溃】`McpManagerView.vue:91, 99, 120` JSON.parse
- **场景**：用户改坏 MCP server JSON，整个 MCP 页面崩溃。
- **修复**：失败回退到上一次成功状态 + 提示"JSON 损坏"。
- **优先级**：🟠 P1

### 2.2 异步失败静默吞掉

#### P1-4 【UX 沉默】MeetingView 13 处 `console.error` 无 UI 反馈
- **文件**：`packages/client/src/views/hermes/MeetingView.vue:524, 561, 580, 636, 659, 730, 747, 896, 1012, 1028, 1040`
- **场景**：录音失败、音频保存失败、ASR 健康检查失败、说话人分离错误等所有异常都只 console。用户看不到任何错误指示器。
- **修复**：抽公共 helper `function reportError(msg: string) { message.error(t(msg)) }`。
- **优先级**：🟠 P1

#### P1-5 【UX 沉默】ChatView / GroupChatView 同类
- **文件**：`packages/client/src/views/hermes/ChatView.vue`、`GroupChatView.vue`
- **现状**：grep 显示 .catch 块 8 处但很多是 `console.error`。
- **优先级**：🟡 P2

### 2.3 i18n 严重不平衡（用户可见）

#### P1-6 【UX 裸露】7 个 locale 比 zh 少 25% 翻译
- **文件**：`packages/client/src/i18n/locales/{ar,de,es,fr,ja,ko,pt}.ts`
- **现状**：
  - zh.ts: 4761 行
  - en.ts: 4717 行（应作为英文基准）
  - zh-TW.ts: 4458 行（少 300 行）
  - ar/de/es/fr/ja/ko/pt/ru: 3486-3595 行（**少 ~1100 行**）
- **场景**：海外用户切换到日/韩/阿拉伯语后，~~25% 文案直接显示成英文 key 或中文 fallback（vue-i18n 默认 fallbackLocale='zh'）。
- **修复**：CI 阶段校验 `Object.keys(zh.ts.messages)` ⊇ `Object.keys(otherLocale.messages)`，缺失的 key 必须 fallback 到 en。
- **优先级**：🟠 P1（海外用户上线阻塞）

#### P1-7 【UX 裸露】zh-TW 比 zh 少 300 行（简体 / 繁体不一致）
- **场景**：繁体用户的体验差。已确认 desktopBrowser 整段 zh/zh-TW 翻译不一致（"刷新" vs "重新整理"）。
- **优先级**：🟠 P1

### 2.4 会议 / ASR 风险

#### P1-8 【崩溃】Recording-stop 时未等待音频数据 IndexedDB 写入完成
- **文件**：`packages/client/src/composables/useMeetingAudio.ts:632-636`
- **代码**：
```js
try {
  await meetingStore.saveAudioData(meetingId, audioBlob.value)
} catch (err) {
  console.error('Failed to save audio to IndexedDB:', err)
}
```
- **场景**：`stopRecording` 函数签名 `async` 但调用方多数不 await —— audioChunks 已 line 639 `audioChunks.value = []`。如果在 IndexedDB 写完前页面被关闭（如手机休眠）音频数据丢失。
- **修复**：把整个 saveCurrentMeeting → uploadAudio → saveAudioData 链路包成 Promise，确保 stopRecording 完全 await。
- **优先级**：🟠 P1

#### P1-9 【崩溃】ASR 配置变更未通知用户就静默重启
- **文件**：`packages/server/src/services/meeting-asr/index.ts:225-244`
- **场景**：用户改 OSS key → 后台自动 stop+start（~~30 秒））。期间录音会断，但用户没看到任何"配置已生效、录音暂停"的提示。
- **修复**：SSE/event-bus 给 UI 推 `restart` 状态，前端展示"配置已变更、ASR 服务重启中..."。
- **优先级**：🟡 P2

#### P1-10 【崩溃】HTTP body limit 过高
- **文件**：`packages/server/src/middleware/request-body-parser.ts:12-14`
- **代码**：`jsonLimit: '20mb', formLimit: '20mb'`
- **场景**：恶意大请求把内存吃满（20MB × N 并发）。AGENTS.md 没强制但 20MB 太高。
- **修复**：限制为 2MB（普通 JSON），upload 走 multipart 限流。
- **优先级**：🟠 P1

### 2.5 GroupChat / Discussion

#### P1-11 【崩溃】discussion 轮次控制简化后仍可能死锁
- **文件**：`packages/server/src/services/hermes/group-chat/discussion.ts`（参考 DEVLOG.md 修复点）
- **场景**：DEVLOG 显示已移除 `DISCUSSION_MAX_EXTEND_ROUNDS` 机制（2026-08-17 修复）。但如果 maxRounds=8 设置但所有 agent 都判定 `converged: true` 在第 3 轮，是否会提前结束？还是必须跑满 8 轮？需确认测试。
- **修复**：补 vitest case `test('discussion stops at converged even before maxRounds')`。
- **优先级**：🟡 P2

#### P1-12 【崩溃】group-chat-agent-link token 验证宽松
- **文件**：`packages/server/src/controllers/hermes/group-chat-agent-link.ts:686+`
- **场景**：agent link 是个匿名凭证机制，但 token 验证逻辑需要确认是否被复用、过期控制。
- **修复**：审计 link token 生命周期（生成→消费→过期清理）。
- **优先级**：🟡 P2

### 2.6 USB 设备集成（横切风险）

#### P1-13 【崩溃】USB 跨平台：Windows 路径无 chown
- **文件**：`packages/server/src/services/usb/*`
- **场景**：AGENTS.md 已强制 `chown_r_mount_safe`，但仍有地方直接 `chown -R`。
- **修复**：grep `chown -R` 替换为 `chown_r_mount_safe`。
- **优先级**：🔴 P0（如未修）

#### P1-14 【崩溃】USB mount/unmount 失败无回滚
- **场景**：mount 成功但 unmount 时被占用 → 文件句柄泄漏。
- **修复**：mount 失败 unref 立刻执行。

### 2.7 WebSocket / Socket.IO 生命周期

#### P1-15 【崩溃】Meeting ASR WS 重连风暴
- **文件**：`packages/client/src/composables/useMeetingAudio.ts:189-250`
- **场景**：`MAX_RECONNECT_ATTEMPTS=3`，3 次后 `stopRecording()`。但如果 ASR 服务自身在重启（30 秒+），用户 3 次重试失败后会议被强行停止。重新录要重开会话。
- **修复**：重连时同时探测 ASR 服务状态；服务不可用不立即 stopRecording，而是等待并降级提示。
- **优先级**：🟠 P1

#### P1-16 【内存泄漏】Socket.IO `removeAllListeners` 缺失
- **文件**：多处 `socket.io` 集成，扫描 group-chat / coding-agents / chat
- **场景**：客户端多次连接不同 session 时旧 socket 没显式 disconnect。
- **修复**：在 `onUnmounted` 中检查并 disconnect。
- **优先级**：🟡 P2

### 2.8 凭证 / Token

#### P1-17 【UX】Token 重置无自检路径
- **文件**：`packages/server/src/services/auth.ts:17-36`
- **场景**：用户清 localStorage 后 token 丢失，登录页要重新获取。Web UI 默认登录页提供 default credential hint 但设备上 token 不会自动签发。
- **修复**：登录失败时引导去 server 的 `/api/auth/token` 获取（需 super_admin）。
- **优先级**：🟡 P2

#### P1-18 【限流】登录限流基于 IP 不基于 token
- **文件**：`packages/server/src/services/login-limiter.ts`
- **场景**：NAT 后多设备共享 IP，一台被攻击 → 其他用户被锁 1 小时。
- **修复**：增加 token-based 限流（错误 token 值 hash 计数）。
- **优先级**：🟠 P1

---

## 第 3 章 — P2 UX / 体验

### 3.1 客户端 UI 摩擦

#### P2-1 【UI】MeetingView 错误全部 console.error 无 toast
- 14 处错误全部 `console.error`，仅 2 处 `message.error`（line 731、748）。
- **修复**：抽 `reportError()` 公共 helper。

#### P2-2 【UI】录音中切页面会无声丢失实时辅助
- **场景**：录音时切到 SettingsView，回来后 `isRecording.value` 状态依赖 composable 重建，可能重复触发 start。
- **修复**：把 `useMeetingAudio` 抽到全局 store 或 keep-alive 容器。

#### P2-3 【UI】expert detail 邀请码 `Math.random()`
- **文件**：`packages/client/src/views/hermes/ExpertDetailView.vue:125`
- **场景**：邀请码用 `Math.random()` —— 客户端随机数可预测，安全场景不能依赖。
- **修复**：改用 `crypto.getRandomValues()`。

#### P2-4 【UI】chat-core ID 生成也 `Math.random()`
- **文件**：`packages/client/src/stores/hermes/chat-core.ts:489` 等 ~20 处
- **场景**：sessionId / messageId 用 `Math.random()` —— 不可预测，但碰撞概率也低；但前端"专家对话"等场景被序列化传到服务端，仍应使用 `crypto.randomUUID`。
- **修复**：抽 `generateId()` 公共 helper，统一用 `crypto.randomUUID()`。

#### P2-5 【UI】录音时按 back / 浏览器返回，未触发 stopRecording
- **场景**：popstate 事件未拦截。会议状态未保存。
- **修复**：在 MeetingView 里 `addEventListener('popstate', () => stopRecording())`。

### 3.2 服务端 404 / 错误处理不一致

#### P2-6 【API 错误格式】部分路由用 `{ error: '...' }`，部分用 `{ error, code }`
- **场景**：客户端 axios wrapper 不统一；某些错误前端能拿到 code，某些只有 message。
- **修复**：约定 `{ error, code }` 必须同时返回。

### 3.3 数据库一致性

#### P2-7 【DB】会话删除无外键级联
- **文件**：`packages/server/src/db/hermes/session-store.ts`
- **场景**：删除 session 后 `gc_messages.session_id` 外键约束是什么？需审计 schema。
- **修复**：审计 `schemas.ts` FK 设置。

### 3.4 性能

#### P2-8 【性能】meeting localStorage sessions 全量写入
- **场景**：每加一句就 `saveSessions()` 整个数组。100 句会议反复更新 = 每次 100 句的 JSON.stringify + 写 5MB。
- **修复**：debounce 1 秒批量写。

#### P2-9 【性能】ChatView 列表渲染无虚拟滚动
- **场景**：长 session 渲染 1000+ 消息卡顿。
- **修复**：vue-virtual-scroller 或 Naive UI 的 n-virtual-list。

---

## 第 4 章 — P3 锦上添花

### 4.1 文档与测试

#### P3-1 【文档】`docs/erro.txt` 错误日志未公开处理
- **现状**：57KB 设备错误日志沉淀，未总结。
- **修复**：写 `docs/operations/known-issues.md` 总结 TOP 10。

#### P3-2 【测试】`tests/release/device-package-executable-bits.test.ts` 覆盖不足
- 已知 AGENTS.md 强制 `+x` 校验。

#### P3-3 【测试】e2e 没有"录音失败 → 数据落库"用例
- 仅端到端 happy path，异常路径未覆盖。

### 4.2 配置

#### P3-4 【配置】`config.yaml` 默认值散落
- **现状**：HERMES_* 环境变量 30+，缺少 .env.example。
- **优先级**：🟢 P3

---

## 第 5 章 — 横切关注（Cross-Cutting Concerns）

### 5.1 错误处理标准缺失

| 层级 | 现状 | 标准 |
|------|------|------|
| 前端 `.catch()` | 8 处，无统一反馈 | 必须 `message.error(t(...))` 或保留 error state |
| Python `except Exception: pass` | 55 处（meeting-asr-safety-audit 已知） | 至少 `log.debug/warning(...)` |
| Koa `ctx.throw` | 部分用 `Object.assign(new Error, {status, code})` | 必须 `status + expose: true + code` |

### 5.2 安全态势

| 项 | 现状 | 风险 |
|-----|------|------|
| CSRF | 无 token /  | state-changing endpoint 需 CSRF token 或 SameSite=strict cookie |
| CORS | 允许 self + CORS_ORIGINS | OK |
| CSP | `script-src 'unsafe-inline'` | R-1 已知，长期收紧 |
| Session | 30d JWT | 不强制 refresh |
| File upload | 100MB GroupDoc / 20MB JSON body | DoS 风险 |

### 5.3 离线 / 弱网

| 场景 | 现状 |
|------|------|
| 录音中网络断开 | IndexedDB 兜底（OK） |
| 提交报告时网络断 | 失败仅 console.error，需重试 |
| 切换 profile 时网络断 | localStorage 数据保留，但服务端不同步 |

### 5.4 设备兼容性

| 平台 | 已知风险 |
|------|---------|
| ARM Linux | pip install 在无网环境失败 |
| Windows | chown 无效；git filemode |
| macOS | 设备密码 SSH |

---

## 第 6 章 — 推荐上线前 Checklist

### 必须做（P0 全部）
- [ ] P0-S1、S2 路径穿越：grep `ctx.params` + `join` 加 isPathWithin
- [ ] P0-C1、C2 资源泄漏：meeting audio composable 改造
- [ ] P0-C3 数据丢失：localStorage quota 兜底改用户确认
- [ ] P0-C4 硬规则：所有 MEETING_ASR_DATA_DIR 改用 getWebUiHome
- [ ] P0-C5 auto-restart 区分 stop 信号
- [ ] P0-D1 录音失败资源回收
- [ ] P0-D2、D3 保存失败 UI 反馈

### 上线前 1 周必做（P1）
- [ ] P1-1～3 localStorage 安全
- [ ] P1-4、5 console.error 改 message.error
- [ ] P1-6、7 i18n 平衡（至少保证 zh-TW 与 zh 等价，ar/ja/ko/en 互译）
- [ ] P1-10 body limit 缩到 2MB
- [ ] P1-13、14 USB 跨平台
- [ ] P1-15 ASR WS 重连降级
- [ ] P1-18 token 限流

### 上线前 1 天必做（核心路径冒烟）
- [ ] 录音 → 停止 → 关闭页面 → 重开，会议数据保留
- [ ] Meeting ASR 服务崩溃 → 自动恢复
- [ ] 群聊讨论跑到 maxRounds 不提前结束
- [ ] 用户密码登录失败 → 锁定 1 小时后正常登录
- [ ] USB mount 失败有 fallback
- [ ] i18n 切换无 key 缺失

---

## 第 7 章 — 调研方法说明

### 7.1 读了什么
- `AGENTS.md`、`ARCHITECTURE.md`、`DEVELOPMENT.md`、`DEVLOG.md`
- `docs/harness/meeting-asr-safety-audit.md`（v0.7.7 复盘）
- `packages/server/src/{security,config,auth,login-limiter}.ts`
- `packages/server/src/routes/index.ts`
- `packages/server/src/services/{meeting-asr,hermes/group-chat,hermes/run-chat,...}/*`
- `packages/server/src/controllers/hermes/{meeting-asr,group-chat-document,files,...}.ts`
- `packages/server/src/middleware/{request-body-parser,user-auth}.ts`
- `packages/client/src/views/hermes/MeetingView.vue`（2907 行全部扫）
- `packages/client/src/composables/useMeetingAudio.ts`、`useMeetingAgent.ts`、`useDefaultWorkspace.ts`
- `packages/client/src/stores/hermes/{meeting,chat-core,group-chat}.ts`
- `packages/client/src/utils/safe-storage.ts`、`client-random.ts`、`completion-notification.ts`
- 全部 11 个 locale 文件大小比对
- `docs/erro.txt`、`docs/shebeifankui.md` 摘要
- `packages/server/src/index.ts` 关键段（body parser、shutdown、bootstrap）

### 7.2 未能深入
- Python 后端详细审计（会议 ASR 服务的 `_process_chunk_async`、`audio_buffer` 锁等），meeting-asr-safety-audit.md 已覆盖部分
- 全部 50+ 测试用例的最新覆盖率
- Electron 桌面打包路径
- 设备上 systemd 单元文件
- 网站（packages/website）内容

### 7.3 调研局限
- 未运行项目，仅静态阅读代码
- 部分高风险点（race condition / 内存泄漏）需要压测才能确认实际触发频率
- 性能瓶颈未做 profile

---

## 附录 A — 关键文件清单

| 文件 | 关注点 |
|------|--------|
| `packages/server/src/services/meeting-asr/index.ts` | Python 子进程生命周期、CSP、TLS |
| `packages/server/src/controllers/hermes/group-chat-document.ts` | 路径穿越风险 |
| `packages/server/src/services/login-limiter.ts` | 限流策略 |
| `packages/server/src/middleware/request-body-parser.ts` | body 限制 |
| `packages/client/src/composables/useMeetingAudio.ts` | 录音生命周期 |
| `packages/client/src/composables/useMeetingAgent.ts` | Agent 编排 |
| `packages/client/src/views/hermes/MeetingView.vue` | 主页面 UX |
| `packages/client/src/stores/hermes/meeting.ts` | 会议数据持久化 |
| `packages/client/src/utils/safe-storage.ts` | 已有但未强制使用 |
| `packages/client/src/i18n/locales/*.ts` | i18n 平衡 |

---

**报告完结**。建议上线路前至少闭环 P0 全部 + P1 中 §2.1、§2.2、§2.3、§2.6、§2.7、§2.8 的项，否则正式上线后设备大规模出问题需要紧急回滚。