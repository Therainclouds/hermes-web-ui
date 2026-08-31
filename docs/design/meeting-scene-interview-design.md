# 会议场景定制化设计 · 三：客户访谈场景（interview）

> 上游：[`meeting-scene-speech-design.md`](./meeting-scene-speech-design.md)（`SCENE_UI` 契约）、[`meeting-scene-legal-design.md`](./meeting-scene-legal-design.md)（法律场景同构先例：结构化字段 + Hook + Skill 三层）。
> 版本：v1.0（2026-08-30，设计稿，待评审）

---

## 1. 产品定位

**访谈者的实时 copilot——"你专心听，AI 帮你记和提醒"。**

场景：用户研究访谈、销售 discovery、客户成功回访、需求调研。访谈者与客户面对面，最贵的注意力在"听"上，没有余量做记录和结构化。AI 的职责：

- **实时提取**：客户说的需求/痛点/机会/竞品提及，随说随入清单
- **追问提醒**：基于客户回答建议下一个该深挖的问题（访谈独有的器官）
- **参与度监控**：客户不耐烦/防备/想结束的信号及时提醒（访谈场景的 urgent 语义 = 客户关系风险，不是内容风险）
- **证据留痕**：客户原话（关键引语）可单独引用——用户研究的硬通货

**合规/边界**：竞品信息/行业数据的 MCP 检索为 v2 可选（报告 prompt 已预留），v1 只分析对话本身。

## 2. 现状盘点

| 载体 | 现状 | 缺口 |
|------|------|------|
| server interview 模板 | ✓ 提示词（洞察/追问方向/参与度三档：normal / attention=不耐烦·防备·即将结束 / urgent=明确不满·即将终止合作）+ 报告结构（摘要/核心需求/痛点顾虑/竞品提及/机会点/跟进计划）+ 信息检索 MCP 预留 | 提示词未 Skill 化；无结构化字段（需求/痛点只存在于报告文本） |
| `SCENE_TOOL_TRIGGER` | interview 不在表内 → 恒走 direct-LLM 快路径 | 无（访谈无外部数据查询刚需，与法律场景的决策一致） |
| 客户端 | interview 场景落到通用分析面板 | 无专属 UI：无需求/痛点清单、无引语卡、无追问建议 |
| `SCENE_UI` 注册表 | speech/legal 已注册 | interview 空 |

## 3. 信息架构（右栏 InterviewPanel + 参与度状态条）

```
┌─ 顶栏 ──────────────────────────────────────────────────┐
│ [🎙️客户访谈]                              （v1.5: 提纲按钮）│
├──────────────────────────────┬──────────────────────────┤
│ 波形 + 逐字稿（无浮层——        │ ◆ 常驻 KPI 头（sticky）    │
│   访谈场景的英雄元素是"追问"，   │  需求 3 · 痛点 2 ·        │
│   追问建议常驻面板顶部）        │  跟进 1 · 参与度 😊        │
│──────────────────────────────│──────────────────────────│
│ ● 状态条：参与度标签 + 洞察计数   │ [洞察] [引语] [追问] [报告]│
│   （at_risk 时变琥珀）          │──────────────────────────│
│──────────────────────────────│  💡 洞察流（按类型着色：     │
│ 逐字稿                        │   需求/痛点/机会/竞品）      │
│   客户：我们现在最大的问题是…    │  🗣 关键引语（客户原话卡）    │
│                              │──────────────────────────│
│ [● 录音]                      │  ❓ 追问建议（AI 每轮最多 2 条）│
│                              │──────────────────────────│
│                              │  报告：生成/导出            │
└──────────────────────────────┴──────────────────────────┘
```

- `stageOverlay`: **不注册**（同 legal——舞台留给波形+逐字稿）
- `transcriptStrip`: `InterviewStrip`（参与度标签 + 洞察计数，`at_risk` 时变琥珀）
- `rightPanel`: `InterviewPanel`（KPI 头 + 四分区）
- `topbarWidget`: v1 不注册；**v1.5 提纲追踪**（见 §7）

