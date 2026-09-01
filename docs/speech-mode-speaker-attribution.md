# 演讲模式 Speaker 归属链路重构 · 工作记录

> 2026-09-01 会话产出。从"发言人数量 0、AI 编造'张三'"的断裂状态，重构为
> "姓名 → 转写 → AI 点评 → 按人记分牌 → 分人导出"的完整闭环。
> 本文兼作设计文档与工作记录，供后续维护者理解数据流与边界。

## 一、问题与根因

原始症状（v0.7.21 时点）：

| 现象 | 实际 | 期望 |
|---|---|---|
| KPI 发言人数量 | 0 | ≥ 1 |
| 发言人用时 | 空 | 显示"某姓名 02:05" |
| AI 点评 speaker | LLM 编造的"张三/未知/发言人" | 真实姓名 |
| 多演讲者点评 | 全部混在一起 | 按人区分 |

三个断裂点：

1. **ASR 不带说话人**——DashScope paraformer 只返回文字+时间戳，`sentence.speaker` 永远 undefined（服务/硬件限制，非 bug）。
2. **speakerTimeline 从未被发送**——服务端 `report-parser.ts` 的 `annotateTranscriptSpeakers` / `resolveTimelineSpeaker` 完整实现，但客户端 `buildSpeechContext()` 从不构造 `speakerTimeline` 字段，整条 fallback 通道空转。
3. **两条 speaker 数据路径互不连通**——AI 分析路径（LLM 输出，编造假名）与句子路径（`session.sentences`，全空）各说各话。

**用户输入的姓名只存在于计时器的 `timerLabel` 里**，从未反向注入句子或 AI 上下文。

## 二、当前数据流（重构后）

```
SpeechTimerOverlay 输入框 (timerLabel："姓名" 或 "环节 / 姓名")
      │
      ▼
utils/speech-segments.ts ── buildSpeakerTimeline(records, {timerLabel, timerRunning})
      │                      把已记录环节 + 当前标签展开为 speakerTimeline
      │                      （走表中未记录时当前标签生效为 open 段 [now, +∞)）
      ├──→ MeetingView.vue ASR final ── resolveActiveSegmentSpeaker() 反查
      │        写入 sentence.speaker → store → pushSentenceToAssist（LLM 看到 [姓名]）
      ├──→ SpeechEvaluationPanel.buildSpeechContext() ── speakerTimeline 推服务端
      │        服务端 annotateTranscriptSpeakers 按时间戳归属 + resolveDominantSpeaker
      │        给每轮 AnalysisRound 打上 speaker 标记（确定性推导，非 LLM 输出）
      └──→ useSpeechAiAggregation ── speakerScores / speakerSections / speakerDurations
               句子缺 speaker 时同套反查兜底
```

服务端 prompt 契约（`direct-llm.ts`）：有时间线时强制 LLM 用时间线姓名；**无时间线时
明确禁止编造姓名**（speaker 留空），从源头杜绝"张三"。

## 三、关键设计决策（已与产品确认）

| 决策点 | 结论 |
|---|---|
| 走表未记录盲区归属 | 当前 `timerLabel` 即时生效为 open 区间 `[now, +∞)`；点"记录"后转为实际区间；计时器停止后 open 段失效 |
| 裸姓名（无斜杠）语义 | **整体作为演讲者名**（用户直觉）；点"记录"时自动归一化为"环节 N / 姓名"存入记录 |
| UX | 保留计时器上方单输入框；按需提示横幅（未填过=info / 历史全空=warning）+ KPI 红色警告 |
| 服务端测试 | 补齐 `resolveTimelineSpeaker` / `annotateTranscriptSpeakers` / `resolveDominantSpeaker` 单测 |
| i18n | zh / en / zh-TW 三语齐加；其余语言走 en fallback |
| 多演讲者展示 | 评分/评价按 `round.speaker` 分组；≥2 个有内容分组时渲染可折叠子模块 |
| 单人场景 | 自动保持原平铺视图，零影响 |

## 四、改动清单

### 客户端 — 数据层

- `utils/speech-segments.ts`：新增 `buildSpeakerTimeline`（含 open 段）、`resolveActiveSegmentSpeaker`（裸姓名=演讲者）、`normalizeSegmentLabel`（记录时归一化）
- `utils/speech-export.ts`（新）：`buildSpeakerFeedbackMarkdown` / `buildAllSpeakersFeedbackMarkdown`（按人点评 Markdown）、`groupSentencesBySpeaker`（逐字稿按人分组，时间线兜底）、`downloadTextFile`
- `composables/useSpeechTimer.ts`：`recordSegment` 裸姓名归一化
- `composables/useMeetingAssist.ts`：`AnalysisRound.speaker` 类型
- `composables/useSpeechAiAggregation.ts`：`speakerScores`（每人的最新评分）、`speakerSections`（按人分组评价）；`speakerDurations` 缺 speaker 时反查兜底；新增可选入参 `timerLabel` / `timerRunning`
- `composables/useSpeechEvalReport.ts`：`getVerbatimSpeakers` / `downloadVerbatimBySpeaker`（逐字稿按人导出）

