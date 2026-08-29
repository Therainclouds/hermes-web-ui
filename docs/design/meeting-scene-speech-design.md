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


---

# v2.0 增补（2026-08-29）：布局重设计 + 用户反馈机制选型

> 触发：真实体验反馈——右栏 12 个区块堆叠太臃肿、"所有功能藏起来要找"；10 条点评质量问题反馈。
> 设备侧最新提示词已逐条覆盖 10 项反馈的文字表述，但**提示词合规是概率性的**，确定性规则必须代码保证。

## 1. 用户反馈 × 机制选型矩阵

| # | 反馈 | 提示词（已覆盖？） | 正确机制 | 状态 |
|---|------|------------------|---------|------|
| 1 | 说人话、有感情鼓励 | ✓ 教练人设 | Skill 提示词（版本化迭代） | 已覆盖，随 Skill 迭代 |
| 2 | 方言不标准过滤 | ✓ 方言/口音不计语法 | 提示词为主 | 已覆盖 |
| 3 | 发言人区分/设备官/串场 | ✓ | **代码 Hook**（DEVICE_SPEAKER_RE + 串场记录，client 已有） | 已实现 |
| 4 | 赘语按发言人+清单+3min/10 阈值 | ✓ 清单与阈值已写 | **新代码 Hook**：parse 后处理按实际时长过滤 fillerWords（不再靠 AI 自觉） | **待做** |
| 5 | 金句定义不清 | ✓ 定义已写 | Skill 提示词补 few-shot 正反例 | **待强化** |
| 6 | 表情/肢体语言分析 | ✓ 禁编造+人工观察 | 保持人工记录（音频模态限制；摄像头多模态为远期项） | 已按模态现实设计 |
| 7 | 3+1：只给 1 个最重要可落地提升点 | ✓ 已写"最多3条" | **新代码 Hook**：improvements 截 1、highlights 截 3（LLM 不自律） | **待做** |
| 8 | 陪伴型教练有温度 | ✓ | Skill 提示词 | 已覆盖 |
| 9 | 报告不输出文档风 | ✓ reportPrompt 已改 | reportPrompt | 已覆盖 |
| 10 | 学习公众号文风 | ✓ "像公众号推文"已写 | reportPrompt | 已覆盖 |

## 2. 机制结论：三层分工，不用 MCP

```
┌─ Skill 层（内容载体，版本可迭代）──────────────────────┐
│ speech 的 systemPrompt/reportPrompt 从 scene-templates  │
│ 硬编码抽到内置 skill meeting-speech-coach，经既有的     │
│ prepareAnalysisSkillSection 按 profile 自动安装注入。   │
│ 提示词迭代 = 改 skill 文件，无需发版、设备侧可覆盖。     │
├─ 提示词层（意图与文风）────────────────────────────────┤
│ 人设/文风/金句定义/3+1 原则/方言规则 —— 概率性合规。     │
├─ Hook 层（代码后处理，确定性保证）──────────────────────┤
│ parse 后处理（report-parser 出口处）：                  │
│  H1 赘语阈值：按实际发言时长折算，≤10个/3min 直接清空     │
│     fillerWords 且不标 attention                        │
│  H2 3+1 强制：improvements 截 1 条、highlights 截 3 条   │
│  H3 设备官过滤：speaker 命中设备播报正则的条目剔除        │
│   （client 已有 DEVICE_SPEAKER_RE，下沉到 parse 层统一） │
└────────────────────────────────────────────────────────┘
✗ 不用 MCP：本场景无外部数据查询需求；实时点评走 direct-LLM
  快路径（~3s），挂 Agent+MCP 会变成 30s+ 且引入工具失败面。
```

**落地顺序**：H1/H2/H3 三个 Hook 是本轮唯一的确定性增量（report-parser 后处理 + 单测）；Skill 化作为独立 PR（搬运提示词内容，行为等价）；提示词 few-shot 强化随 Skill 内容迭代。

## 3. 布局重设计：从"单列堆叠"到"仪表头 + Tab 分区"

**问题**：右栏纵向堆叠 12 个区块（评分/亮点/提升点/主题/新点评/计时/赘语/金句语法/肢体/报告/设置），一屏只见 1/4，功能要靠滚动发现。

**方案**：**常驻仪表头 + 四 Tab 分区**。Tab 栏本身就是功能目录——"一眼看到所有功能"由 Tab 文案保证，而非依赖滚动。

```
┌─ 顶栏（topbarWidget 槽位，S1 已留）──────────────────────┐
│ [🎤演讲评分]  计时:[演讲|串场]  [🔔提醒开]  [实时对话]      │
├──────────────────────────────┬───────────────────────────┤
│ 波形舞台 + 计时浮层（不变）      │  ◆ 常驻仪表头（sticky）     │
│──────────────────────────────│  ┌────┬────┬────┬────┐    │
│ ● 状态条（不变）                │  │总分 │阶段 │时间 │赘语│    │
│──────────────────────────────│  │ 83 │ 🟢 │5:32│ 6  │    │
│ 逐字稿流                       │  └────┴────┴────┴────┘    │
│                               │  [点评] [计时] [记录] [报告]│
│                               │  ─────────────────────────│
│                               │  Tab=点评: 新点评卡+亮点/    │
│                               │    提升点/主题              │
│ [● 录音]                      │  Tab=计时: 环节+串场+发言人  │
│                               │  Tab=记录: 赘语/金句/语法/   │
│                               │    肢体（手动+AI）           │
│                               │  Tab=报告: 生成/逐字稿/导出  │
└──────────────────────────────┴───────────────────────────┘
```

- 常驻仪表头（sticky）：4 个 KPI（总分/相位/剩余时间/赘语数）录音时始终可见，不需要滚动。
- 四 Tab：点评=AI 输出流；计时=计时员卡全部；记录=赘语+语法官+肢体（手动记录集中地）；报告=生成/逐字稿/导出。
- 实现载体：SpeechEvaluationPanel 内部重组（NTabs），S3 的五组件原样成为 Tab 内容，注册表/单例/composable 全部不动。

## 4. v2 实施切分

| PR | 内容 | 类型 | 估时 |
|----|------|------|------|
| S6 | Panel 改仪表头 + NTabs 四分区（复用 S3 组件） | 纯重组 | 0.5d |
| S7 | Hook H1/H2/H3：parse 后处理 + 单测 | 确定性保证 | 0.5d |
| S8 | 提示词 Skill 化（meeting-speech-coach）+ 金句 few-shot | 搬运+内容迭代 | 0.5d |

验收：S6 逐 Tab 截图对比功能完整；S7 单测覆盖阈值边界（10个/3min 上下、improvements 2条截1）；S8 skill 自动安装日志 + prepareAnalysisSkillSection 注入验证。
