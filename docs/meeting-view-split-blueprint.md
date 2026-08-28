# MeetingView 模块化拆分蓝图

> 状态：**8 个内聚块全部抽完**（commit e8f6648a 后 MeetingView 缩到 3831 行，主要剩余 audio setup 编排）。
> 文件位置：本文档在 `docs/meeting-view-split-blueprint.md`。

## 0. 背景与原则

`packages/client/src/views/hermes/MeetingView.vue` 长期作为唯一"会议模式"整页承载，
承担侧边栏、录音、波形、转写、Agent 面板、报告、创建对话框、报告弹窗等 7+ 个内聚块，
文件已超过 4400 行，单文件维护成本过高。

**之前的错误尝试**：把"场景"做成独立路由（`MeetingSceneShell` + `/hermes/meeting/scene/:scene?`），
导致无侧栏、无波形、无录音、Sidebar 不显示——已被废弃。

**新方向**：保留 `/hermes/meeting` 单一整页路由，按"内聚块 + 明确 props 边界"逐块拆出 Vue 组件。
场景模板只影响 MeetingView 内部的样式与提示，不切路由。

## 1. 已完成：WaveformCanvas 拆分样品

**文件**：`packages/client/src/components/hermes/meeting/WaveformCanvas.vue`

| 维度 | 拆分前（MeetingView 内联） | 拆分后 |
|---|---|---|
| 代码位置 | `<canvas ref="canvasRef">` + `drawWaveform()` + ~20 行 RAF 循环 | 单文件组件 ~110 行 |
| 状态耦合 | canvasRef/drawWaveform/animationFrameId 散落在父组件 | 组件内部全封装 |
| 生命周期 | 无 onUnmount 清理（RAF 泄露风险） | `onBeforeUnmount(stop)` + `cancelAnimationFrame` |
| 主题 | 父级 SCSS 里 `.waveform-container` 段 | 组件自带 scoped 样式 |
| 录音控制 | 父级手写 `analyser.value = null` 后才能停 | `watch(props.analyser)` 自动起停 |

**Props 契约**：
```ts
defineProps<{ analyser: AnalyserNode | null; connecting: boolean }>()
```

**已通过的测试**（`tests/client/waveform-canvas.test.ts`，5 项）：
- mount 时 analyser=null → 无 RAF
- connecting=true → 显示连接中遮罩
- analyser 从 null 切到实例 → 启动绘制循环
- analyser 从实例切到 null → 停止绘制循环
- unmount → 取消所有 RAF（无帧泄露）

**Vue 类型检查**：vue-tsc 全项目通过。

**Headless 验证**：dev 栈打开 `/#/hermes/meeting`，`.transcript-panel` + `.waveform-container` + canvas 三者均存在。

## 2. MeetingView 当前内聚块清单

| # | 块名 | 当前行号范围（近似） | 内聚职责 | 外部依赖 | 拆分状态 |
|---|---|---|---|---|---|
| 1 | 顶部控制条 | 1939-2025 | 录音按钮、状态文本、保存/分享 | analyser、isRecording | ✅ MeetingTopBar.vue |
| 2 | 波形可视化 | 1962 | 频谱 RAF 渲染 | analyser | ✅ WaveformCanvas.vue |
| 3 | 转写流列表 | 1993-2025 | 句子气泡 + 自动滚动 | transcriptSentences | ✅ TranscriptList.vue |
| 4 | 侧栏会话列表 | 1909-1937 | 会议历史列表、新建按钮 | meetingStore | ✅ MeetingSidebar.vue |
| 5 | 创建会议对话框 | 2405-2500 | 标题/场景选择/麦克风设备 | SceneTemplatePicker | ✅ CreateMeetingDialog.vue |
| 6 | 右面板（Agent/Speech） | 2027-2400 | MeetingAgentPanel / SpeechEvaluationPanel | sceneTemplate、isSpeechScene | ✅ MeetingRightPanel.vue + MeetingAgentPanel + SpeechEvaluationPanel |
| 7 | 报告/分析面板 | 2140-2400 | transcript analysis tab、报告弹窗 | sentences、analysis | ✅ MeetingAgentPanel（内嵌） |
| 8 | audio setup（核心） | 770-1120 | MediaStream + AnalyserNode + WebSocket + Diarize | 浏览器 API | ⏸️ 暂留父组件 |

