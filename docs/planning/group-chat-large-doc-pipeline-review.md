# 群聊大文件全自动讨论 —— 设计方案评审（对照真实代码）

> 创建日期：2026-08-11
> 适用版本：v0.7.17
> 评审对象：外部设计文档《群聊系统大文件全自动讨论 —— 开发文档（开发端照做版）》
> 目标设备：RK3528 / Armbian，3.8G 内存，4 核（69max-rk3528）
> 评审方式：对照 `packages/server` 实际代码逐条核实（含行号），非纸上推演
> 评审结论：**架构方向可行，但 2 处事实性前提错误 + 4 处参数自相矛盾 + 3 个真实场景缺口，需修订后方可作为实施依据**

---

## 1. 总体结论

原设计方案的核心架构（**程序化预提取 → map-reduce 分卷精读 → 结构化事实库 → 分层聚合**）方向正确，与真实代码的存储/模型调用范式同构，在 RK3528 约束下可行。

但以下问题必须在实施前修订：

- **前提错误**：原文档 §0 声称"snapshot + 增量压缩已存在"，实际 `ContextEngine` 是仓库中的**无调用点死代码**；群聊当前真正使用的压缩链路是 `GroupRoomSummaryService` 滚动总结 + `runBareModelAgent` 裸模型调用。
- **token 账算不过去**：原文档"每 agent 事实累积摘要 ≤50K tokens"在 100MB 场景下不可能（见 P0-1），必须改为滚动卷摘要。
- **参数自相矛盾**：并发模型（2-3/agent vs 全局 ≤5）、吞吐验收（≈5× vs 4 核理论）、块数估算、聚合层"自由讨论 vs 两级汇总"四处口径冲突。
- **真实场景缺口**：GBK 编码、PDF/扫描件范围、终稿消息循环、设备内存约束下的 worker 形态。

---

## 2. 事实核查表（设计文档假设 vs 真实代码）

| # | 设计文档假设 | 真实代码 | 判定 |
|---|---|---|---|
| 1 | `@mention → replyToMention → buildContext → getMessagesForContext`（§0） | `replyToMention` 存在（`agent-clients.ts:918`）；`getMessagesForContext` 确实**全量读 SQLite 无 LIMIT**（`group-chat/index.ts:528`） | ✅ 部分属实 |
| 2 | "snapshot + 增量压缩已存在，压缩后只留 summary + tail 10 条原文"（§0） | `ContextEngine.buildContext`（`context-engine/compressor.ts:60`）**无任何调用点**（grep 全仓仅自引用），是未挂接的死代码；群聊实际走 `GroupRoomSummaryService`（`room-summary.ts:259`）+ `runBareModelAgent`（`room-summary.ts:210`） | ❌ **前提错误** |
| 3 | 大文件内容进 `gc_messages` 后 triggerTokens(100000) 压缩（§0） | `gc_rooms.triggerTokens` 默认 100000 属实（`schemas.ts:587`），但该阈值由死代码 ContextEngine 消费，**当前运行路径并不按此压缩** | ⚠️ 前提错误 |
| 4 | 需新增"附件上传按钮"（§4 GroupChatInput.vue） | `GroupChatInput.vue` 已有完整附件选择/拖拽/粘贴/预览（L426-487），走 `/upload`（见 #5） | ⚠️ 需区分普通附件与文档管道 |
| 5 | 上传 100MB 文件 | `/upload` 硬编码 50MB 上限且**全量缓冲到内存**（`controllers/upload.ts:8, 23-31`），大文件会 413 + 内存尖峰 | ❌ 需新流式链路 |
| 6 | 新增 5 张表 | `schemas.ts` 的 `syncTable` + `initAllHermesTables()`（L1266-1289）模式支持增量加表，群聊表在 L1266-1289 注册 | ✅ |
| 7 | 独立 document-worker 进程 + `--max-old-space-size=512` | 仓库**无 V8 内存参数先例**；有 spawn 先例（`coding-agent-run-manager.ts:307`），但 3.8G 设备再起常驻 Node 进程内存更紧张 | ⚠️ 已改进程内调度器 |
| 8 | 精读上下文 = 指令 + 当前块 + 事实累积摘要（§6） | `runBareModelAgent`（`room-summary.ts:210-257`）正是"无工具单步模型调用"，已处理 provider/model/apiMode 解析 + 超时重试，summary/discussion judge 均复用 | ✅ 确认复用 |
| 9 | 聚合"5 agent 自由讨论"（§2 标题） | 现有 `DiscussionRunner`（`discussion.ts:695`）是多轮自由讨论；法律场景确定性优先，建议两级汇总（见 P1-4） | ⚠️ 语义冲突 |
| 10 | 上传落盘 + 广播 document_ready（§5） | 房间消息广播模式为 `nsp.to(roomId).emit('message', ...)`（`group-chat/index.ts:1736`），可复用 | ✅ |

---

## 3. P0 —— 必须修订的问题

