# 口语对练 Skill 框架设计（v2：跨场景通用 + 同会话收尾总评 + 素材清单证据）

> 状态：框架设计。目标：让「实时口语对练」从**语言学习专用**升级为
> **任意对话陪练/测评场景**的通用模块（语言、销售、面试、知识点掌握、演讲、
> 客服、谈判……），场景逻辑全部由「练习技能（practice skill）」声明。
> 技能 = 带 `hermes_practice` 契约的普通 SKILL.md（复用现有技能页下载/导入/编辑）。

## 1. 场景全景（先想全，再抽象）

实时对练本质 = **角色扮演式对话陪练 + 结构化评估**。按「评估对象」与「对话形态」
两个轴展开：

| 场景族 | 例子 | 对话形态 | 评估对象（维度示例） |
| --- | --- | --- | --- |
| 语言学习 | 雅思/托福/通用口语 | 自由对话/话题卡/问答 | 流利、发音、语法、词汇、内容 |
| 销售培训 | 新品话术、异议处理、逼单 | 角色扮演（顾客/销售） | 产品讲解、需求挖掘、异议应对、促成、亲和力 |
| 面试陪练 | 行为面/技术面/小组面 | 一问一答（考官） | 结构、STAR 完整度、岗位匹配、表达、抗压 |
| **知识点掌握测评** | 数学/物理/历史/编程概念 | 苏格拉底式追问 | 概念准确、推理过程、术语、应用迁移、卡点定位 |
| 演讲/汇报 | 项目汇报、路演、晨会 | 陈述+观众提问 | 结构、逻辑、感染力、时间控制、答疑 |
| 客服/服务 | 投诉处理、售前咨询 | 角色扮演（客户） | 倾听、共情、方案、话术合规、闭环 |
| 医疗/心理话术 | 问诊话术、共情沟通 | 角色扮演（患者/来访者） | 问诊完整度、共情、边界、术语通俗化 |
| 法律/合规沟通 | 合同解释、风险告知 | 角色扮演（客户） | 准确性、风险提示、免责话术、证据意识 |
| 谈判/汇报式 | 商务谈判、向上汇报 | 回合制攻防 | 目标坚持、让步策略、信息确认、节奏 |
| 语言水平口试 | 剑桥口试、等级口语 | 考官流程（分part） | 按考试量表 |
| 复盘/反思 | 事后复盘表达 | 引导式提问 | 归因、行动项、情绪管理 |

共性（因此才值得一个通用框架）：

1. **一个对话结构**：模型扮演对方/考官/引导者，用户开口若干轮，模型每轮或每阶段
   给出口头反馈；结束时给结论与建议。
2. **一套评估协议**：按技能声明的维度打分（1–10 或技能自定义量表），分数要能进
   表格、能聚合、能入报告——即现在的 `submit_practice_feedback` 工具通道。
3. **两种素材复用**：实时中模型已"听/看"到用户语音与画面（同会话上下文）；
   结束后可选把录音/画面再次离线喂给全模态模型做深度书面分析。
4. **一份可下载报告**：逐轮点评 + 综合分 +（可选）深度分析 + 下阶段建议。

## 2. 练习技能契约（schema 1，跨场景版）

```markdown
---
name: en-ielts-speaking-part2
description: 雅思口语 Part 2 一分钟话题卡陈述对练（考官式点评）
tags: [practice]
hermes_practice:
  schema: 1

  # —— 场景/入口 ——
  scene: language            # 可选标签：language|sales|interview|knowledge|presentation|custom
  targetLanguages: [en]      # 空=不限语言（跟随用户选择）
  directions: ["雅思口语 Part 2 话题卡陈述"]
  entry:
    label: 雅思 Part 2 考官
    hint: 考官式提问 + 卡点计时 + 高分表达示范

  # —— 角色与对话结构（前置提示词）——
  coach:
    soul: "你是雅思口语 Part 2 考官兼陪练……"     # 覆盖默认教练人格
    role: 考官                                   # 模型扮演的角色
    userRole: 考生                               # 提示用户扮演的角色
    interaction: qa            # free|qa|roleplay|scenario_card|timed_turns
    plannedTurns: 12           # 可选：建议轮数节奏
    extraRules:
      - "Part 2 陈述期间不要打断用户。"

  # —— 评价对象与维度（每档 rubric + 权重 + 量表）——
  evaluation:
    scale: { min: 1, max: 10, step: 1 }   # 可自定义（如 1-5、A-E 用 1-5）
    dimensions:
      - id: fluency            # 语言技能可用既有 id 保持兼容
        label: 流利度
        description: 打给模型看的一句说明
        rubric: "1-3 大量停顿；4-6 偶有卡顿；7-8 基本流利；9-10 接近母语"
        weight: 0.25           # 仅加权/综合分用
      - id: content
        label: 内容与逻辑
        rubric: "……"
    # 打分逻辑：综合分怎么来
    overallMode: model         # model=模型每轮报 overall；weighted=维度加权合成；average=各轮 overall 平均
    resultBands:               # 可选：结论分档（知识点测评的“掌握度”）
      - { min: 8, label: 已掌握, description: 可独立应用 }
      - { min: 5, label: 部分掌握, description: 需要复习 xx }
      - { min: 0, label: 未掌握, description: 建议重新讲解 }

  reviewOnEnd: true            # 结束时是否先做“同会话口头总评”
  report:
    conclusion: true           # 是否要“结论/建议”固定小节
    omni:
      enabled: true            # 结束后的离线全模态深度书面分析
      requireAudio: false
      requireFrames: false
      instructions: "按雅思四项评分标准点评……"
---
（正文 = 人类可读说明 + 可选“技能背景”，注入深度分析提示词供模型参考。）
```