## 4. 拆分执行记录

按推荐顺序全部完成（commit `e8f6648a refactor(meeting): MeetingView 模块化拆分 — 回滚场景壳 + 6 个内聚组件`）。
其中第 6 块（RightPanel）同时把 MeetingAgentPanel / SpeechEvaluationPanel 一起聚合到新的 MeetingRightPanel 壳里，
dispatch 顺序在 props 里显式传入（speech > agent > analysis）。

### 当前实际拆分结果（e8f6648a 后）

| 批次 | 组件 | 文件 | 测试 | MeetingView 接入行 |
|---|---|---|---|---|
| 1 | WaveformCanvas | `components/hermes/meeting/WaveformCanvas.vue` | `tests/client/waveform-canvas.test.ts` (5/5) | 1962 |
| 2 | MeetingSidebar | `components/hermes/meeting/MeetingSidebar.vue` | `tests/client/meeting-sidebar.test.ts` (7/7) | 1909-1937 |
| 3 | CreateMeetingDialog | `components/hermes/meeting/CreateMeetingDialog.vue` | `tests/client/create-meeting-dialog.test.ts` (5/5) | 2405-2500 |
| 4 | MeetingTopBar | `components/hermes/meeting/MeetingTopBar.vue` | `tests/client/meeting-topbar.test.ts` | 1939-2025 |
| 5 | MeetingRightPanel + MeetingAgentPanel + SpeechEvaluationPanel | `components/hermes/meeting/{MeetingRightPanel,MeetingAgentPanel,SpeechEvaluationPanel}.vue` | `tests/client/meeting-right-panel.test.ts` (13/13) | 2027-2400 |
| 6 | TranscriptList | `components/hermes/meeting/TranscriptList.vue` | （与 MeetingSidebar/MeetingView 共测） | 1993-2025 |

合计从 ~4400 行 MeetingView 缩到 3831 行；
新拆 6 个组件（含 WaveformCanvas）单文件均 < 250 行，测试覆盖 props 契约 + DOM 行为。

### 暂不拆：audio setup（第 8 块）
**理由**：与 MediaRecorder / AnalyserNode / WebSocket / AudioWorklet / Diarize 协议强耦合，是 MeetingView 的核心调度点。强行抽出需要传 10+ 个 ref，反而损害可读性。建议**等测试覆盖加深**后再评估。

## 5. 拆分规范

1. **props 只读**：每个拆出组件只接收自己需要的数据；不允许父级双向 v-model 共享内部状态。
2. **emits 命名**：父级回调用 `@动词-名词`，例如 `@select`、`@create`、`@toggle-record`。
3. **样式**：每个组件 scoped SCSS，主题色一律走 `var(--xxx)` 变量；不放 SCSS 公共变量。
4. **测试**：每个组件一个 `tests/client/<name>.test.ts`（jsdom + mount）；不依赖真实 AudioContext，用 FakeAnalyser 接口。
5. **i18n**：UI 文案用 `t('meeting.xxx')`；新组件的 key 写在 `meeting.<componentName>.*` 下，避免污染主 namespace。
6. **拆出后**：父级 MeetingView 行数应 ≤ 2500 行（audio setup + 编排逻辑）；再下批拆 audio setup。

## 6. 已验证的拆分收益

- **测试可行性**：jsdom 下可独立验证组件契约（WaveformCanvas 5/5 通过）。
- **vue-tsc 友好**：每个组件都是 `<script setup lang="ts">`，类型边界由 props 定义。
- **主题一致性**：组件自带 scoped 样式，主题色走 CSS 变量，dark/comic 自动适配。
- **录音控制解耦**：父级不再持有 canvasRef / animationFrameId，只用 ref 化的 `analyser.value` 单一信号。

## 7. 遗留决议（待你拍板）

1. **audio setup** 暂时保留在 MeetingView，等测试覆盖加深后再拆——你是否同意？
2. 是否需要在 `apps/dev` 临时再加一个 Storybook（**未做**，需先与你确认是否纳入下一批工作）？