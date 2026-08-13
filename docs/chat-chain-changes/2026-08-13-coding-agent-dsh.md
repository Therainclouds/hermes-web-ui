---
date: 2026-08-13
pr: pending
feature: 新增第三个编程工具 DeepSeek Harness (dsh) 的聊天会话接入
impact: 聊天会话可选择 DeepSeek Harness 作为 coding agent 运行 headless 单次任务；会话身份 `agent` 新增 `dsh` 值，历史会话归类与会话模型选择器同步识别。
---

## Coding agent: DeepSeek Harness (dsh)

将 DeepSeek Harness（`@deepseek-ai/dsh` CLI，`dsh --profile headless "<task>"`）
作为第三个 coding agent 接入聊天会话链，与 claude-code / codex 共用同一套
scoped/global 启动、run manager 与 socket 事件链路。

服务端：
- `services/coding-agents.ts`：`CodingAgentId` 与工具/配置定义新增 `dsh`；
  scoped 启动写入隔离 `DSH_HOME` 的 `settings.yaml`（`llm-deepseek` + `agent-default-model`），
  仅支持 `chat_completions` 协议；`startCodingAgentRun` 会话身份映射加 `dsh`。
- `coding-agent-run-manager.ts`：`isPrintAgent` 加入 `dsh`，新增 `startDshPrintTurn`——
  每次 send 起一个 `dsh --profile headless "<input>"` 子进程，exit 后把 stdout
  最终文本作为单条 assistant 回复（非流式）写入会话；非零退出以
  `DeepSeek Harness exited with code N: <stderr>` 标记失败。usage 记录跳过
  （headless 不返回 token usage）。
- `handle-coding-agent-run.ts` / `run-chat/types.ts`：`ChatCodingAgentId` 加 `dsh`，
  socket 的 `coding_agent_id: 'dsh'` 正确路由；dsh 不注入 Hermes 系统提示
  （避免与 dsh 自身 persona 冲突）。
- 会话归类辅助（`sessions.ts` / `session-command.ts` / `workflow-manager.ts`）同步
  把 `agent === 'dsh'` 视为 coding agent 会话。

客户端：
- `api/coding-agents.ts` 类型加 `dsh`；`CodingAgentsView` 增加 DeepSeek Harness 块
  （安装/状态/删除/配置编辑/启动，启动协议固定为 Chat Completions）。
- `ChatPanel` / `chat` store / `MessageList` / `SessionListItem` / `RealtimeVoiceStage`
  / `HistoryView` 的 agent 选项、身份映射与图标（`coding-agents/dsh.svg`）加入 dsh。

限制（已在 UI 文案说明）：headless 非流式、每轮新会话、需要 Node >= 22.19 与
`DEEPSEEK_API_KEY`（或 scoped provider 的 apiKey）。

测试：`coding-agents-launch.test.ts`（scoped DSH_HOME settings / 协议拒绝 / global）、
`handle-coding-agent-run.test.ts`（dsh socket 映射且不带系统提示）、
`coding-agent-run-manager-windows.test.ts`（cmd shim 启动、stdout→回复、非零退出失败）。
