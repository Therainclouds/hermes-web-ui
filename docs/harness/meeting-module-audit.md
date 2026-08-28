# 会议模块拆分审计报告

> 范围：会议子域（含 ASR、报告生成、演讲评估、音频采集/播放）的代码体量与职责分布。
> 触发问题：`MeetingView.vue` 3800+ 行是否仍然合理？两个 panel 各自近 1000 行是否健康？server 端 `realtime-assist.ts` 是否是诊断噩梦的根因？
> 版本：v1.0（2026-08-28）
> 受影响组件：Client view / Client components / Client composables / Server services / Python backend

---

## 第 1 章 — 体量基线

### 1.1 模块总规模

| 维度 | 行数 | 文件数 | 备注 |
|------|------|--------|------|
| Client view（MeetingView） | 3842 | 1 | script 1914 / template 804 / style 1122 |
| Client components | 7077 | 14 | 含 `business/` 子目录 4 文件 436 行 |
| Client composables | 1698 | 4 | `useMeetingAgent` 1294 行（最重） |
| Client stores | 592 | 1 | `stores/hermes/meeting.ts` |
| Client utils | 391 | 3 | `meeting-asr-api` / `meeting-storage-api` / `audio-db` |
| **Client 小计** | **~13 600** | **24** | |
| Server meeting-asr | 2285 | 4 | `index.ts` 1066 + `realtime-assist.ts` 762 + 2 小文件 |
| Server controllers | 554 | 2 | `meeting-asr.ts` 395 + `meeting-storage.ts` 159 |
| Python backend | 2833 | 11 | `diarize_endpoint.py` 750 / `main.py` 441 / `html_generator.py` 351 等 |
| **Server + Python 小计** | **~5 700** | **17** | |
| **会议模块合计** | **~19 300** | **~40** | 占 Hermes Web UI 总代码量约 5–6% |

### 1.2 View 体量基线（同 `views/hermes/`）

| View | 行数 | 说明 |
|------|------|------|
| WorkflowView | 5286 | 低代码画布，体量由 canvas 复杂度决定 |
| **MeetingView** | **3842** | 普通 UI 视图，**没有画布级复杂度**，却是同类平均（1180）的 **3.3×** |
| JourneyView | 1499 | — |
| HistoryView | 1365 | — |
| CodingAgentsView | 1250 | — |
| TerminalView | 1103 | — |
| SharedGroupChatView | 907 | — |
| McpManagerView | 905 | — |
| GroupChatLinkView | 900 | — |
| KanbanView | 741 | — |

### 1.3 大型组件体量基线（同 `components/hermes/`）

| 组件 | 行数 | 备注 |
|------|------|------|
| GroupChatPanel | 6388 | 群聊核心（合理） |
| ChatPanel | 4506 | 单聊核心（合理） |
| RealtimeVoiceStage | 1905 | — |
| KanbanTaskDrawer | 1137 | — |
| **SpeechEvaluationPanel** | **1065** | 演讲评估面板 |
| CombinationModelsPanel | 916 | 模型管理 |
| **MeetingAgentPanel** | **865** | 报告生成面板 |

两个 panel 接近 1000 行，偏离一般"面板组件"300–500 行的健康区。

---

## 第 2 章 — 失衡点诊断

### 2.1 🔴 P0 — `server/services/meeting-asr/realtime-assist.ts`（762 行 / 单 class）

**这是会议模块风险最高的文件**。前面 A+C bug（`Provider returned an empty stream with no finish_reason`）排查经验已指出："全在一处"导致诊断慢。

**内联职责块**：

| 方法/区块 | 行 | 职责 |
|----------|----|------|
| Socket.IO 房间绑定 | 132–156 | `init(io)` / room subscription |
| 会话生命周期 | 156–235 | `startSession` / `updateSpeechContext` / `flushNow` / `stopSession` / `pushSentence` |
| 触发判定 | 274–282 | `needsToolLookup(sceneTemplateId, transcriptText)` |
| Standalone Agent 调用 | 274–394 | `runAgentAnalysis` + fetch + chunk + SSE 解析 + fallback |
| 报告生成主路径 | 395–478 | `parseAnalysis` + 帧识别 + yield 累加 |
| Direct LLM 调用 + fallback | 480–735 | 大块流式 SSE + 错误分类 + 多级 fallback |
| Helpers | 87–130 | `safeActiveProfileName`, `looksLikeStandaloneAgentFailure` |
| 全局导出 | 762 | 单例 |

**症状**：