### 2.1 语言技能与默认技能的关系（向后兼容）

- 默认「通用口语教练」不依赖任何下载：维度 = 现状六个（流利/发音/语法/词汇/内容 +
  可选肢体语言），`overallMode: average`、10 分量表——行为与当前版本逐字节一致。
- 语言类技能建议复用六个标准 id（`fluency/pronunciation/grammar/vocabulary/content`），
  平台仍按旧键渲染报告表格与实时评分卡，零额外成本。
- 跨场景技能使用自定义维度 id；客户端运行时按技能的 `dimensions[]` 动态生成
  `submit_practice_feedback` schema、评分卡、报告表头与聚合逻辑（见 §4）。

### 2.2 语言绑定的 UI 行为（新增需求）

- 技能声明 `targetLanguages: [en]`：新建对话里选中技能后，语言下拉**过滤为仅 en 并
  自动选中 en**；只声明一个语言时下拉禁用并提示「该技能固定使用 {language}」。
- 技能不声明（空数组）= 跟随用户选择（默认技能行为）。
- 回到「通用口语教练」恢复四语言自由选择。
- 语义上"语言"即"本场对话使用的语言"：销售/知识点等场景若在中文语境进行，
  填 `[zh]`（或留空让用户自选）即可，不必绑定"语言学习"语义。

## 3. 评价对象/打分逻辑如何进"报告与实时"

统一抽象（运行时，纯函数模块 `practice-skill.ts`）：

```
PracticeSkill
 ├─ identity: kind/category/name/displayName/description
 ├─ coach: soul/role/userRole/extraRules/interaction/plannedTurns
 ├─ evaluation: scale{min,max,step}, dims[ {id,label,description,rubric,weight} ],
 │              overallMode, resultBands
 ├─ language: targetLanguages[]
 ├─ end: reviewOnEnd
 └─ report: conclusion/omni{enabled,requireAudio,requireFrames,instructions}/background
```

- `dimensions[]` → 生成实时工具 schema（`submit_practice_feedback` 参数 properties 按
  技能维度动态拼，`overall` 与文本字段固定保留；scale 注入 minimum/maximum）。
- 逐轮打分记录统一为 `scores: { [dimId]: number } + overall + comment/strengths/
  improvements/example`；语言类技能仍保留既有六个字段别名，UI/报告按维度表取数与渲染。
- 综合分：`overallMode=model` 用模型每轮给的 overall 求均值；`weighted` 按技能权重
  合成；`average` 现默认行为。`resultBands` 给出结论文字（如"已掌握/部分掌握"）。
- 报告章节固定骨架：头部（语言/方向/难度/技能/素材证据）→ 一、综合评分（按技能
  维度表格 + 结论档位）→ 二、逐轮点评 → 三、对话记录 → （同会话口头总评并入二/三）
  → 四、AI 深度分析（可选）→ 附、技能与评价标准（下载技能时）→ 结论/建议（技能声明时）。

## 4. 整个项目的模块逻辑（运行时数据流）