### 客户端 — 视图层

- `views/hermes/MeetingView.vue`：ASR final 按时间线反查 speaker 写入 sentence
- `SpeechEvaluationPanel.vue`：buildSpeechContext 注入 speakerTimeline（watch 含 timerLabel/timerRunning，400ms 防抖）；提示横幅 + KPI 红色警告；面板 `overflow-x: hidden` 防横向溢出；报告区接线
- `speech/right-panel/SpeechRoundCard.vue`（新）：单轮点评卡（平铺/折叠两视图共用）
- `speech/right-panel/SpeechSpeakerCard.vue`（新）：单演讲者折叠子模块（评分格+评价标签+轮次+单独导出）
- `speech/right-panel/SpeechEvalBlocks.vue`：≥2 有内容分组时渲染折叠卡片 + "导出全部点评"；平铺视图保留
- `speech/right-panel/LiveScoreCard.vue`：多演讲者每人一块记分牌
- `speech/right-panel/SpeechEvalReportSection.vue`："按演讲者导出逐字稿" NDropdown

### 服务端（确定性推导，prompt 加固）

- `report-parser.ts`：`AnalysisRound.speaker` 字段 + `resolveDominantSpeaker()`（按批次句子姓名计数，设备官过滤）
- `realtime-assist.ts`：analyzeBatch 后给 round 打 speaker 标记
- `direct-llm.ts`：无时间线时禁止 LLM 编造姓名

### 样式防御（溢出修复）

长英文高亮文本在 NTag（默认 nowrap）里把右栏 flex 容器撑爆，🎤 标题被挤出可视区。
修复：`.eval-tags`/`.round-chips` 的 `:deep(.n-tag)` 允许换行 + `max-width: 100%`；
`eval-block`/`round-card` 加 `min-width: 0`；面板 `overflow-x: hidden` 兜底。

### i18n（zh / en / zh-TW）

新增：`speakerHint`、`speakerHintHistory`、`kpiSpeakersZeroHint`、`exportSpeakerFeedback`、
`exportAllSpeakerFeedback`、`downloadVerbatimBySpeaker`；更新 `segmentLabelPlaceholder`
（"演讲者姓名（或 环节 / 姓名）"）与 `speakerHint` 文案。
另修复历史遗留：`meeting.interview.insightCount` 在所有 locale 缺失（HEAD 上 i18n-coverage
测试就是红的）。

### 测试

- `tests/client/utils/speech-segments.test.ts`：+17 用例（open 段/裸姓名/归一化）
- `tests/client/utils/speech-export.test.ts`（新）：6 用例
- `tests/client/composables/use-speech-ai-aggregation.test.ts`（新）：5 用例
- `tests/client/composables/use-speech-timer.test.ts`：裸姓名归一化断言更新
- `tests/server/report-parser.test.ts`：+15 用例（timeline 归属 + 主导演讲者推导）

## 五、持久化现状（面试过的事实）

| 数据 | 位置 | 时机 |
|---|---|---|
| 元数据+句子（含 speaker）+ speechEval | localStorage `hermes.meeting.sessions` | 实时写；超 5MB 自动归档最老会议句子 |
| 音频 webm | 服务器 `/api/meeting-storage` + IndexedDB 双写 | 停止录音时 |
| 会议 JSON | 服务器 saveMeeting | 停止录音时 |
| 报告 markdown | `session.htmlContent` → localStorage+服务器 | 生成完成时 |
| **AI 点评轮次（rounds）** | **仅内存（最近 50 条）** | **不持久化，刷新即失** |

## 六、已知边界与后续工作

1. **rounds 不持久化**——刷新后评分/分组消失（speechEval 手动数据还在）。候选：持久化进 session。
2. **批次跨演讲者**——AI 批次（5 句/18s）横跨两人切换点时归到句数较多一方；及时点"记录本段用时"可对齐。
3. **`begin_time`/`end_time` 秒/毫秒语义不一致**——上游 DashScope 给相对秒，前端按毫秒存 `startTime/endTime`（差 1000 倍）。不影响 speaker 链路，建议单独排查。
4. **报告（公众号风格文章）尚无按人分区**——报告 prompt 是全场一篇；按人折叠点评的导出已覆盖该需求，报告按人分区待产品定义。
5. `HIDE_SPEAKER_DIARIZATION` 硬编码保留（演讲场景不依赖声纹分离）。
6. 历史遗留测试失败（与本次无关）：chat-panel / ekko / profile-card / rtl 物理轴 CSS / ar 缺 `sidebar.connections`。
