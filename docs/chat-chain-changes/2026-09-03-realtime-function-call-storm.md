---
date: 2026-09-03
pr: pending
feature: Fix realtime agent-mode function-calling storm — tool arguments no longer lost (query_hermes_agent {} loop), TTS no longer chopped by retry cycles
impact: (1) realtime（OmniRealtimeStage agent 模式 / SpeechPracticeStage 口语对练）里模型发起工具调用时，真正带参的那份 `response.function_call_arguments.done` 不再被「先到的空参 conversation.item.created」顶掉——Python 代理改为按 call_id 仲裁：空参占位先扣住，带参副本到达立即转发，响应边界（response.done/error）再释放仍未等到参数的无参工具（如 list_jobs）；同时 arguments 若以 JSON 对象下发会被规整成 JSON 字符串，客户端不再把对象参数当 `{}` 执行。(2) 客户端按下发工具 schema 校验必填参数（query_hermes_agent.question 等），缺参不执行并回明确错误；同一坏参数连续 N 次 → 判定无效重试循环，返回停止指令，不再让模型无限重试同一空参调用（每次重试都是一轮新 response，TTS 发声被反复打断）。(3) 移除 realtime 共享指令里「不要调用 query_hermes_agent」的笼统禁令——它与工具守则/工具列表自相矛盾，是模型发出退化空参调用的诱因之一；改为「一问一答式短查询可用且必须带完整 question，文件/写盘/长任务仍引导回文字对话页」。
---

# realtime function calling 风暴修复：query_hermes_agent {} 死循环 + 发声被打断

## 用户报告的现象

realtime agent 模式（新建对话 → realtime → agent）里让模型「查一下这台电脑的内存」：

```
Yes, I can use the terminal. What would you like me to run or check?
Could you check this comp computer with the, like a, RAM.
query_hermes_agent  参数 {}   →  {"error": "question 必填"}
query_hermes_agent  参数 {}   →  {"error": "question 必填"}
（……同一空参调用反复出现十几次）
```

模型（DashScope qwen3.5-omni-*-realtime）反复用空参数调用同一个工具，每次失败
后重试同一调用——期间 AI 发声被一轮轮新 response 反复掐断（「调用 terminal 之后
发声一直在被打断」）。

## 根因（三层，逐一修复）

### 1. 真正带参的 function_call 被「空参占位」顶掉（Python 代理）

DashScope 对一次模型工具调用会广播两份事件：

- `conversation.item.created`（协议记账；arguments 可能在模型生成中途为空）
- `response.function_call_arguments.done`（规范事件，携带最终 arguments）

`main.py` 的旧逻辑按 call_id「先到先得」去重——若空参的 item.created 先到，它被
直接转发给客户端，而真正带参的 `.done` 被判为重复丢掉。客户端于是用 `{}` 执行
`query_hermes_agent` → `question 必填` → 模型（自认已经给了参数）重试同一调用 →
死循环。`omni_realtime_proxy.py` 对 `.done` 的翻译只透传原始字段：若 DashScope
以 JSON **对象**（而非 OpenAI-Realtime 规定的 JSON **字符串**）下发 arguments，
浏览器端 `typeof msg.arguments === 'string' ? … : '{}'` 也会把对象吞成 `{}`。

修复：
- `omni_realtime_proxy.py`：新增 `_as_arguments_json()` —— arguments 一律规整为
  JSON 字符串（对象 → `json.dumps(ensure_ascii=False)`），两种事件都走它；
- 新增 `FunctionCallGate`（按 call_id 仲裁）：带参 announcement 立即转发并记入
  `_sent`；空参 announcement 先 park 在 `_parked`；同 call_id 的带参副本到达 →
  替换并立即转发；响应边界（response.done / error，翻译后的 `response_done` /
  `error` 帧）时 flush 仍 park 的调用（合法无参工具如 `list_jobs` 照常执行）。
- `main.py` `/ws/omni-realtime` pump：用 `FunctionCallGate` 替换 `seen_call_ids`
  先到先得去重，边界帧先 flush park 再下放，客户端仍按 function_call →
  response_done 的自然顺序收到事件。

### 2. 客户端兜底护栏（useOmniRealtime）

即使代理已修复，也保留客户端纵深防御（防旧版代理 / DashScope 真发空参）：

- 新增纯函数模块 `packages/client/src/utils/omni-tool-call-guard.ts`：
  - `normalizeToolArguments`：对象参数重新字符串化，不再退化成 `{}`；
  - `parseToolArgsJson` / `missingRequiredArgs`：按实际下发（options.tools）的
    schema 校验必填参数（query_hermes_agent.question、read_skill_detail 的
    category+skill 等）；
- `handleFunctionCall`：缺必填参 → 不执行，回明确错误（模型可带全参数重新提问）；
  同一工具 + 完全相同参数连续 ≥3 次缺参 → 判定无效重试循环，回「停止重试、改为
  口头说明/确认」指令，不再让循环每轮空转（每轮都是一次新 response 掐断上一轮
  音频）。计数按会话重置：用户新发言 / 参数补齐的健康调用都会清零。

### 3. 指令自相矛盾（realtime-instructions.ts / practice-mode.ts / omni-tools.ts）

共享指令 `REALTIME_SUPPLEMENT` 笼统写着「不要调用 query_hermes_agent」，而
`TOOL_REFERENCE` / `TOOL_RULES` 又写「涉及工作台数据或工具操作时必须调用工具」，
且工具列表仍把 `query_hermes_agent` 下发给模型（口语对练场景甚至显式解除该
限制）——模型在「该不该调用」之间摇摆，是发出退化空参调用的诱因之一。

修复：把禁令改为模式一致的用法指引——「一问一答式短查询（查内存/端口、读文件、
跑命令）可以调用，但必须整理成完整 question，禁止空参；文件/写盘/长任务这类
产物给不到语音里的操作，才直接引导用户回文字对话页」；`query_hermes_agent` 工具
描述同样补上「question 必填、禁止空参、不具体就先口语确认」。practice-mode 里
引用旧禁令的文字同步改写，不再指向一条已删除的规则。

## 验证

- `tests/python/test_omni_realtime_proxy.py`：新增 10 组单测——arguments 字符串
  透传 / 对象规整 / 缺失默认 `{}`；FunctionCallGate 立即转发带参 / 空参 park 后被
  带参副本替换 / 边界 flush 合法空参 / 已发送后重复丢弃 / 多 call_id 独立 park。
- `tests/client/omni-tool-call-guard.test.ts`（新）：`normalizeToolArguments` /
  `parseToolArgsJson` / `missingRequiredArgs`（对照真实 `OMNI_REALTIME_TOOLS`）。
- `tests/client/utils/realtime-instructions.test.ts`：指令不再含笼统禁令、含「禁止
  传空参数」与「可以调用 query_hermes_agent」、文件类产物仍引导回文字页。
- `tests/server/omni-realtime-wiring.test.ts`：新增 guardrail 段落——代理规整
  arguments、main.py 用 FunctionCallGate（且旧 `seen_call_ids` 已移除）、composable
  接入护栏常量与循环熔断、共享指令与工具列表不再自相矛盾。
