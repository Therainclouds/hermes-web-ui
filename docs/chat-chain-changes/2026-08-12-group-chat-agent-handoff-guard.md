---
date: 2026-08-12
pr: pending
feature: 群聊 agent 互 @ 接力熔断（防自我介绍/寒暄引发的无限回复循环）
impact: 房间内 agent 回复触发的 @接力有次数上限（默认 8 次），超限后 agent 回复不再路由给其他 agent；人类 @mention 不受影响。
---

## Group chat agent handoff guard

真实设备冒烟发现：让房间内 5 个 agent 自我介绍后，agent 回复互相 `@名字`
（自我介绍确认、状态寒暄）形成扇出式无限回复循环——13 分钟内 46 条 agent
消息、仅 1 条人类消息，服务 CPU 持续 30%+。原 `maxAgentMentionDepth=4`
只限制单条链深度，不限制房间内 agent→agent 接力总量。

修复（`agent-clients.ts` `processMentions`）：
- 新增房间级计数 `_roomAgentHandoffs`，agent 回复携带 @ 时计数 +1；
- 超过 `MAX_AGENT_HANDOFFS_PER_ROOM`（默认 8，类静态常量）后，agent 回复中的
  mention 直接丢弃（记 warn 日志），不再入队；
- 人类消息（`role='user'`）的 @mention 永不受限；
- 房间断开/清空时重置计数（`clearMentionQueuesForRoom`）。

Prompt 侧同步强化（`context-engine/prompt.ts` buildAgentInstructions）：
- 明确禁止自我介绍/就位确认等例行消息 @ 其他成员；
- 告知 agent 群聊存在接力预算，多用 @ 会消耗预算。

测试：`tests/server/group-chat-agent-handoff-guard.test.ts`（预算耗尽丢弃 /
人类消息不受限 / 房间清空重置）。设备已热部署验证循环停止。
