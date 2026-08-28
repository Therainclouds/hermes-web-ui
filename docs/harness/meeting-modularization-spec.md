# 会议模块模块化实施规格（Spec）与验收标准

> 上游文档：[`meeting-module-audit.md`](./meeting-module-audit.md) v1.0（体量基线与诊断，本文不重复）。
> 本文是执行规格：每个 PR 拆什么、怎么拆、怎么验收。拆分全程**行为冻结**（pure move），场景化组件显示是后续独立工作，不在本规格内。
> 版本：v1.0（2026-08-28）

---

## 全局硬约束（适用于所有 PR）

1. **行为冻结**：纯搬移代码，不改任何运行时行为、不改 prompt、不改错误文案 key、不改事件时序。
2. **单一边界**：每个 PR 只拆一个模块边界，不夹带 bug fix、不格式化无关代码（AGENTS.md 第 8 条）。
3. **导出面不变**：对外导出（singleton、marker 常量、组件 props/events、i18n key）保持原样，调用方零改动或最小改动。
4. **红线**：动 meeting-asr 相关文件前已重读 [`meeting-asr-safety-audit.md`](./meeting-asr-safety-audit.md)——不碰 CSP/security.ts、不碰子进程 env 注入语义、不碰 venv 创建命令序列、worklet 保持静态路径。
5. **每 PR 验收命令**（全绿才算完成）：
   - `npx vitest run tests/server/<相关测试>` + `npx vitest run tests/client/<相关测试>`（增量）
   - `npm run build`（含 vue-tsc 类型检查，client PR 必跑）
   - 收尾统一跑 `npm run test` + `npm run build`。

---

## PR-2a — MeetingView 抽出 `useMeetingAudio` + `useDraggableWidth`

**起点**：`client/views/hermes/MeetingView.vue` 3842 行。
**产出**：
- `client/src/composables/useMeetingAudio.ts`（NEW）：录音全生命周期（mic 可用性检查 / AudioContext+AnalyserNode / start/stop / beforeunload 备份挂载）+ 播放全生命周期（play/pause/stop/seek×3/进度拖拽/句子高亮）。
- `client/src/composables/useDraggableWidth.ts`（NEW）：右栏拖拽宽度通用逻辑（load/start/on/stop）。

**规格**：
- composable 返回的**变量/函数名与 MeetingView 现名完全一致**，MeetingView 用解构接回，模板零改动。
- composable 通过参数接收外部依赖（store refs、sentences、回调），不直接 import MeetingView 专属状态。
- 事件监听器（beforeunload / mousemove / mouseup）的挂载与清理随逻辑搬入 composable，onUnmounted 清理由 composable 自带。

**验收标准**：
- [ ] MeetingView.vue 行数显著下降（目标 ≤ 3400，最终目标见 PR-2b）。
- [ ] 录音/播放相关的 ref 与函数在 MeetingView 中不再有本地定义（grep 验证）。
- [ ] `npm run build` 通过（vue-tsc 零新增错误）。
- [ ] 既有 client 测试全绿；新增 `tests/client/composables/use-draggable-width.test.ts`（纯逻辑可测）。

## PR-2b — MeetingView 抽出 `AsrConfigWizardDialog.vue`

**起点**：MeetingView 内联 ASR 配置向导（DashScope/LLM/OSS 表单 + 静态选项数据，~150 行 + 模板 + 样式）。
**产出**：`client/src/components/hermes/meeting/AsrConfigWizardDialog.vue`（NEW）。

**规格**：
- v-model 式契约：props 传 `show` + 配置对象，emit `update:show` / `save`。
- i18n key 保持与现有一致（不新增不减少，locale 文件零改动）。

**验收标准**：
- [ ] MeetingView.vue ≤ 2700 行（审计目标，较 3842 基线 -30%）。
- [ ] 向导相关 ref（asr/llm/oss keys + options）不再存在于 MeetingView。
- [ ] `npm run build` 通过；`npm run test` 全绿。

## PR-1 — 拆 server `realtime-assist.ts`

**起点**：`server/services/meeting-asr/realtime-assist.ts` 762 行 / 单 class。
**产出**（同目录新文件）：
- `agent-bridge.ts`（NEW）：Standalone Agent 调用（fetch + chunk + SSE 解析 + fallback 判定）。
- `direct-llm.ts`（NEW）：Direct LLM 流式调用 + 错误分类 + 多级 fallback。
- `report-parser.ts`（NEW）：`parseAnalysis` + 报告帧识别 + yield 累加。
- `realtime-assist.ts`：瘦身为 Socket 房间绑定 + 会话生命周期编排（目标 ≤ 300 行）。