## 4. 数据契约（server → client）

interview 场景的 LLM 输出在通用字段外增加结构化字段：

```ts
// AnalysisRound 增量（interview 场景）
insights?: Array<{
  type: 'need' | 'pain' | 'opportunity' | 'competitor'
  text: string
  quote?: string          // 客户原话
}>
keyQuotes?: Array<{ quote: string; speaker?: string }>  // 客户关键引语
followUps?: string[]      // 建议追问（每轮最多 2 条）
engagement?: 'engaged' | 'neutral' | 'distracted' | 'at_risk'
```

**Hook 层（确定性护栏，parse 出口执行，仅 interview 字段出现时生效）**：
- **H-I1 洞察上限与白名单**：每轮 insights ≤ 4 条；type 枚举外丢弃
- **H-I2 引语去重**：同 quote 不重复；≤ 3 条/轮
- **H-I3 追问上限**：followUps ≤ 2 条
- **H-I4 参与度归一**：`at_risk` 仅允许"不满/终止合作"语义命中，否则降级 `distracted`

## 5. 机制选型（三层分工，与 speech/legal 同构）

- **Skill 层**：新增内置技能 `meeting-interview-review`——访谈方法论：需求/痛点/机会的分类学定义、追问技巧（开放式→深挖→确认闭环）、参与度信号清单（言语+节奏信号）、关键引语标准（具体、有场景、可指导决策）、竞品提及的处理纪律（记录不评价）。经 `prepareAnalysisSkillSection(profile, 'interview')` 注入（场景过滤前缀映射加 `meeting-interview → ['interview']`）
- **提示词层**：systemPrompt 保留人设一句话 + 参与度三档语义 + JSON 字段契约；报告结构（摘要/需求/痛点/竞品/机会/跟进）保留在 reportPrompt
- **Hook 层**：H-I1/2/3/4 如上
- **✗ 不用 MCP（v1）**：访谈洞察不依赖外部数据；竞品/行业数据检索为 reportPrompt 已预留的 v2 增强（同 legal L4 模式：报告路径一次性调用，不影响实时延迟）

## 6. PR 切分与验收

| PR | 内容 | 验收 | 估时 |
|----|------|------|------|
| **I1** server | interview 轮次结构化字段（insights/keyQuotes/followUps/engagement）+ Hook H-I1/2/3/4 + `meeting-interview-review` skill + 场景过滤前缀映射扩展 + systemPrompt 输出契约扩展 | parse 单测：洞察上限/白名单/引语去重/参与度归一；场景过滤单测（interview 注入、general 排除） | 1d |
| **I2** client 面板 | `InterviewPanel`（KPI 头 + 洞察流/引语/追问/报告四分区）+ `useInterviewAggregation`（按类型聚合/去重/参与度最新态）+ 注册表注册 + MeetingRightPanel `isInterviewScene` 分发 | Panel ≤ 600；aggregation 单测；i18n ×3 | 1d |
| **I3** 状态条 | `InterviewStrip`（参与度标签 + 洞察计数，at_risk 变琥珀）+ status-bar 条件泛化沿用 | 组件单测 | 0.5d |
| **I4**（v1.5 可选） | 提纲追踪：面板可编辑提纲清单 → 随上下文注入 → AI 每轮标注已覆盖问题索引 → 覆盖率进度条 | 需新增提纲编辑 UI 与持久化字段，单独评审 | 1d+ |

统一验收：`vite build` 全量编译 + vue-tsc + 相关测试全绿 + i18n ×3 + 每 PR 可独立 revert。

## 7. 范围围栏

- 不动 speech/legal/general/business/medical
- 提纲追踪为 v1.5（需要提纲编辑 UI 与会话持久化新字段，单独评审）
- 竞品/行业数据 MCP 检索为 v2（报告路径，不影响实时延迟）
- 不做 CRM/问卷系统集成
- 访谈伦理：参与度监控仅提示访谈者调整节奏，不对客户做任何评判性展示；报告中的客户引语默认匿名化选项留待 v2