```
SKILL.md ──(服务端解析 frontmatter, js-yaml, schema=1 校验)──▶ GET /api/hermes/skills/practice
                                                                        │ { category,name,description,enabled,source,manifest }
ChatPanel 新建对话 ▸ realtime ▸ 口语对练
   ├─ 练习技能下拉：默认「通用口语教练」+ 已下载技能（展示 entry.label/hint）
   ├─ 选中技能 → 语言下拉收敛/自动切换（targetLanguages）
   ├─ 难度/方向/时长照旧（方向可用技能 directions 做占位提示）
   └─ PracticeSessionConfig{ language,direction,difficulty,durationMinutes, skillRef{category,name} }
        │  localStorage v2（per-session），重开历史会话时按 skillRef 重新拉取解析
        ▼
SpeechPracticeStage（mount）
   └─ fetchPracticeSkills() → resolve skill（找不到→回退默认技能并提示）
        │
        ├─ connect(): instructions = buildRealtimeInstructions(skill.coach.soul, { scenario:
        │     buildPracticeInstructionBlock(config, {cameraOn, skill}) })
        │     工具 = [...工作台工具, buildSubmitPracticeFeedbackTool(skill)]
        ├─ 对练中：submit_practice_feedback 逐轮打分 → 评分卡（技能维度渲染）
        ├─ 素材收集：用户轮语音 WAV（VAD 驱动）+ 摄像头帧（1fps 抽样）
        │
        ├─ 结束路径（手动/倒计时/返回）：
        │    a. 用户未口头收尾 & 连接存活 & skill.reviewOnEnd
        │        → drainOutput() → omni.askText(收尾总评指令)（同一 WS，复用已看/已听上下文）
        │        → 教练口头总评 + submit_practice_feedback(整场分) → 转写即“同会话总评”
        │    b. disconnect() → finalizeSession()
        │    c. 离线全模态（media manifest 计数决定，见 §5）
        └─ 保存报告 → 聊天会话出现“报告+下载”消息（含素材证据行）
```

## 5. 素材清单证据（media manifest）——让"报告不是纯文字"可验证

- 结束面板 AI 状态行实时显示 `正在听 N 段录音 · 看 M 帧画面（qwen3.5-omni-flash）`；
  无素材时显示 `本次未采集到录音/画面 → 跳过全模态，报告基于文字与逐轮评分`。
- 最终 md 报告头部 blockquote 固定写素材证据行：
  `> 练习素材：录音 9 段 + 画面 6 帧（已开启摄像头，仅存于本机内存）`
  或 `> 练习素材：本次未采集到录音/画面……`；
  AI 章节是否存在，即“深度分析是否真的跑了”的天然证据。
- SSE 首帧 `{type:"meta", audioSegments, frames, cameraOn}` 双保险（以服务端校验后
  实际入请求数为准）。
- 聊天会话的报告下载消息带同一行说明，用户回到会话即可确认。

## 6. 同会话收尾总评（复用 WS 上下文，不开新窗口）

- 技术结论：Qwen-Omni-Realtime 链路 AI 文本 = 模型语音的 ASR 转写，无干净打字通道；
  因此同会话收尾是**教练口头总评（转写）**，适合结构化短评，不适合长 Markdown。
- python 代理新增 `{"type":"text","text":…}` 帧 → `conversation.item.create`
  （`input_text`）+ `response.create`；客户端 `useOmniRealtime.askText()`：
  闭麦（防回声打断）→ 发帧 → 收集下一段 assistant 转写 → 超时/错误即放弃
  （不阻塞离线兜底）。
- 时机：倒计时到点/手动结束/返回，且连接存活、用户说过话、末句不是口头收尾语。
- 口头总评进入转写与报告（二/三章节），结束面板与聊天消息不另起重复章节。

## 7. 向后兼容与落地顺序

1. `practice-skill.ts` 运行时 + 默认技能 + 语言技能六维兼容路径（不破坏现网行为）。
2. 服务端 `GET /api/hermes/skills/practice`（解析 frontmatter、schema=1 校验、
   target=hermes、本地+外部目录、禁用/归档过滤）。
3. ChatPanel 技能下拉 + 语言绑定/收敛 + skillRef 持久化（localStorage v2，兼容 v1）。
4. Stage 按技能接入（connect/工具/评分卡/报告）→ 语言技能零感知、跨场景技能可用。
5. 素材证据 + SSE meta + 同会话收尾总评（代理 text 帧）。
6. 示例技能包（内置安装先例：meeting-asr skill-resolver 自动安装）：雅思 Part 2、
   新品销售角色扮演、行为面试、知识点掌握测评（苏格拉底追问 + 掌握度分档）。
7. i18n 11 语言 + 单测（client/server/python）+ wiring 锚点 + harness:check +
   docs/chat-chain-changes 变更文档。
