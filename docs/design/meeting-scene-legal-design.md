# 会议场景定制化设计 · 二：法律沟通场景（legal）

> 上游：[`meeting-scene-speech-design.md`](./meeting-scene-speech-design.md)（场景契约 v2 试点，法律复用同一 `SCENE_UI` 注册表）。
> 版本：v1.0（2026-08-30，设计稿，待评审）

---

## 1. 产品定位

**合同谈判、法律咨询、纠纷调解中的实时风控副驾。** 核心价值三句话：

- 不错过风险点——风险信号实时入清单，分级呈现
- 不错过时效——诉讼时效/期限类信号强制升 attention
- 追得住立场——各方主张按发言人累积成时间线，报告不再凭印象写

目标用户：律师/法务（客户沟通记录）、商务（合同谈判风控）、当事人（纠纷沟通自我保护）。**合规底线：AI 输出仅辅助分析，报告尾注"不构成法律意见"。**

## 2. 现状盘点

| 载体 | 现状 | 缺口 |
|------|------|------|
| server legal 模板 | ✓ 实时提示词（风险分级/时效/情绪三档）+ 报告结构（摘要/立场/风险清单/证据时效/行动/跟进）+ 法条引用纪律（禁编造、标注"需人工核实"） | 提示词未 Skill 化；无结构化字段（风险清单只存在于报告文本） |
| `SCENE_TOOL_TRIGGER.legal` | ✓ 法条触发正则已定义（民法典/诉讼时效/违约金…约 40 词） | **死代码**：`needsToolLookup` 在实时批次从不被调用（analyzeBatch 直连 direct-LLM） |
| 客户端 | legal 场景落到**通用分析面板**（summary/key_points/action_items） | 无专属 UI：无风险清单、无立场追踪、无法条卡 |
| `SCENE_UI` 注册表 | speech 已注册四槽位 | legal 全空 |

## 3. 信息架构（右栏 LegalReviewPanel + 风险状态条）

```
┌─ 顶栏 ──────────────────────────────────────────────────┐
│ [⚖️法律沟通]  风险雷达:[开]  （无计时元素——法律场景无倒计时）│
├──────────────────────────────┬──────────────────────────┤
│ 波形 + 逐字稿（无浮层——        │ ◆ 常驻 KPI 头（sticky）    │
│   法律场景的"英雄元素"是风险，   │  ⚠高风险 2 · 风险 7 ·     │
│   不在舞台上放倒计时）          │  参与方 3                 │
│──────────────────────────────│──────────────────────────│
│ ● 状态条：⚠ 高风险 2 · 时效 1   │ [风险雷达] [立场] [依据]   │
│   （风险信号时左缘变琥珀/红）     │   [报告]                  │
│──────────────────────────────│──────────────────────────│
│ 逐字稿（风险句高亮：amber 左缘）  │  风险雷达：分级清单卡       │
│                              │   [高] 违约金上限条款不利…   │
│                              │   [中] 付款节奏未约定…      │
│ [● 录音]                      │  立场时间线：对方/我方主张    │
│                              │  法条依据：引用卡+核实状态    │
│                              │  报告：生成/逐字稿/导出      │
└──────────────────────────────┴──────────────────────────┘
```

- `stageOverlay`: **不注册**（法律场景无倒计时；舞台回归波形+逐字稿本体）
- `transcriptStrip`: `LegalRiskStrip`（状态 + ⚠高风险计数，有 urgent 时变红）
- `rightPanel`: `LegalReviewPanel`（KPI 头 + 四分区）
- `topbarWidget`: 风险雷达开关（关闭时暂停风险轮推送，只保留转写）

## 4. 数据契约（server → client）

legal 场景的 LLM 输出在通用字段外增加结构化字段（与 speech 的增量评价同构）：

```ts
// AnalysisRound 增量（legal 场景）
riskItems?: Array<{
  level: 'high' | 'medium' | 'low'   // urgent→high, attention→medium, normal→low
  text: string                        // 风险描述
  quote?: string                      // 触发原文
  lawHint?: string                    // 涉及法条/条款线索（如"民法典第584条"）
}>
positions?: Array<{ party: string; stance: string }>  // 本轮新增的各方主张
lawRefs?: Array<{ name: string; article?: string; note?: string }>
```

**Hook 层（确定性护栏，parse 出口执行）**：
- **H-L1 等级白名单**：urgent 仅允许时效届满/重大权利放弃/情绪失控语义命中；否则降级 attention
- **H-L2 法条纪律**：lawRefs 无 `verified: true` 一律强制携带"需人工核实"标记（对齐报告提示词的既有纪律）
- **H-L3 去重**：同 quote/同法条不重复入清单

## 5. 机制选型（沿用三层分工，正面回答触发链路问题）

- **Skill 层**：新增内置技能 `meeting-legal-review`——风险分级方法论（什么算 high/medium/low）、各方立场提取规则、法条引用纪律、时效敏感清单、免责声明。经 `prepareAnalysisSkillSection(profile, 'legal')` 注入（S8 的场景过滤机制直接复用，`meeting-legal-*` 前缀仅注入 legal 场景）
- **提示词层**：legal systemPrompt 已有风险三档——骨架保留，方法论细则迁入 Skill
- **Hook 层**：H-L1/2/3 如上
- **✗ 不用 MCP（v1）**：实时风控要求 ~3s 延迟；法条知识由模型基础能力承担 + "需人工核实"兜底。**v2 增强开关**：`needsToolLookup` 命中高风险关键词时升级 Agent+MCP 法条核实路径（dead code 复活，需设备侧配置法规检索 MCP 工具；只在风险轮触发、延时可接受）——单独立项，不在本轮

## 6. PR 切分与验收

| PR | 内容 | 验收 | 估时 |
|----|------|------|------|
| **L1** server | legal 轮次结构化字段（riskItems/positions/lawRefs）+ Hook H-L1/2/3 + `meeting-legal-review` skill（含免责声明）+ prepareAnalysisSkillSection 场景过滤泛化（speech 前缀机制泛化为前缀映射） | parse 单测：等级白名单/去重/核实标记；skill 场景过滤单测（legal 注入、general 排除） | 1d |
| **L2** client 面板 | `LegalReviewPanel`（KPI 头 + 风险雷达/立场/依据/报告四分区）+ `useLegalAggregation`（风险去重累积/立场时间线）+ 注册表注册 | Panel ≤ 600；aggregation 单测；i18n ×3 | 1d |
| **L3** 状态条 | `LegalRiskStrip`（⚠ 高风险计数 + urgent 变红）+ 逐字稿风险句 amber 左缘高亮 | 组件单测；风险句高亮与 riskItems.quote 匹配 | 0.5d |
| **L4**（可选） | Agent+MCP 法条核实实时路径（needsToolLookup 接线 + 延时护栏） | 需设备侧 MCP 工具；单独评审后立项 | 1d+ |

统一验收：`vite build` 全量编译 + vue-tsc + 相关测试全绿 + i18n ×3 + 每 PR 可独立 revert。

## 7. 范围围栏

- 不动 speech/general/business/medical/interview
- 不实现文档/合同文件解析（录音转写之外的输入源为独立立项）
- v1 不接 MCP 实时法条查询（L4 可选增强）
- 报告尾注免责声明必须保留（法律合规），任何提示词/Skill 迭代不得移除
- 不做法律意见生成——定位是"沟通记录与风险提示"，非法律咨询答案
