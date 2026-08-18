# Spec: 群聊自由讨论改为"任务结果导向"（修复只跑 1 轮 + 防设备过载）

- **日期**: 2026-08-18
- **分支**: `merge/upstream-main-20260814`
- **涉及文件**:
  - `packages/server/src/services/hermes/group-chat/discussion.ts`（主要改动）
  - `tests/server/group-chat-discussion.test.ts`（测试更新）
- **目标设备**: 阿曼 RK35xx（10.0.0.2:6060，4 核 / 3.9GB RAM / zram 1.9GB）

## 1. 背景与问题

### 1.1 用户痛点

群聊"自由讨论"（DiscussionRunner）实际运行中任何任务**只跑 1 轮就停止**，
无法实现"多个 agent 围绕任务多轮协作直到产出交付结果"的自动化。

### 1.2 根因分析（实测证据）

设备上"许-测试1"最近一次讨论（`disc_mswrngopa4wtvd`，08-17 13:01 发起，
早于修复部署）：

- 参数：`maxRounds=8, maxMessages=60, minRounds=0`，5 个 agent
- 第 1 轮循环期间恰好产生 **60 条消息**（default 15 + guanzhong 9 + jiran 10
  + wenxin 14 + zimo 11 + 裁判系统消息 1 = 60）
- 循环检查 `messagesSinceStart() >= maxMessages`（`>=`，等于即触发）→ 第 2 轮
  未开始即以 `max_rounds` 终止

**根因**：`maxMessages` 预算统计的是**所有消息**（含 `role='tool'` 的工具调用
消息和空 assistant 占位消息）。5 个 agent 每轮做多次工具调用，每条工具调用产生
assistant+tool 两条消息，**第 1 轮就把 60 条预算耗尽**。该预算与"任务是否完成"
无关，纯粹是拍脑袋的消息条数限制。

### 1.3 历史修复的误诊

提交 `b80cee40` 移除了"软上限扩展"机制（`DISCUSSION_MAX_EXTEND_ROUNDS` /
`extensionUsed`），但那**不是**当时只跑 1 轮的触发点——该机制只在
`currentRound >= maxRounds` 时才会生效，而当时只到第 1 轮。真正元凶是
`maxMessages=60` 消息预算，该检查在修复后原样保留，所以**问题并未解决**。
（`tests/server/group-chat-discussion.test.ts` 中还残留 3 个针对已删除
extension 机制的用例，当前 2 个失败，需同步清理。）

## 2. 目标

让讨论**以任务结果为导向**：

1. **讨论不再因"消息条数"假终止**——`maxMessages` 预算只统计实质发言
   （排除 tool 消息和空占位消息），并提高默认值作为安全兜底。
2. **以裁判收敛判定为主终止条件**——在产出明确交付结果（裁判连续 2 轮
   converged）之前不停止；`maxRounds` 仅作为防失控的硬上限（默认提高）。
3. **长讨论消息自动总结归档**——讨论进行中每 N 轮自动归档一次，原始消息
   落盘为 summary，上下文始终清爽（当前只在结束时且 ≥500 条才归档）。
4. **防止设备过载**——加全局并发限制（同时最多 1 场讨论），避免多房间
   叠加把 RK35xx 内存吃爆。

## 3. 现状盘点（代码事实）

- 终止条件（`discussion.ts` `runDiscussion` 循环）：
  - `interrupts`（停止）
  - `currentRound >= maxRounds` → `max_rounds`
  - `messagesSinceStart() >= maxMessages` → `max_rounds`（**问题点**）
  - 裁判 `converged` 连续 2 轮且 `currentRound >= minRounds` → `converged`
  - `stalledStreak >= 2` → `stalled`
- `messagesSinceStart()` = `getMessageCount(roomId) - startMessageCount`，
  其中 `getMessageCount` 是 `SELECT COUNT(*) FROM gc_messages`（**含全部消息**）
