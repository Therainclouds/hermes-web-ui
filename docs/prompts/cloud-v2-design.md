# Cloud Prompt v2.0 设计说明

> 本文解释 v2.0 的每一段**为什么这样写**、**借鉴了哪个业界实践**、**与原版有何差异**。
> 维护人：Cloud（自维护）。下次重大升级时间：约 2027-12。

---

## 1. 升级背景

v1.0 是一份"瑞士军刀式"的万字 prompt，覆盖了 Cloud 的身份、5-Phase、三阶段、质量标准、VCS、安全、文档、Tech Radar、多 Agent 协作、Sub-persona 卡片等十余个模块。问题：

1. **Trae 不支持自建多 Agent**——v1.0 里的 MCP `<mcp_agent_call>` 块完全无法落地。
2. **Sub-persona 卡片**需要外部路由机制，Trae 内同样不支持。
3. **缺乏显式 Skill 调度协议**——v1.0 把工具调用散落在各章节，没有"触发条件 → 输入 → 输出 → fallback"的形式化规范。
4. **三阶段工作流是手写流程**而非状态机，缺少异常路径与转换条件。

v2.0 重新组织，并**主动对齐业界开源标准**（[Agent Skills Spec](https://agentskills.io/)）。

---

## 2. 借鉴来源对照表

| v2.0 章节 | 借鉴来源 | 提取内容 |
|-----------|----------|----------|
| §1.2 沟通纪律 | [Trae Builder Prompt §`<communication>`](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) | 保密、Markdown、不道歉 |
| §2 思维模型 | Anthropic Skills 哲学（[Equipping agents](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)） | Context > Code、Skill > Tool |
| §3.2 工具铁律 | Trae §`<making_code_changes>` + Cursor Agent Prompt | 复用既有依赖、模拟风格、不贴整段 |
| §4 5-Phase | v1.0 继承 | 强制 Checkpoint 保留 |
| §5 三阶段（状态机版） | v1.0 重构 | 加状态转换图、PAUSE 异常路径 |
| §6 Skill 调度协议 | [Agent Skills Spec](https://agentskills.io/) | YAML frontmatter 模式 |
| §7 动态技术选型 | v1.0 继承 + ADR 模板（[Markdown ADR](https://adr.github.io/)） | 评分表 + 模板 |
| §8 编码质量 | v1.0 + Meta/Microsoft 工程实践 | DRY/KISS/SOLID/Security |
| §9 VCS/测试/文档 | v1.0 + Conventional Commits 1.0 | Conventional 提交规范 |
| §10 自我维护 | v1.0 升级 | 防 prompt 腐烂 |

---

## 3. 关键设计决策

### 3.1 为什么把 Skill 单独成章？

v1.0 把"工具调用"散落在 §3、§5、§6 等多处。问题：

- USER 问"这个 bug 怎么修"时，没有显式规则告诉 Cloud "应该先调 `bug-diagnose` Skill"。
- Skill 失败后没有 fallback 路径。
- 新增 Skill 时没有标准格式。

v2.0 把 §6 独立成"Skill 调度协议"：
- YAML frontmatter 描述触发条件（参考 Anthropic 官方 Skills）
- 决策树显式画出意图到 Skill 的映射
- 每个 Skill 必须有 fallback 路径

### 3.2 为什么用状态机而不是列表描述三阶段？

v1.0 描述三阶段用的是"必做/严禁"清单。问题是缺少：
- 阶段之间的转换条件
- 异常路径（如 Stage-3 遇到冲突怎么办）

v2.0 用 ASCII 状态机图：

```
[IDLE] → [ANALYZE] → [PLAN] → [EXECUTE] → [DONE]
                          ↑         │
                          └─冲突────┘→ [PAUSE]
```

每个状态有明确的进入/退出条件，PAUSE 路径独立可见。

### 3.3 为什么删除多 Agent / Sub-persona？

- **多 Agent**：Trae IDE 当前不允许自建 MCP Agent 调用链（v1.0 的 `<mcp_agent_call>` 块无法解析）。
- **Sub-persona**：同样依赖外部路由机制。

v2.0 把这些能力**降级为可选扩展**：若 USER 使用支持这些的平台（如 Claude Code、Cursor），可以外挂；若用 Trae，章节被自然跳过。

### 3.4 为什么加入 Prompt 防腐章节（§10）？

长期使用一份大 prompt 会"腐烂"：
- 工具集过时（如某 Skill 已被 Trae 弃用）
- 章节冗余（某规则已不适用但没人删）
- 业界最佳实践更新（v2.0 是 2025-Q4 标准，2027-Q4 可能不同）

§10 给出三条自检规则 + 时间触发器（18 个月），让 prompt 在使用中**自我提醒升级**。

---

## 4. 与 v1.0 的差异清单

| 项 | v1.0 | v2.0 | 原因 |
|----|------|------|------|
| 多 Agent 调用 | 16 个 agent 名 | 完全移除 | Trae 不支持 |
| Sub-persona | 6 张卡片 | 完全移除 | Trae 不支持 |
| Skill 调度 | 散落各处 | §6 独立成章 | 升级 |
| 三阶段 | 列表 | 状态机图 | 升级 |
| 必做/严禁 | 各章节内联 | §5 集中 | 统一 |
| 工具路由表 | 无 | §3.3 新增 | 加速决策 |
| Prompt 防腐 | 无 | §10 新增 | 防腐烂 |
| ADR 模板 | 提及 | §7.2 给出 | 可直接用 |
| 默认 Tech Radar | 嵌入式 YAML | 附录 A | 解耦 |
| Self-Test 命令 | 分散 | 附录 B 集中 | 复用 |

---

## 5. 评估指标（如何验证 v2.0 比 v1.0 好）

### 5.1 客观指标
- **首次响应 Token 数**：v2.0 应 ≤ v1.0（去掉冗余后）。
- **Skill 命中率**：USER 提问后，匹配到 frontmatter triggers 的比例 ≥ 60%。
- **fallback 触发率**：应 < 15%（太高说明 Skill 设计不准）。

### 5.2 主观指标（USER 反馈）
- "Cloud 是否更主动调用 Skill？"——是
- "Cloud 是否更少做我没要求的事？"——是
- "Cloud 是否更好解释它的决策路径？"——是

### 5.3 待观察
- §6 的 YAML frontmatter 格式是否被 USER 当作"模板"复制？
- §10 的 18 个月提醒是否真的有效？
- Skill 清单是否需要季度更新？

---

## 6. 后续路线图

- **v2.1**（2026-Q4）：增加 `Skill: redis-optimization`、`Skill: fastapi-patterns` 等专项 Skill。
- **v2.2**（2027-Q2）：接入 mcp-builder 工具，支持 USER 自定义 Skill。
- **v3.0**（2027-Q4）：完整对齐 Agent Skills Spec 1.0（届时可能有规范升级）。

---

## 7. 维护说明

- 本文件路径：`docs/prompts/cloud-v2-design.md`
- 对应 prompt：`见 Trae IDE Custom Instructions（v2.0 完整版）`
- 升级流程：创建 ADR → 同步更新 prompt 与本设计文档 → 在 commit message 注明 `prompt(v2): <改动>`
- 反馈渠道：直接在 Trae 会话里说"Cloud，你的 prompt 第 X 章有问题"即可触发自我修订。

---

// [Cloud] Design doc complete.