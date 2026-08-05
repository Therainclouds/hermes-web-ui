# 群聊自由讨论模式（Discussion Mode）

## 设计决策（已确认）

- 收敛机制：**LLM 裁判评估**（每轮结束一次轻量调用判断共识），配合轮次/消息/token 硬上限兜底
- 发言调度：**逐位顺序发言**（后发言者可见本轮前面所有发言）
- 讨论消息以普通群消息形式流式出现在房间里（复用现有流式与渲染，前端改动最小）
- 讨论期间暂停房间的 @ 提及路由，避免两条驱动路径竞争

## 服务端改动

### 1. 数据表 `packages/server/src/db/hermes/schemas.ts`

按现有 `GC_*_SCHEMA` + `syncTable()` 模式新增 `gc_discussions`：

| 列 | 说明 |
|---|---|
| id (PK) / roomId | 会话与房间 |
| goal TEXT | 讨论目标 |
| agentOrder TEXT | 发言顺序 JSON（agent id 数组） |
| reporterId TEXT | 汇报 agent（默认顺序第一位，可在发起时指定） |
| maxRounds / maxMessages | 硬上限（默认 8 轮 / 60 条） |
| judgeProfile / judgeProvider / judgeModel / judgeApiMode | 裁判模型配置（默认沿用房间 summary 四元组，可覆盖） |
| status TEXT | pending / running / paused / converged / max_rounds / stopped / failed |
| currentRound / judgeNotes TEXT | 进度与裁判每轮评估记录 |
| createdAt / updatedAt | 时间戳 |

### 2. 讨论调度器（新文件）`packages/server/src/services/hermes/group-chat/discussion.ts`

状态机循环 `runDiscussion(roomId)`：

1. 取房间内按 `agentOrder` 排序的 AgentClient（`agentClients.getAgents(roomId)`）
2. 每轮逐位发言：构造合成 `MentionMessage`（content 注入「讨论目标 + 裁判上轮评估 + 最近发言」提示，`role: 'user'`、`senderName: '讨论主持'`），调用 `agent.replyToMention(roomId, msg, runtimeContext, onStatus)`——与现有 `_drainRoomQueue` 同款驱动路径，自动走流式输出与滚动摘要上下文
3. 单 agent 超时（默认 3 分钟）跳过并计数，不阻塞整轮
4. 每轮结束调裁判：复用 `room-summary.ts` 的 `createModelClient` + `resolveModelProviderConfigs` 模式（`ekko-agent/src` 导出），要求裁判输出严格 JSON `{ converged: boolean, assessment: string, suggestion: string }`
5. 终止条件（任一满足即停）：
   - `converged === true` → 进入汇报阶段
   - `currentRound >= maxRounds` 或消息数超 `maxMessages` → 强制汇报（status=max_rounds）
   - 停滞检测：本轮全体发言与上轮语义高度雷同（裁判 assessment 判定原地打转）连续 2 轮 → 强制汇报（提示词中要求裁判识别）
6. 汇报阶段：以合成消息驱动 reporter agent 生成统一意见报告发到房间，写入 gc_discussions 终态
7. 全程状态变更经 Socket.IO `discussion_update` 事件广播；`finally` 保证锁释放与状态落库，进程重启后 running 状态会话自动标记 failed（不做断点续跑）

并发保护：每房间讨论锁，讨论 running 期间挂起该房间 `_mentionQueue` 路由（在 `handleMessage` 的 `shouldRouteMentions` 处加讨论锁判断），结束时恢复。

### 3. API `packages/server/src/routes/hermes/group-chat.ts` + controller

- `POST /api/hermes/group-chat/rooms/:roomId/discussion` — 发起：body `{ goal, agentOrder?, maxRounds?, maxMessages?, reporterId?, judge?: {profile,provider,model,apiMode} }`；校验目标非空、参与 agent >= 2、房间无进行中讨论
- `GET /api/hermes/group-chat/rooms/:roomId/discussion` — 查询当前/最近会话状态（含 judgeNotes 轮次记录）
- `POST /api/hermes/group-chat/rooms/:roomId/discussion/stop` — 人工终止（触发强制汇报）
- 权限与现有路由一致（canManage 房间管理者）；请求处理放 controller，路由保持薄

### 4. i18n

所有新字符串（发起面板、状态文案、裁判/汇报消息前缀等）加入全部 locale 文件（zh / zh-TW / en 等，遵循 AGENTS.md 硬规则）。

## 客户端改动

- `packages/client/src/stores/hermes/group-chat.ts`：新增 discussion 状态字段、API 封装、`discussion_update` socket 事件监听
- `GroupChatPanel.vue`：房间设置区新增「发起自由讨论」入口；发起面板（目标 textarea、轮次/消息上限、发言顺序与汇报 agent 选择、裁判模型默认跟随房间摘要配置）；讨论进行中横幅（轮次进度、裁判结论、停止按钮）；讨论消息本身即普通群消息，无需渲染改动
- 讨论主持/裁判消息带「系统」风格标识（复用现有系统消息样式）

## 测试计划

- `tests/server/group-chat-discussion.test.ts`：
  - 发起校验（目标为空、agent < 2、重复发起 409）
  - 调度：2 agent x 2 轮顺序发言，断言调用顺序与注入提示
  - 收敛路径：裁判 mock 返回 converged → 触发汇报且 status=converged
  - 防死循环：裁判永不收敛 → maxRounds 触顶强制汇报；停滞 2 轮强制汇报；单 agent 超时跳过
  - stop API 人工终止
  - 讨论期间 @ 路由被挂起、结束后恢复
- 回归：`group-chat-agent-routing-baseline` / `group-chat-member-sync` 等现有套件保持通过
- 收尾：`npm run harness:check`、相关 vitest、`npm run build`

## 假设与边界

- 不做讨论断点续跑（重启即失败终止，可手动重发）
- 裁判模型调用失败按"未收敛"处理继续下一轮，连续 3 次裁判失败则终止并报错
- 不修改现有 @ 提及链路与 mentionDepth 机制，讨论模式是独立叠加层
- 工作量预估：服务端约 600-800 行 + 测试，客户端约 300-400 行