- 同一文件里混杂 Agent 调用、Direct LLM 调用、报告解析、Socket 绑定 4 类职责
- 单测无法直接打到 LLM/Agent 两条路径，必须 mock 整个 socket
- 任何一类职责的 bug 修复都要重建整个对象图

### 2.2 🔴 P0 — `client/views/hermes/MeetingView.vue`（3842 行 / 56 函数 / 224 const）

| 职责块 | script 行 | 函数 | ref/computed | 备注 |
|--------|----------|------|--------------|------|
| 会议创建对话框 | 47–94 | `handleCreateMeeting`, `openCreateModal` | ~12 | 8 个 `newMeeting*` ref 已成独立块 |
| ASR 配置向导（DashScope/LLM/OSS） | 73–148 | — | ~15（asr/llm/oss keys + options） | 纯表单 + 静态数据，与 view 主体无关 |
| WebSocket 客户端（/ws/asr, /ws/diarize） | 143–245 | `handleWsMessage` | 6 | ASR/diarize 双 WS 状态机，**与 store 重复** |
| 音频录制（mic / AudioContext / AnalyserNode） | 165–197, 432–517 | `checkMicrophoneAvailability`, `startRecording`, `stopRecording`, `attachBeforeUnloadAudioBackup`, `detachBeforeUnloadAudioBackup` | 13 ref | 录制全生命周期 |
| 音频播放（HTMLAudioElement / seek / drag） | 1408–1542 | `playAudio`, `pauseAudio`, `togglePlayPause`, `stopAudio`, `seekTo`, `seekToSentence`, `seekToPosition`, `startProgressDrag`, `onProgressDrag`, `stopProgressDrag`, `highlightCurrentSentence` | 7 ref | 11 个函数、播放全生命周期 |
| 下载（audio / transcript / json） | 1543–1700 | `downloadAudio`, `downloadTranscript`, `downloadJson` | 0 | 纯客户端导出 |
| 右栏拖拽宽度 | 246–300 | `loadRightPanelWidth`, `startRightPanelResize`, `onRightPanelResize`, `stopRightPanelResize` | 5 ref | 可复用为通用 composable |
| 会话 CRUD | 30–45, 96–130, 935–1010 | `selectMeetingById`, `loadMeeting`, `loadAudioForSession`, `deleteMeeting`, `resetMeetingState`, `saveCurrentMeeting`, `onTranscriptRename` | 4 ref | 部分被 store 覆盖，view 里**仍有重复状态机** |
| 报告生成触发 | 220–245 | `onReportGenerated`, `onRequestReport` | 4 ref | view 只负责事件转发 |
| 会议摘要/分析配置 | 199–218 | — | 6 ref | 已部分下沉，但仍有**重复 ref** |

**症状**：

- 3800 行里有大量应早已抽出但没抽出去的内联块
- 模板/脚本/样式三段比例 ≈ 1 : 2.4 : 1.4，script 占比异常高
- 早期"拆 `WaveformCanvas`"样品工作已展示拆分模式，但中途停滞

### 2.3 🟡 P1 — `client/components/hermes/meeting/SpeechEvaluationPanel.vue`（1065 行 / 99 script-level item）

| 职责块 | 行 | 函数 | ref/function |
|--------|----|------|--------------|
| 演讲计时器 | 64–172 | `fmtSec`, `resetTimer`, `toggleTimer`, `nextLabel`, `recordSegment`, `removeRecord`, `openSettings`, `saveSettings` | 13 ref + 8 函数 |
| 填充词（Filler）统计 | 250–281 | `incrementFiller`, `removeFiller` | 3 computed + 2 函数 |
| AI 评语解析（good phrases / grammar） | 283–310 | `analyzeNow`, `buildSpeechContext` | 4 computed |
| 录音同步 + 自动分析触发 | 207–248 | 2 个 `watch props.isRecording` | 0 |
| 导出按钮 | 463–474 | — | ✅ 已抽到 `MeetingExportDropdown`（v0.7.x） |

### 2.4 🟡 P1 — `client/components/hermes/meeting/MeetingAgentPanel.vue`（865 行）

| 职责块 | 行 | 函数/ref |
|--------|----|----------|
| 报告生成 SSE 流 | 172–290 | `generateReport`（~120 行 SSE 解析 + 错误分类 + retry） |
| 圆环滚动 + 自动滚动 | 100–145 | `scrollToBottom`, `watch rounds` |
| 轮次渲染模板 | 290–600 | 大量 v-for + MarkdownRenderer |
| 导出按钮 + 错误态 | 280–320 | ✅ 已抽到 `MeetingExportDropdown`（v0.7.x） |
| 挂载/卸载清理 | 86–110 | `onMounted` 拉 session（重复 `meetingStore.sessions.find`） |