### P0-1 事实累积摘要的 token 账算不过去

原文档 §6 说"上下文 = 精读指令 + 当前块(40K) + 本 agent 事实累积摘要(≤50K)"，§9.5 验收 #2 又写"每 agent 每轮上下文 ≤50K tokens"。**两者互相矛盾且都不可行**：

- 5 agent 均分 400 块 = 每 agent 80 块；每块 fact ~3K tokens → 80 块累积 **240K tokens**，远超任何单轮窗口；
- 若按 40K 块 + 50K 摘要 + 指令，单轮已达 ~92K，再留 fact 输出空间（≥10K）逼近 flash 128K 上限，重试容错几乎为零。

**修订方案**：

```
每 agent 精读上下文（单轮）：
  精读系统指令          ~2K tokens
  当前块文本            40K tokens（块预算上限）
  当前卷摘要（滚动）     ≤8K tokens（每精读 10 块，把该 agent 已产 facts 压缩成卷摘要）
  ─────────────────────────────
  合计                 ≈50K tokens / 轮，输出余量充足
```

- 每个 agent 维护独立的卷摘要（`gc_reading_jobs.agent_id` 维度）；每完成 N=10 块，用一次 `runBareModelAgent` 把该 agent 的 facts 压缩成卷摘要，写回 `gc_document_facts`（或新增 `gc_agent_volume_summaries` 列），下一轮只带当前卷摘要。
- 验收标准 #2 相应改为"每 agent 每轮上下文 ≤55K tokens"。

### P0-2 不在死代码 ContextEngine 上扩建

原文档 §4 要求改 `compressor.ts` 加 `buildDocumentReadingContext()`。但 `ContextEngine` 当前**无调用方**，为它新起一条并行的精读上下文链路属于在死代码上扩建，风险高且收益为零。

**修订方案**：精读上下文由 document-pipeline 直接组装（可复用 `context-projection.ts` 的投影函数），**不依赖 ContextEngine**。Phase 5 的 `getMessagesForContext` 分页修债独立推进，与文档管道解耦。

---

## 4. P1 —— 参数自相矛盾，需统一口径

| # | 位置 | 矛盾 | 修订建议 |
|---|---|---|---|
| P1-1 | §4 vs §8 | 并发"2-3/agent" × 5 agent = 10-15 全局并发，与"全局并发 ≤5"冲突 | 进程内调度器下：**全局并发上限 = 5**（每 agent 窗口 = 1），"管道化提速"靠 5 agent 并行，而非单 agent 内多轮窗口 |
| P1-2 | §9.5 验收 #9 | "5 agent 吞吐 ≈5× 单 agent" 但 5 agent 只分配 4 核超卖 | 理论上限 ≈4×；验收线改为 **≥3.5×**（等 API 为主的 I/O 场景实际可逼近 4×） |
| P1-3 | §附 | "100MB → ~400 块"（4000 万 tokens ÷ 40K） | 中文 40K tokens ≈ 240KB UTF-8，100MB 中文约 400 块成立；但若文件含非中文/扫描文本则块数偏差大，建议按**实际 token 估算动态分块**并把"块数"写进验收实测项 |
| P1-4 | §2 标题 vs §2 流程 | 聚合层写"5 agent **自由讨论**"，流程却是两级机械汇总 | 法律交付确定性优先：**聚合 = 两级 `runBareModelAgent` 汇总**（一级卷摘要 → 二级终稿），不做多轮自由讨论；"讨论"体验作为终稿后的可选增强（复用现有 `DiscussionRunner`） |

---

## 5. P2 —— 真实场景缺口

### P2-1 编码：GBK / GB18030 必须嗅探

原文档 `gc_documents.encoding` 默认 `utf-8`。国内合同/判决书大量 GBK/GB18030 编码，纯 UTF-8 解析必乱码。parser 必须做 **BOM + 编码嗅探**（chardet 风格或简易 heuristic），探测失败回退 GBK 再 UTF-8。

### P2-2 PDF / 扫描件：MVP 范围必须明确

律师客户交付物大量是 PDF，扫描件占比不低。原文档完全未定义。建议：

- **MVP 支持**：txt / docx（文本型） / PDF（文本型，走文本提取层）；
- **明确排除**：扫描件 OCR（在 4 核设备上引入 OCR 依赖不现实），作为后续项；
- 上传时做类型识别，非支持类型返回明确错误，避免用户误传 100MB 扫描件后管道空转。

### P2-3 终稿写回 `gc_messages` 后的循环

终稿写入 `gc_messages` 后，`handleMessage`（`group-chat/index.ts:1746-1768`）会再次触发 mention 路由/总结检查，可能把大文档内容重新拖进 agent 上下文。

**修订方案**：终稿消息使用**专用标记**（如 `tool_name: 'document_report'` 或专用 role），在三条过滤路径各加一条规则：
- `getMessagesForContext`（index.ts:528）现有 `COALESCE(tool_name,'') <> 'workspace_diff'` 过滤基础上追加；
- `handleMessage` 的 mention 路由触发条件（index.ts:1753）；
- `GroupRoomSummaryService` 的总结输入（`cleanGroupMessages` room-summary.ts:119）。

