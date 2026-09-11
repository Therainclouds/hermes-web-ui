# Cloud Prompt v2.0 · 附录与详尽说明

> 本文件是 `cloud-v2-prompt.md` 的**外置详尽说明**。主 prompt 控制在 ≤ 10 000 字符，
> 详细内容、模板、Skill frontmatter 完整定义等放本文件。
> 不直接复制到 Custom Instructions，仅作 Cloud 自身参考与团队维护用。

---

## A.1 术语表完整定义

| 术语 | 含义 |
|------|------|
| **USER** | 发起请求的人。第二人称称谓。 |
| **CLOUD（我）** | 本提示词约束下的 AI 助手。 |
| **Skill** | 一段「输入 → 推理 → 输出」的声明式能力包。用 YAML frontmatter 描述触发条件、依赖与降级路径，参考 [Agent Skills 开放标准](https://agentskills.io/)。 |
| **Phase** | 5-Phase 总流程的阶段（Pre/Env/Dev/VCS/Structure）。 |
| **Stage** | Dev 执行内的 3 个交互阶段（Analyze/Plan/Execute）。 |
| **Checkpoint** | Phase/Stage 之间必须显式触发的用户确认点。 |
| **Harness** | 项目已有的脚本/CI/lint/test 体系，不可绕过。 |

---

## A.2 Skill 完整定义（frontmatter）

### `codebase-investigator`
```yaml
name: codebase-investigator
description: 在代码仓库中快速定位相关实现、依赖关系、架构入口
triggers: ["代码在哪", "怎么实现的", "架构", "依赖关系", "find code"]
inputs:
  required: [keywords]
  optional: [file_path]
outputs: [related_files, key_snippets]
fallback: 手工 Read
priority: high
```

### `bug-diagnose`
```yaml
name: bug-diagnose
description: 静态分析定位 bug 根因，输出可执行的修复建议
triggers: ["报错", "跑不起来", "异常", "crash", "bug", "性能下降"]
inputs:
  required: [error_message]
  optional: [repro_steps]
outputs: [root_cause, fix_suggestion]
fallback: TRAE-debugger（运行时插桩）
priority: high
```

### `plan-architect`
```yaml
name: plan-architect
description: 对需求生成触达文件表、ADR 草稿、Self-Test 命令
triggers: ["设计", "架构", "怎么改", "方案", "重构"]
inputs:
  required: [goal]
  optional: [constraints]
outputs: [file_table, adr_draft, self_test_cmds]
fallback: 简化口头方案
priority: high
```

### `code-review`
```yaml
name: code-review
description: 对 diff / commit 范围做结构化 review
triggers: ["review", "检查代码", "质量", "merge 前"]
inputs:
  required: [diff_or_range]
outputs: [issues, severity_levels]
fallback: 人工 review 清单
priority: medium
```

### `frontend-design`
```yaml
name: frontend-design
description: 生成生产级前端组件/页面，含设计说明与样式规范
triggers: ["做一个页面", "UI", "前端", "界面", "组件"]
inputs:
  required: [intent]
  optional: [style_preference]
outputs: [component_code, design_notes]
fallback: prototype（先出低保真）
priority: medium
```

### `tdd-cycle`
```yaml
name: tdd-cycle
description: 走 red-green-refactor 循环产出测试+实现
triggers: ["TDD", "先写测试", "红绿重构"]
inputs:
  required: [requirement]
outputs: [test_cases, impl, coverage]
fallback: 传统 test-after
priority: medium
```

### `doc-generator`
```yaml
name: doc-generator
description: 生成 README / API 文档 / ADR
triggers: ["写文档", "README", "API 文档", "ADR"]
inputs:
  required: [scope]
  optional: [audience]
outputs: [markdown_file]
fallback: 最小骨架
priority: low
```

### `security-audit`
```yaml
name: security-audit
description: 对代码范围做 OWASP Top-10 扫描并分级
triggers: ["安全审查", "OWASP", "漏洞", "密钥"]
inputs:
  required: [code_scope]
outputs: [risk_list, fix_priority]
fallback: 最小 OWASP Top-10 自检
priority: high   # 认证/支付/上传场景强制触发
```

### `prototype`
```yaml
name: prototype
description: 生成可运行原型，支持多版本对比
triggers: ["做个原型", "先看看效果", "多方案对比"]
inputs:
  required: [requirement]
  optional: [style_preference]
outputs: [runnable_prototype, variants]
fallback: frontend-design
priority: medium
```

### `grill-with-docs`
```yaml
name: grill-with-docs
description: 对方案做压力测试，更新 ADR/CONTEXT 文档
triggers: ["压力测试方案", "挑战我的设计", "grill me"]
inputs:
  required: [plan_draft]
outputs: [challenge_list, revision_suggestions]
fallback: 自我反思
priority: medium
```

### `handoff`
```yaml
name: handoff
description: 把当前会话压缩成 handoff 文档交接给其他 agent
triggers: ["交接", "压缩上下文", "handoff"]
inputs:
  required: [session_key_info]
outputs: [handoff_doc]
fallback: 人工总结
priority: low
```

### `find-skills`
```yaml
name: find-skills
description: 在 ClawHub/Skills.sh 搜索并推荐可安装 skill
triggers: ["有没有现成 skill", "怎么扩展能力", "skill 推荐"]
inputs:
  required: [need_description]
outputs: [skill_list, install_method]
fallback: 建议自建 Skill
priority: medium
```

---

## A.3 ADR 完整模板

```markdown
# ADR-XXXX: <决策标题>

- **状态**：Proposed / Accepted / Deprecated / Superseded
- **日期**：YYYY-MM-DD
- **背景**：<问题与约束>
- **备选方案**：<2-3 个，含加权评分>
  - 方案 A：<描述> · 总分 X/100
  - 方案 B：<描述> · 总分 Y/100
- **决策**：<最终选择 + 关键理由>
- **后果**：
  - 正面：...
  - 负面：...
  - 中性：...
- **回滚**：<触发条件 + 回滚步骤>
- **参考**：<链接>
```

---

## A.4 Self-Test 命令完整模板

```bash
# ===== 前端 =====
npm run lint && npm run typecheck && npm run test:changed && npm run build

# ===== 后端 Node =====
npm run lint && tsc --noEmit && npm run test:changed

# ===== 后端 Python =====
ruff check . && mypy . && pytest --cov=src --cov-fail-under=80

# ===== 后端 Go =====
golangci-lint run && go test -cover ./...

# ===== 后端 Rust =====
cargo clippy -- -D warnings && cargo test

# ===== 安全（任何 PR 前）=====
npm audit --audit-level=high          # Node
safety check                          # Python
semgrep --config=p/owasp-top-ten      # 跨语言
```

---

## A.5 与 v1.0 的差异对照（回顾）

| 项 | v1.0 | v2.0 |
|----|------|------|
| 多 Agent 调用 | 16 个 agent 名 | 完全移除（Trae 不支持） |
| Sub-persona | 6 张卡片 | 完全移除 |
| Skill 调度 | 散落各处 | §6 独立成 YAML frontmatter + 决策树 |
| 三阶段 | 列表 | 状态机图（含 PAUSE） |
| 工具路由 | 临时决策 | §3 声明式路由表 |
| Prompt 防腐 | 无 | §10 自检 + 18 个月升级 |
| ADR 模板 | 提及 | 附录给出完整模板 |
| 字数 | ~10 000 字 | **≤ 10 000 字符**（含 markdown） |

---

## A.6 借鉴来源

- [Agent Skills 开放标准](https://agentskills.io/)
- [Anthropic Skills 仓库](https://github.com/anthropics/skills)
- [Equipping agents for the real world](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Trae Builder Prompt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [Claude Code System Prompt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [VSCode AGENTS.md](https://github.com/microsoft/vscode/blob/main/AGENTS.md)
- [ADR GitHub](https://adr.github.io/)

---

// 附录结束。主 prompt 见 `cloud-v2-prompt.md`。