### 2.5 🟡 P1 — `server/services/meeting-asr/index.ts`（1066 行 / `MeetingASRService` 单 class）

| 方法 | 行 | 职责 |
|------|----|------|
| 单例 / 路径解析 | 104–225 | `getInstance` / `getPythonBackendPath` / `_uvicornTlsArgs` / `getDataDir` / `resolveVenvPath` |
| DashScope key 持久化 | 227–282 | `readStoredDashScopeKey` + .env 解析 |
| venv 创建 + pip install | 284–463 | `getVenvPythonPath` + `runCaptured` + subprocess 编排 |
| 进程 spawn / 端口 / 重启 | 465–780 | `_startHealthMonitor` / `_stopHealthMonitor` / `_scheduleRestart` / `_spawnBackend` |
| 配置热更新 | 1014–1057 | `updateConfig` + restart |
| 端口查询 | 1057–1066 | `getASRPort` / `getDiarizePort` |

### 2.6 🟢 P2 — Python backend

| 文件 | 行 | 风险 |
|------|----|------|
| `diarize_endpoint.py` | 750 | 🟡 P1：speaker-diarization endpoint 偏重，可拆 router + service 两层 |
| `main.py` | 441 | 🟢 P2 |
| `html_generator.py` | 351 | 🟢 P2 |
| `storage.py` | 277 | 🟢 P2 |
| `diarize_proxy.py` | 225 | 🟢 P2 |
| `llm_service.py` | 216 | 🟡 P1：与 TS 端 `realtime-assist.ts` 的 Direct LLM 路径重复实现 |

> `diarize_endpoint.py` 的内联职责待 server 拆完后**同步审视**——v0.7.7 speaker-diarization incident 硬规则参见 [`meeting-asr-safety-audit.md`](./meeting-asr-safety-audit.md)。

---

## 第 3 章 — 拆分优先级

### 3.1 推荐实施顺序

| # | 任务 | 体量 | 价值 | 风险 | 估时 |
|---|------|------|------|------|------|
| 1 | **拆 server `realtime-assist.ts`**（A+C bug 根因文件） | 762 → ~250 | 🔴 极高：LLM/Agent 路径可独立单测 | 中 | 0.5–1 天 |
| 2 | **拆 `MeetingView` 的音频录制/播放** | ~400 行 | 🟡 高：view 从 3800 → 2700 | 中 | 0.5 天 |
| 3 | **拆 ASR 配置向导** | ~150 行 | 🟡 高：独立对话框可独立维护 | 低 | 0.3 天 |
| 4 | **拆 server `meeting-asr/index.ts` 的 venv/dashscope 子职责** | ~250 行 | 🟡 中：清晰边界 | 中 | 0.5 天 |
| 5 | **拆 `MeetingAgentPanel` 的 SSE 流** | ~150 行 | 🟡 中：报告生成流可独立单测 | 低 | 0.3 天 |
| 6 | **拆 `SpeechEvaluationPanel` 的计时器** | ~150 行 | 🟡 中：可单测 | 中 | 0.5 天 |
| 7 | **拆 `diarize_endpoint.py` router/service** | 750 → ~400 | 🟡 中：与 #1 同步审视 safety audit | 低 | 0.5 天 |

**总投入**：约 3–4 天，可分 3–4 个 PR，每个 PR 一个独立模块边界。

### 3.2 预期收益

- `MeetingView` 3800 → 2700 行（**-30%**），定位新功能时 grep 范围大幅缩小
- `realtime-assist.ts` 762 → 250 行（**-67%**），下一次 A+C 类 bug 排查时间从 1–2 小时降到 20 分钟
- `MeetingAgentPanel` / `SpeechEvaluationPanel` 各自降到 500–600 行，符合面板组件健康区
- 新增独立可单测 composable：`useMeetingAudio` / `useReportStream` / `useSpeechTimer` / `useDraggableWidth`
- Server 端 `realtime-assist.ts` 拆分后，Agent 路径 / Direct LLM 路径 / 报告解析 / Socket 绑定四类职责可被独立 patch

### 3.3 拆分后目标文件树（建议）

