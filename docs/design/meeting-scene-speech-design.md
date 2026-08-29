# 会议场景定制化设计 · 一：演讲评分场景（speech）

> 上游：`docs/work-log.md` 2026-08-28「六大场景专门组件化」决策；[`meeting-modularization-spec.md`](../harness/meeting-modularization-spec.md)（模块化底座）。
> 本文是**六场景契约的设计试点**：演讲场景既是首个定制的场景，也是「场景 → 组件组合」注册表契约的第一个注册者；法律/访谈及其余三场景复用同一契约。
> 版本：v1.0（2026-08-29，设计稿，待评审）

---

## 1. 现状盘点（org 演讲功能并入后）

| 载体 | 行数 | 职责 | 问题 |
|------|------|------|------|
| `SpeechEvaluationPanel.vue` | **1482** | 12 个模板区块：实时评分卡/亮点/提升点/主题/新点评卡/计时员(含发言人用时+串场)/赘语(按发言人)/金句语法/肢体语言观察/评估报告/计时设置 | 面板健康区（300–500）的 3–5 倍；8 类职责内联 |
| `MeetingView.vue` | 2959 | 内联演讲浮层（`speech-timer-overlay`）+ 状态条（`speech-transcript-strip`）+ 相位样式 + `useSpeechTimer` 接线 | 场景 UI 硬编码在视图主体 |
| `useSpeechTimer.ts` | 207 | 模块级单例走表核心（含面板功能层） | 设备侧新增的 **timerMode（演讲/串场）/transitionRecords/TTS 语音提醒** 又内联回了 Panel |
| `useSpeechFillerCounter.ts` | 82 | 赘语统计 | ✓ 健康 |
| `RealtimeDialogPanel.vue` | 480 | 实时语音对话 | **场景无关（会议级）**，本设计不动 |
| 场景接线 | — | `isSpeechScene` 散落判断、RightPanel 四模式分发 | **无场景→组件注册表**，六场景无法声明式扩展 |

**核心判断**：功能全集已经存在且经过设备侧真机验证；本设计不做新功能，做**结构归位**——把散在 Panel/MeetingView 里的演讲 UI 收拢为注册表驱动的组件树。

## 2. 设计原则

1. **场景契约先行**：注册表是六场景共用的扩展点，speech 只是第一个注册者；general/business/medical/legal/interview 注册空实现，互不影响。
2. **纯搬移与行为改进分离**：组件化 PR 一律行为冻结；唯一的行为改进（报告生成改走 `useReportStream`）单独成 PR、单独标记。
3. **单例计时器是演讲场景的脊柱**：timerMode/串场记录/TTS 提醒全部收编进 `useSpeechTimer`（它们本来就是计时器状态），Panel 不再持有计时逻辑。
4. 延续硬规则：每 PR 单一边界、i18n 三 locale、`docs/` 提交用 `git add -f`。

## 3. 场景 UI 契约（六场景共用，新增文件）

```ts
// packages/client/src/components/hermes/meeting/scene-ui-registry.ts
import type { Component } from 'vue'
import type { SceneId } from './scene-templates'

export interface SceneUIContribution {
  /** 波形舞台之上的场景浮层（speech = 计时器浮层；其余场景暂缺省） */
  stageOverlay?: Component
  /** 转写区顶部的场景状态条（speech = 计时状态条） */
  transcriptStrip?: Component
  /** 右栏场景主面板（speech = SpeechEvaluationPanel） */
  rightPanel?: Component
  /** 顶栏场景控件（speech = 计时模式切换 + TTS 开关） */
  topbarWidget?: Component
}

export const SCENE_UI: Record<SceneId, SceneUIContribution> = { /* … */ }
```

- `MeetingView`：舞台浮层/状态条改为 `<component :is="SCENE_UI[scene].stageOverlay" />` 式渲染，删除 `isSpeechScene` 硬编码分支。
- `MeetingRightPanel`：`#speech` 插槽内容改为从注册表取 `rightPanel`；**speech > agent > realtime > analysis 的既有优先级不变**（agent/realtime/analysis 是"模式"不是"场景"，仍走原分发）。
- 新场景接入 = 写组件 + 注册表加一行。

## 4. 目标组件树（演讲场景）