- 归档：`autoArchiveAfterRun` 仅在终止后调用一次，且
  `messageCount < DISCUSSION_AUTO_ARCHIVE_MIN_MESSAGES(500)` 时跳过
- 上下文窗口：`GROUP_CHAT_MESSAGE_WINDOW = 500` 条硬截断 +
  `summaryEveryTurns=20` 滚动总结（80k token 预算），单轮超时 10min /
  裁判 3min —— 上下文体积有界，不会无限增长
- 并发：`DiscussionRunner` 只有 per-room 锁（`locks` Map + `startingRooms`），
  **没有全局并发上限**
- 设备：4 核 / 3.9GB RAM（可用 ~2.4GB）/ 5 个常驻 hermes gateway 进程
  （~170MB each）+ Node 服务 + Chromium kiosk，已占 ~1.6GB

## 4. 方案设计

### 4.1 maxMessages 预算改为"只计实质发言"

在 `DiscussionRunnerDeps.storage` 增加方法：

```ts
/** 统计房间内“实质发言”消息数：排除 role='tool' 与空内容占位消息。
 *  工具调用管道消息（assistant 占位 + tool 结果）不计入讨论消息预算。 */
getSubstantiveMessageCount(roomId: string): number
```

- `index.ts` 的 `ChatStorage`（实现 `DiscussionStorage`）新增该方法：
  ```sql
  SELECT COUNT(*) FROM gc_messages
  WHERE roomId = ? AND role <> 'tool'
    AND (role <> 'assistant' OR TRIM(IFNULL(content, '')) <> '')
  ```
- `discussion.ts` 的 `messagesSinceStart()` 改用该计数（`getSubstantiveMessageCount`）。
- 兼容性：`DiscussionStorage` 接口方法设为可选（`getSubstantiveMessageCount?`），
  缺失时回退到 `getMessageCount`，测试桩不受破坏。

### 4.2 默认参数调整

- `DISCUSSION_DEFAULT_MAX_ROUNDS`: 8 → **20**（`clampInt` 上限保持 50）
- `DISCUSSION_DEFAULT_MAX_MESSAGES`: 60 → **200**（按实质发言计，200 条 ≈
  5 agent × 20 轮，作为防失控兜底）
- `clampInt(input.maxMessages, ...)` 的 max 从 500 → **1000**（前端 NInputNumber
  的 max 同步改 1000）
- 前端 `GroupChatPanel.vue`：`discussionMaxMessages` / `discussionQuickMaxMessages`
  默认值 60 → 200，`:max="500"` → `:max="1000"`；`discussionMaxRounds` /
  `discussionQuickMaxRounds` 默认 8 → 20

### 4.3 讨论中自动归档（每 N 轮）

新增常量：

```ts
/** 讨论进行中每 N 轮自动归档一次，把原始消息落盘为 summary，
 *  防止长讨论上下文无限膨胀。0 表示关闭讨论中归档。 */
const DISCUSSION_ROUND_ARCHIVE_EVERY = 5
/** 讨论中归档的最小实质发言量（低于此量不归档，避免小讨论频繁归档）。
 *  按实质发言计数（每轮约 agent 数+1 条），5 轮约 25-30 条，阈值设在 20。 */
const DISCUSSION_ROUND_ARCHIVE_MIN_MESSAGES = 20
```

在 `runDiscussion` 循环中，每轮裁判评估后检查：

```ts
if (
  DISCUSSION_ROUND_ARCHIVE_EVERY > 0
  && round % DISCUSSION_ROUND_ARCHIVE_EVERY === 0
  && messagesSinceStart() >= DISCUSSION_ROUND_ARCHIVE_MIN_MESSAGES
) {
  await this.archiveDuringRun(roomId, state)
}
```

新增 `archiveDuringRun` 私有方法：调用
`this.deps.roomSummaryService.archiveRoom(roomId)`（失败仅告警，不中断讨论），
并广播一条系统消息告知"已自动归档第 N 轮之前的讨论记录"。