```
server/src/services/meeting-asr/
├── index.ts                   # 进程 spawn / 端口 / 健康监控（重构后 ~400 行）
├── realtime-assist.ts         # Socket 房间绑定 + 会话生命周期（重构后 ~250 行）
├── agent-bridge.ts            # NEW: Standalone Agent 调用（~120 行）
├── direct-llm.ts              # NEW: Direct LLM 流式调用（~180 行）
├── report-parser.ts           # NEW: 报告帧识别 + parseAnalysis（~80 行）
├── venv-manager.ts            # NEW: venv 创建 + pip install（~200 行）
├── dashscope-key-store.ts     # NEW: DashScope key 持久化（~60 行）
├── skill-resolver.ts          # 保持不变
└── scene-templates.ts         # 保持不变

client/src/composables/
├── useMeetingAgent.ts         # 保持（refactor 后可能瘦身）
├── useMeetingAnalysis.ts      # 保持
├── useMeetingAssist.ts        # 保持
├── useMeetingReportExport.ts  # 保持（v0.7.x 已新增）
├── useMeetingAudio.ts         # NEW: 录制 + 播放（~200 行）
├── useMeetingAsrSocket.ts     # NEW: 双 WS 状态机（~120 行）
├── useReportStream.ts         # NEW: SSE 流 + retry（~120 行）
├── useSpeechTimer.ts          # NEW: 演讲计时器（~120 行）
├── useSpeechFillerCounter.ts  # NEW: 填充词统计（~80 行）
└── useDraggableWidth.ts       # NEW: 通用拖拽宽度（~50 行）

client/src/components/hermes/meeting/
├── AsrConfigWizardDialog.vue  # NEW: ASR 配置向导（~150 行）
├── MeetingView.vue            # 重构后 ~2700 行
├── ... (其余 13 个组件保持)
```

---

## 第 4 章 — 硬规则与红线

本审计对应的拆分工作必须遵守：

- **AGENTS.md** 第 1 条：Keep routes thin — 拆完后的 view 不应承担 service 职责
- **AGENTS.md** 第 8 条：Don't mix unrelated refactors into a bug fix — 每个 PR 只拆一个模块边界，不夹带 bug fix
- **AGENTS.md** 第 11 条：Building/CSP/Storage/Process 红线 — `realtime-assist.ts` 涉及 ASR + LLM 子进程，修改前必须重新阅读 `meeting-asr-safety-audit.md`
- **`meeting-asr-safety-audit.md`**：v0.7.7 speaker-diarization incident 复盘得出的硬规则（不破坏 CSP / 不污染 venv / 不混合 update orchestration）

---

## 第 5 章 — 不在本次审计范围内（明确告知）

- 不动 `MeetingExportDropdown` / `meeting-report-docx` / `useMeetingReportExport`（v0.7.x 已落地 ✓）
- 不动 `WorkflowView` 5286 行（画布复杂度高，单独工作）
- 不动 `ChatPanel.vue` 4506 行（chat 体量大但有专门会话）
- 不动 Python backend 的 LLM / Storage 等小文件
- 不在 PR 中"顺手"清理无关问题
- 不改 prompt 模板
- 不动 Hermes Agent 升级链路

---

## 附录 A — 调研方法

- `wc -l` 测量所有 client/server/python 文件
- `grep -nE "^(const|function|async function) "` 计数 script-level 项
- `awk '/<script/,/<\/script>/'` 提取 script 段统计
- `find packages -path "*meeting*"` 列举所有相关文件
- 对比基线：`views/hermes/*.vue`、`components/hermes/*.vue` 同类平均

## 附录 B — 后续追踪清单

实施 #1 时建议同步记录（v0.8 模块化已实施，状态见 [`meeting-modularization-spec.md`](./meeting-modularization-spec.md) 附录）：

- [x] `realtime-assist.ts` 拆出 `agent-bridge.ts` / `direct-llm.ts` / `report-parser.ts`（PR-1，762→283）
- [x] 新增单测：`tests/server/agent-bridge.test.ts`、`tests/server/direct-llm.test.ts`、`tests/server/report-parser.test.ts`
- [x] `meeting-asr-safety-audit.md` 红线对照检查表（拆完后再走一遍）——子进程 env 注入、CSP、venv 创建序列均未触碰
- [x] `MeetingView.vue` 拆出 `useMeetingAudio` / `useDraggableWidth` / `AsrConfigWizardDialog`（另加 `useDiarizeMerge` / `useMeetingDownloads`，3842→2690）
- [x] `SpeechEvaluationPanel` 拆出 `useSpeechTimer` / `useSpeechFillerCounter`（1065→946）
- [x] `MeetingAgentPanel` 拆出 `useReportStream`（865→755）
- [x] `meeting-asr/index.ts` 拆出 `venv-manager` / `dashscope-key-store`（1066→781）
- [x] `diarize_endpoint.py` router/service 分层（750→282 + diarize_service.py 504）