```
components/hermes/meeting/speech/
├── SpeechTimerOverlay.vue        # 波形浮层：大字倒计时+相位色+开始/暂停/重置（~90，自 MeetingView 搬出）
├── SpeechTranscriptStrip.vue     # 转写状态条：运行点+时间+句数+刻意练习提示（~60，同上）
└── topbar/
    └── SpeechTopbarWidget.vue    # 计时模式切换（演讲/串场）+ TTS 提醒开关（~80，自 Panel 搬出）
components/hermes/meeting/speech/right-panel/
├── LiveScoreCard.vue             # 实时评分卡（更新式，含更新时间）（~80）
├── SpeechEvalBlocks.vue          # 累积亮点/提升点/主题 + 🆕新点评卡（~130）
├── SpeechTimerCard.vue           # 计时员卡：走表+环节记录+发言人用时+串场记录+TTS 开关（~180）
├── SpeechTimerSettingsDialog.vue # 设置弹窗 + 5 组 Toastmasters 预设（~130）
└── SpeechEvalReportSection.vue   # 评估报告区 + 逐字稿下载（~110）
composables/
├── useSpeechTimer.ts             # 收编 timerMode/transitionRecords/voiceAlert(TTS)（207→~300）
├── useSpeechAiAggregation.ts     # NEW：liveScore/highlights/improvements/topics/newPointRounds/
│                                 #   goldenQuotes/grammarIssues/发言人用时（~140，纯 computed 可单测）
└── useSpeechEvalReport.ts        # NEW：buildTranscriptWithEval + generateReport（~100）
SpeechEvaluationPanel.vue         # 组装壳：区块编排 + persist + assist 接线（1482→~400）
```

## 5. 页面布局提案（演讲模式专门布局）

```
┌──────────────────────────────────────────────────────────────────┐
│ TopBar: [场景徽章 🎤演讲评分] [计时: 演讲|串场] [🔔语音提醒] [实时对话] │
├────────────────────────────────────┬─────────────────────────────┤
│ 波形舞台（相位描边随红黄绿变化）        │  📊 实时评分卡（持续更新）      │
│  ┌────────────────────────────┐    │     内容 85 · 结构 80 · …     │
│  │    12:34   🟢 演讲中         │    │─────────────────────────────│
│  │    [开始] [暂停] [重置]      │    │  ✨ 亮点   💡 提升点   🏷️ 主题 │
│  └────────────────────────────┘    │  🆕 新点评卡（仅新增时弹出）     │
│  ● 12:34 演讲中 │ 23 句 | 刻意练习   │─────────────────────────────│
│────────────────────────────────────│  ⏱ 计时员卡                  │
│  逐字稿（按发言人分组着色）            │    环节列表 · 发言人用时       │
│   [张三] 本周我们聚焦交付节奏…        │    串场记录 · 🔴语音提醒开关    │
│   [李四] 我补充一个数据…             │─────────────────────────────│
│                                    │  赘语(按发言人) ⇄ 金句/语法    │
│  [ ● 录音按钮 ]                     │─────────────────────────────│
│                                    │  肢体语言观察 | 评估报告/逐字稿下载│
└────────────────────────────────────┴─────────────────────────────┘
```

与现状的差异仅两处是**新能力**（其余全部是既有元素组件化）：
1. 逐字稿按发言人分组着色（配合提示词的按发言人区分；转写已带 `[姓名]` 标注，纯前端渲染）。
2. 顶栏场景控件（计时模式/TTS 开关从 Panel 深处提到顶栏，就近操作）。

## 6. PR 切分与验收标准

| PR | 内容 | 验收 | 估时 |
|----|------|------|------|
| **S1** 场景契约 + 舞台搬移 | `scene-ui-registry.ts`；`SpeechTimerOverlay/TranscriptStrip` 搬出并经注册表渲染；MeetingView 删硬编码分支 | MeetingView ≤ 2780；`SCENE_UI` 六键齐全；行为冻结（快照对比模板结构）；build+测试全绿 | 0.5d |
| **S2** 计时脊柱收编 | `useSpeechTimer` 收编 timerMode/串场记录/TTS；Panel 删除内联计时逻辑 | Panel 计时区块清空（grep 验证）；composable 单测覆盖模式切换/串场记录/TTS 触发 | 0.5d |
| **S3** 右栏组件化 | `LiveScoreCard/EvalBlocks/TimerCard/SettingsDialog/ReportSection` + `useSpeechAiAggregation` | Panel ≤ 500；aggregation 单测（含金句 3 条上限/发言人去重/3+1 结构） | 1d |
| **S4** 报告链路对齐 | `useSpeechEvalReport` 生成改走 `useReportStream` | **行为改进（唯一）**：获得 fallback 帧清空/错误分类/无 [DONE] 截断检测；单测覆盖 | 0.5d |
| **S5**（可选，独立 feature）| 逐字稿按发言人分组渲染 | 纯渲染，speaker 缺省时回退现有平铺 | 0.5d |

统一验收：`npm run build` + 全量测试与基线同集合（0 回归）+ i18n zh/en/zh-TW 同步 + 每 PR 可独立 revert。

## 7. 范围围栏（明确不做）

- 不动 general/business/medical/legal/interview 的现有表现（注册表空实现，后续各自设计时填充）。
- 不动 `RealtimeDialogPanel`/`useOmniRealtime`/`omni_realtime_proxy`（会议级能力，场景无关）。
- 不改任何提示词（教练人设/金句/发言人区分的 prompt 由设备侧刚落地，保持冻结）。
- 不动服务端 `report-parser`/`direct-llm`（设备侧已在其上扩展 GoldenQuote 等，本设计纯客户端）。
- 不做路由级场景页（沿用"单视图 + 模板影响样式与提示"的既有决策）。