### P2-4 进程内调度器替代独立 worker（按用户决策定稿）

原文档独立 worker 的"崩了不连带主进程"价值，在 3.8G 设备上不划算。进程内调度器方案：

- 崩溃隔离改为 **job 级 try/catch + 失败标记 + 重试 2 次**，坏 job 记 error 不阻塞队列；
- 内存水位熔断（可用内存 <500MB 暂停队列）在主进程内检查，实现更简单；
- 重启续跑：job 状态持久化（pending/running/done/failed），服务重启后 pending 续跑 —— 与原设计一致；
- 每房间互斥锁复用 `GroupRoomSummaryService.runExclusive`（room-summary.ts:304）或同款 per-room lock 模式。

### P2-5 `runBareModelAgent` 超时

`runBareModelAgent` 默认超时 300s（room-summary.ts:223）。40K tokens 块 + fact JSON 输出，建议精读调用显式传 `timeoutMs: 600_000`。

### P2-6 新流式上传端点

100MB 不能走 `/upload`（50MB + 全缓冲）。需新端点：`POST /api/hermes/group-chat/rooms/:roomId/documents`（multipart 流式落盘，复用 `lib/multipart.ts` 但改为流式写盘），落盘目录 `appHome/group-chat-docs/{roomId}/{fileId}/`，与现有 workspace（`appHome/group-chat/{profile}/{roomId}`）隔离。

---

## 6. 修订后实施要点（按用户决策定稿）

> 用户已确认两项决策：**精读/聚合走进程内后台调度器** + **模型调用复用 `runBareModelAgent`**。

### 6.1 数据层（Phase 1）

5 张表按原 §3 定义，注册进 `schemas.ts` + `initAllHermesTables()`：

- `gc_documents`、`gc_file_chunks`、`gc_document_fields`、`gc_document_facts`、`gc_reading_jobs` + 索引
- `encoding` 列语义改为"嗅探结果"（utf-8 / gbk / gb18030）
- `gc_reading_jobs` 增加 `volume_summary` 列（每 agent 滚动卷摘要）

### 6.2 入口（Phase 2）

- 新路由 `POST /documents`（流式上传 + parser）+ `GET /documents/:fileId`（进度）+ `POST /documents/:fileId/start`（assignJobs）
- `document-parser.ts`：编码嗅探 → 文件类型识别（合同/判决书/通用）→ 结构切块 → 规则字段提取（quote 带 offset）
- 前端：`GroupChatPanel` 文档卡片（复用现有 socket 事件与消息列表渲染风格），不新建大组件

### 6.3 精读（Phase 3）

- 进程内 `DocumentPipelineService`（仿 `GroupRoomSummaryService`）：per-room 锁 + `runBareModelAgent`
- 每轮上下文 = 指令 + 当前块 + 当前卷摘要（滚动，N=10 块压缩一次）
- 全局并发 ≤5；指数退避重试 2 次；job 状态落 SQLite 重启续跑；内存水位熔断

### 6.4 聚合（Phase 4）

- 两级 `runBareModelAgent`：一级卷摘要（每 agent）→ 二级终稿（条款矩阵 + 风险清单 + 冲突清单 + 待办）
- 终稿以 `tool_name: 'document_report'` 标记写入 `gc_messages`，并加入三条过滤路径（P2-3）

### 6.5 修债（Phase 5）

- `getMessagesForContext` 分页 + 旧消息归档，独立推进，与文档管道解耦

### 6.6 测试

- parser 单测：埋 50 个已知条款/金额/日期 + GBK 样本
- pipeline 集成测：mock `runBareModelAgent`
- 1MB 冒烟 → 100MB 压测，验收表按 P1/P0 修订口径调整

---

## 7. 评审交付确认

- 本文档即本次评审交付物（原始设计文档按需另存于 `docs/prompts/` 或外部归档）。
- 修订版完整设计定稿（把本评审合并进实施文档）**留待后续按需产出**，不在此次交付范围内。

---

## 附：与现有群聊压缩机制的关系说明

真实链路（`group-chat/index.ts:1746-1768` + `agent-clients.ts`）：

```
handleMessage → saveMessageAndRefreshRoom → 广播 message/room_updated
  → 有 mention：agentClients.processMentions
  → 无 mention：processSummaryCheck → GroupRoomSummaryService（滚动总结）
Agent 回复：roomSummaryService.prepareForMessage → replyToMention
  → AgentBridgeClient.chat（agent-bridge IPC/TCP，agent 侧自身做上下文估算）
```

原设计文档把 ContextEngine（`compressor.ts`）当作"现有机制"，但该模块当前无调用点。文档管道**不依赖也不复用** ContextEngine；`getMessagesForContext` 的 LIMIT/归档修债（原 Phase 5）保留为独立工作项。