**规格**：
- `realtimeAssistService` 单例导出与 `REPORT_FALLBACK_MARKER` 导出**位置不变**（controllers 与 index.ts 的 import 路径不动）。
- 拆出模块用显式依赖注入（fetch、logger、配置读取函数作参数），便于单测 mock。
- 不改 Socket.IO 事件名、不改 socket payload 结构。

**验收标准**：
- [ ] `grep -rn "realtime-assist" packages/server/src` 的 import 面与拆分前一致。
- [ ] 新增单测：`tests/server/report-parser.test.ts`、`tests/server/agent-bridge.test.ts`、`tests/server/direct-llm.test.ts`（mock fetch，不 mock 整个 socket）。
- [ ] `npm run test` 全绿；`npm run build` 通过。
- [ ] realtime-assist.ts ≤ 300 行。

## PR-5 — `MeetingAgentPanel` 抽出 `useReportStream`

**产出**：`client/src/composables/useReportStream.ts`（NEW）：报告生成 SSE 流解析 + 错误分类 + retry（~120 行）。
**验收标准**：
- [ ] MeetingAgentPanel.vue ≤ 700 行。
- [ ] SSE 解析/错误分类逻辑可独立单测：新增 `tests/client/composables/use-report-stream.test.ts`。
- [ ] `npm run build` 通过；`npm run test` 全绿。

## PR-6 — `SpeechEvaluationPanel` 抽出 `useSpeechTimer` + `useSpeechFillerCounter`

**产出**：`client/src/composables/useSpeechTimer.ts`、`client/src/composables/useSpeechFillerCounter.ts`（NEW）。
**验收标准**：
- [ ] SpeechEvaluationPanel.vue ≤ 750 行。
- [ ] 计时器状态机（fmt/reset/toggle/nextLabel/record/remove）与填充词统计（increment/remove/computed）在 composable 中，可单测。
- [ ] `npm run build` 通过；`npm run test` 全绿。

## PR-4 — `meeting-asr/index.ts` 抽出 `venv-manager` + `dashscope-key-store`

**起点**：`server/services/meeting-asr/index.ts` 1066 行（含 v0.7.x 刚提交的 venv 路径与 key 回退逻辑）。
**产出**：
- `venv-manager.ts`（NEW）：`resolveVenvPath` / `resolveVenvMarkerPath` / venv 创建 + pip install 编排（`getVenvPythonPath` + `runCaptured`）。
- `dashscope-key-store.ts`（NEW）：`readStoredDashScopeKey` 双文件回退（config.json + config.env）。
- `index.ts`：保留进程 spawn / 端口 / 健康监控 / 配置热更新。

**规格**：
- `MeetingASRService` 类的方法签名不变（venv/key 逻辑改为委托新模块），`meeting-asr-venv-path.test.ts` 既有断言不改语义。
- 不改子进程 spawn 参数顺序与 env 注入（safety audit 红线）。

**验收标准**：
- [ ] `npx vitest run tests/server/meeting-asr-venv-path.test.ts` 全绿（不改断言）。
- [ ] 新增 `tests/server/dashscope-key-store.test.ts`。
- [ ] index.ts ≤ 800 行。
- [ ] `npm run test` 全绿。

## PR-7 — `diarize_endpoint.py` router/service 分层

**产出**：`python-backend/app/diarize_endpoint.py` 拆为路由层（FastAPI endpoint 定义、请求模型）+ 服务层（audio_buffer 管理、说话人分离编排、chunk 处理）。
**规格**：
- 路由路径、请求/响应模型、状态码不变。
- **不动** audio_buffer 并发结构（safety audit R-4/R-12 明确"未修暂不动"，拆分不引入锁语义变更）。
- 既有 `tests/python/` 全绿。

**验收标准**：
- [ ] diarize_endpoint.py 路由文件 ≤ 400 行，服务逻辑入新模块。
- [ ] `python -m pytest tests/python/ -q` 全绿。

---

## 收尾统一验收

- [ ] `npm run test` 全绿；`npm run build` 通过；行数核对表更新回审计文档附录 B（勾选已完成项）。
- [ ] 每个 PR 一个独立 commit（conventional commits），commit 历史可逐个 revert。
- [ ] `docs/harness/meeting-module-audit.md` 附录 B 勾选状态与实际一致。