注意：
- `archiveRoom` 会强制滚动总结未总结部分并删除锚点前的原始消息；
  讨论中每 5 轮调用一次，删除的是已总结的历史消息，进行中的最新轮次不受影响。
- 结束后的 `autoArchiveAfterRun` 逻辑保持不变（≥500 条才归档，正常讨论保留可见历史）。

### 4.4 全局并发限制

`DiscussionRunner` 增加静态信号量（简单计数器）：

```ts
/** 同一时刻允许运行的最大讨论场数（防止多房间并发把设备内存吃爆）。
 *  环境变量 HERMES_GROUP_CHAT_MAX_CONCURRENT_DISCUSSIONS 可覆盖。 */
export const DISCUSSION_MAX_CONCURRENT = envInt('HERMES_GROUP_CHAT_MAX_CONCURRENT_DISCUSSIONS', 1)
```

- `start()` 成功创建 row 前检查：当前运行中讨论数（遍历 storage 统计
  active status 的 row 数）`>= DISCUSSION_MAX_CONCURRENT` 时抛 409
  `Group chat is at its concurrent discussion limit`。
- `runDiscussion` 的 `finally` 释放计数（计数基于 storage 中 active row 数，
  天然持久化、跨进程安全；无需内存计数器）。
- 说明：判断"运行中"用 `isActiveStatus(row.status)`（pending/running/paused），
  与现有 per-room 检查一致。

### 4.5 测试清理与新增

- 删除/改写 3 个残留 extension 用例（`extends past maxRounds...` /
  `stops extending as soon as...`）→ 改为验证"达到 maxRounds 直接结束
  （不扩展）"，与 b80cee40 后的行为一致。
- 新增用例：
  1. `maxMessages` 只计实质发言：模拟 tool 消息不触发预算终止，讨论可跑满
     maxRounds
  2. 讨论中每 N 轮自动归档（`archiveCalls` 在跑满多轮时多次出现）
  3. 全局并发限制：第二场讨论在并发上限时抛 409
- 测试桩 `harness()` 的 storage 增加 `getSubstantiveMessageCount` 实现
  （基于 `messageCount` 的可控值，新增 `substantiveMessageCount` 选项）。

## 5. 验收标准

1. `npx vitest run tests/server/group-chat-discussion.test.ts` 全部通过
   （预期 ~24 个用例）。
2. `npm run build` 通过（server tsc + client vue-tsc + esbuild bundle）。
3. 部署到设备后：`md5sum /opt/hermes-web-ui/dist/server/index.js` 变更，
   服务重启成功，`/api/hermes/health` 200。
4. 在"许-测试1"发起新讨论（maxRounds=8~20，5 agent），
   观察状态推进：`currentRound` 逐轮增加，不再第 1 轮即 `max_rounds`；
   每 5 轮出现"自动归档"系统消息；结束时 `status` 为 `converged` 或
   `max_rounds`（跑满轮次），`deliverables` 有交付文件。
5. 设备内存：讨论期间 `free -m` 可用内存不低于 ~1.5GB（无暴死风险）。

## 6. 风险与回退

- **讨论中归档**：`archiveRoom` 失败（如总结模型不可用）只告警不中断，
  原始消息保留，无数据丢失。
- **并发限制**：默认 1，`/讨论` 命令在另一房间正在讨论时会返回 409，
  前端需给出明确提示（现 `message.error` 展示服务端错误文案即可）。
- **回退**：全部改动集中在 `discussion.ts` + storage 一个方法 +
  前端默认值，可整体 revert；存储层无 schema 变更（不新增列）。

## 7. 部署与验证步骤

1. `npm run build`
2. paramiko SFTP 上传 `dist/server/index.js` 与 `dist/client/*` 到
   `/opt/hermes-web-ui/dist/`
3. `systemctl restart hermes-web-ui`，确认进程起来、health 200
4. Web 登录（quanthermes / Byym602282#），进入"许-测试1"发起讨论，
   观察轮次推进与归档
5. 检查 `gc_discussions` 表状态与交付目录文件
