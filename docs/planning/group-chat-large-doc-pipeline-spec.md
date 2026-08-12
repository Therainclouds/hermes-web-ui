# 群聊系统大文件全自动讨论 —— 开发规格（修订定稿）

> **文档定位**：本文件是开发端的唯一实施依据。开发端按 §4 模块清单 + §5 接口 + §8 实施顺序开发，按 §6 测试计划验收。
> **修订依据**：[group-chat-large-doc-pipeline-review.md](./group-chat-large-doc-pipeline-review.md)（2026-08-11 对照真实代码评审）
> **场景**：律师客户 · 100MB 文件（≈4000 万 tokens）全自动整理 · 5 agent 讨论 · 每 agent ≤1 核 · 3.8G 内存 RK3528（69max-rk3528）
> **硬约束**：RAG 不适用（法律场景全文零遗漏）；全文进单上下文不可能（超模型窗口 30-200 倍）；本地推理不可能（3.8G）；API 费用不是问题
> **架构结论**：**程序化预提取 + map-reduce 全量分卷精读 + 结构化事实库 + 分层聚合**。全文每个字节都被读到，只是不在同一个上下文里。

---

## 0. 修订摘要（相对原始设计文档）

| 修订项 | 原始方案 | 定稿方案 | 依据 |
|---|---|---|---|
| 精读 worker 形态 | 独立 document-worker 子进程（`--max-old-space-size=512`） | **进程内后台调度器**（`DocumentPipelineService`，per-room 锁） | P2-4 / 3.8G 设备内存约束 |
| 精读/聚合模型链路 | `replyToDocumentReading` 走 AgentBridgeClient 全链路 | **复用 `runBareModelAgent`**（room-summary.ts:210）裸模型调用 | P0-2 / 与总结/讨论同构 |
| 上下文压缩机制 | 依赖"已存在"的 snapshot+增量压缩（ContextEngine） | **不依赖 ContextEngine**（死代码）；精读上下文由 pipeline 组装 | P0-2 |
| 事实累积摘要 | ≤50K tokens 累积 | **滚动卷摘要**（每 10 块压缩一次，≤8K），单轮上下文 ≈50K | P0-1 |
| 全局并发 | 2-3/agent + 全局 ≤5 冲突 | **全局并发 ≤5**（每 agent 窗口 = 1） | P1-1 |
| 聚合层 | "5 agent 自由讨论" | **两级 `runBareModelAgent` 汇总**（讨论为可选增强） | P1-4 |
| 上传 | 隐含走现有 `/upload` | **新流式上传端点**（50MB 全缓冲的 `/upload` 不适用） | P2-6 |
| 编码 | 默认 utf-8 | **编码嗅探**（utf-8 / gbk / gb18030） | P2-1 |
| 吞吐验收 | ≈5× 单 agent | **≥3.5×**（4 核理论上限 ≈4×） | P1-2 |
| 崩溃隔离 | 独立进程防连带 | **job 级 try/catch + 失败标记 + 重试** | P2-4 |

---

## 1. 目标与约束

| 目标 | 说明 |
|------|------|
| 全自动 | 上传后零人工介入，出终稿 |
| 全文零遗漏 | 每个字节都被处理，非检索 |
| 5 agent 并行 | 精读层是机械化并行管道，聚合层才是 agent 讨论 |
| 每 agent ≤1 核 | 精读 80% 时间等 API，1 核够用 |
| 3.8G 内存不爆 | O(1) 内存，与文件大小无关（进程内调度器 + 分块加载） |

---

## 2. 三层管道架构（核心设计）

```
上传 100MB
  │
  ▼
① 程序化层（零 AI，机械可验证）
  ├─ 编码嗅探（utf-8/gbk/gb18030）+ 文件类型识别（合同/判决书/通用）
  ├─ 结构切块：按"第X条/第X章/X."等正则锚点切 → 块边界落在语义完整处
  │   无条款编号文档 → 回退 token 预算切块（默认 40K tokens/块）
  └─ 规则字段提取：金额/日期/当事人/法条引用 → 字段表，每条带原文位置(offset)
       → 写入 gc_document_fields（天然 quote 溯源）
  │
  ▼
② AI 精读层（进程内 DocumentPipelineService，机械化并行管道，非"讨论"）
  ├─ 全局并发 ≤5（5 agent × 窗口 1），每 agent 独立 job 队列（gc_reading_jobs）
  ├─ 每轮上下文 = 精读系统指令(~2K) + 当前块(≤40K) + 当前卷摘要(≤8K) ≈ 50K tokens
  ├─ 每完成 10 块 → 用 runBareModelAgent 把本 agent 已产 facts 压缩成新卷摘要（滚动）
  ├─ AI 只做语义部分：义务/风险/交叉引用逻辑 + 核对①的规则字段（确认而非提取）
  └─ 输出 fact JSON（含 quote 原文引用 + chunk_id）→ gc_document_facts
  │
  ▼
③ 聚合层（两级汇总，确定性优先）
  ├─ 一级：每 agent 用自己的最终卷摘要 + 规则字段表 → 卷终稿摘要（≤20K tokens）
  ├─ 二级：主持人读 5 份卷终稿摘要 + 规则字段表 → 交叉核对冲突 → 终稿
  └─ 终稿 = 条款矩阵 + 风险清单 + 交叉引用冲突清单 + 待办
       → 以 tool_name='document_report' 标记写入 gc_messages
```

**程序化优先原则**：金额/日期/当事人/法条引用等高风险字段**先用规则提取**（机械匹配 ≈100% 准，零成本），AI 只复核确认，不从头提取。规则覆盖不了的（手写扫描件/不规则表格）回退 AI 兜底。

---

## 3. 数据表（`packages/server/src/db/hermes/schemas.ts` 新增）

> 修订：新增 `gc_volume_summaries`（滚动卷摘要），编码列语义改为"嗅探结果"。

```sql
gc_documents (
  file_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size_bytes INTEGER,
  doc_type TEXT DEFAULT 'generic',        -- contract|judgment|generic
  encoding TEXT DEFAULT 'utf-8',          -- 嗅探结果：utf-8|gbk|gb18030
  chunk_count INTEGER,
  chunk_token_budget INTEGER DEFAULT 40000,
  status TEXT DEFAULT 'uploaded',         -- uploaded|chunked|reading|aggregating|done|failed
  created_at INTEGER
)

gc_file_chunks (
  chunk_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  start_offset INTEGER,                   -- 原文字节偏移（结构切块时锚点定位）
  end_offset INTEGER,
  token_estimate INTEGER,
  status TEXT DEFAULT 'pending',          -- pending|read|fact_extracted
  read_by_agent TEXT
)

gc_document_fields (                       -- ①程序化层输出，规则提取结果
  field_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  chunk_id TEXT,
  field_type TEXT NOT NULL,               -- amount|date|party|statute|other
  value TEXT NOT NULL,
  quote TEXT NOT NULL,                    -- 原文引用片段（溯源用）
  quote_offset INTEGER,                   -- 原文位置
  verified_by_agent TEXT,                 -- AI 复核标记（null=未复核）
  verified_at INTEGER
)

gc_document_facts (                        -- ②AI 精读层输出
  fact_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  fact_json TEXT NOT NULL,                -- {type, content, quote, cross_refs[]}
  created_at INTEGER
)

gc_reading_jobs (                          -- ②任务队列
  job_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT DEFAULT 'pending',          -- pending|running|done|failed
  attempts INTEGER DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
)

gc_volume_summaries (                      -- 修订新增：每 agent 滚动卷摘要
  file_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  volume INT NOT NULL DEFAULT 0,          -- 第几卷（每 10 块一卷）
  summary TEXT NOT NULL,                  -- 压缩后卷摘要（≤8K tokens）
  through_chunk_idx INTEGER,              -- 覆盖到第几块
  updated_at INTEGER,
  PRIMARY KEY (file_id, agent_id, volume)
)
```

索引：`gc_file_chunks(file_id, idx)`、`gc_reading_jobs(file_id, status)`、`gc_document_facts(file_id, chunk_id)`、`gc_document_fields(file_id, field_type)`、`gc_volume_summaries(file_id, agent_id)`

---

## 4. 模块清单（开发端按此开发）

### 新模块
| 模块 | 路径 | 职责 |
|------|------|------|
| document-store | `packages/server/src/db/hermes/document-store.ts` | 6 张表 CRUD（含卷摘要） |
| document-parser | `packages/server/src/services/hermes/group-chat/document-parser.ts` | ①程序化层：编码嗅探、文件类型识别、结构切块、规则字段提取（正则模板库：合同/判决书/通用） |
| document-pipeline | `packages/server/src/services/hermes/group-chat/document-pipeline.ts` | ②③进程内调度器：assignJobs → 调度（全局并发 ≤5，per-room 锁）→ 滚动卷摘要 → onAllChunksRead → 两级聚合 |
| document-reading-context | `packages/server/src/services/hermes/group-chat/document-reading-context.ts` | 精读/聚合提示词组装（指令 + 块 + 卷摘要），复用 `context-projection.ts` 投影函数 |

### 改动现有模块
| 文件 | 改动 |
|------|------|
| `packages/server/src/db/hermes/schemas.ts` | 加 6 张表 + 索引（`initAllHermesTables()` 群聊段） |
| `packages/server/src/routes/hermes/group-chat.ts` | 新路由（见 §5） |
| `packages/server/src/services/hermes/group-chat/index.ts` | `GroupChatServer` 装配 `DocumentPipelineService`；`getMessagesForContext` 过滤 `tool_name='document_report'`；handleMessage mention 路由跳过 document_report（防循环，P2-3） |
| `packages/server/src/services/hermes/group-chat/room-summary.ts` | `cleanGroupMessages` 过滤 document_report（防总结污染，P2-3） |
| `packages/server/src/controllers/hermes/group-chat-document.ts` | 新增：上传/进度/启动控制器（复用 `managedRoom` 鉴权模式） |
| `packages/client/src/components/hermes/group-chat/GroupChatPanel.vue` | 文档卡片：状态徽标 + 精读进度条 + 终稿展示 |
| `packages/client/src/api/hermes/group-chat.ts` | 文档上传/进度/启动 API |
| i18n | 每个 locale 文件补 groupChat.document.* 键 |

### 规则模板库（document-parser 内部）
- `contracts.ts`：条款锚点 `/(第[一二三四五六七八九十百千0-9]+[条章节]|Article\s+\d+|[一二三四五六七八九十]+、)/`；金额 `/人民币[¥￥]?\s?[\d,，]+(\.\d+)?\s?元/`；日期 `/(20\d{2})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/`；法条 `/(《[^》]+》\s*第\s*[\d〇一二三四五六七八九十百千]+\s*条)/`
- `judgments.ts`：案号 `/（\d{4}）[\u4e00-\u9fa5]{2,10}\d+号/`、当事人段、判项段
- `generic.ts`：兜底，纯 token 切块 + 通用金额/日期

---

## 5. 接口设计

```
POST /api/hermes/group-chat/rooms/:roomId/documents
  body: multipart file（流式落盘，非全缓冲）
  resp: { fileId, name, sizeBytes, docType, encoding, chunkCount, status: 'chunked' }
  flow: 流式落盘 appHome/group-chat-docs/{roomId}/{fileId}/{name}
        → parser.parse()（编码嗅探+切块+字段提取）→ 写 chunks/fields → 广播 document_ready
  limits: 默认 100MB（env MAX_GROUP_DOC_SIZE）；支持 txt/docx/pdf(文本型)；扫描件返回明确错误

GET  /api/hermes/group-chat/rooms/:roomId/documents/:fileId
  resp: { fileId, status, chunkCount, chunksRead, chunksTotal, fieldsCount, factsCount, progressPct }

POST /api/hermes/group-chat/rooms/:roomId/documents/:fileId/start
  body: { agents: ['ace','radar','whip','...','...'] }   // 5 个 agent profile
  resp: { pipelineId, jobsAssigned }
  flow: assignJobs（chunks 均分给 agents）→ DocumentPipelineService 启动 → 广播 reading_started
        → 每 agent 滚动卷摘要（每 10 块压缩）→ 全部 done → 自动进入聚合
  （取消独立的 /aggregate 端点，聚合由 pipeline 自动触发，简化状态机）

Socket.IO 事件（复用 /group-chat namespace）:
  document_ready     { fileId, name, chunkCount }
  reading_progress   { fileId, chunksRead, chunksTotal, progressPct, agentStats }
  document_report    { fileId, messageId }   // 终稿已写入 gc_messages
```

**worker 通信**：无独立进程。`DocumentPipelineService` 进程内调度，经 SQLite job 表持久化状态，重启后 pending 续跑。

---

## 6. 数据流（端到端）

```
用户上传 100MB 合同包
  → POST /documents → 流式落盘 → parser 编码嗅探 + 结构切块（~400 块，40K tokens/块）+ 规则字段提取（~2 万条 fields）
  → 广播 "📄 文档就绪：400 块，规则字段 2 万条，5 agent 开始精读"
  → POST /start → assignJobs（agent A-E 各 80 块）→ DocumentPipelineService 启动
  → 进程内异步管道化精读（全局并发 ≤5，每 agent 窗口 1）：
      每轮：读 1 块（40K tokens）→ runBareModelAgent 语义提取 + 核对 fields → fact JSON（~3K tokens）
      上下文 = 精读指令(~2K) + 当前块(≤40K) + 当前卷摘要(≤8K) ≈ 50K
      每 10 块 → 滚动压缩新卷摘要（runBareModelAgent，≤8K）
      坏块重试 2 次（指数退避），仍失败标记 failed + 记录 error
  → 400 块全 done（~80 轮/agent，管道化后 ~1 小时）
  → 聚合自动触发：一级卷终稿摘要（每 agent ≤20K）→ 二级主持人终稿
  → 终稿（tool_name='document_report'）写入 gc_messages → 群聊展示 → 可继续自由讨论
```

**内存账**：每轮只加载 1 块（100KB → JS ~300KB）+ 卷摘要 8K tokens ≈ **<10MB/agent 峰值**；主进程 <200MB 增量；进程内调度器不再单独计 worker 内存。
**CPU 账**：5 agent × 窗口 1 = 5 并发但 80% 时间等 API，实际 CPU 占用 40-60%，4 核不撞墙。

---

## 7. 精度策略（律师行业诚实边界）

- **原始文件 100% 保全**：文件原始字节存本机永不改动 → 可对客户承诺 100%
- **LLM 提取 100% 无失真做不到**：概率模型本质。三道防线逼近：
  1. **quote 溯源**：每条 fact/field 强制带 quote + 原文 offset；聚合阶段机械字符串匹配校验（不靠 LLM）→ 抓幻觉引用
  2. **高风险字段双校验**：金额/日期/当事人/法条 = 规则提取（≈100%）+ AI 复核确认；不一致标 conflict 交人工
  3. **抽查报告**：交付前随机抽 N 块原文 vs 提取结果对比，出报告随终稿
- **话术红线**：对客户承诺"逐条可溯源 + 高风险双校验 + 抽查报告"，**绝不承诺"百分百无失真"**

---

## 8. 防爆炸保障机制（进程内调度器修订版）

| 机制 | 实现 |
|------|------|
| 崩溃隔离 | job 级 try/catch + 失败标记 + 重试 2 次（指数退避），坏 job 不阻塞队列 |
| 内存水位熔断 | 主进程内检查可用内存 < 500MB → 暂停精读队列，恢复后续跑 |
| per-room 锁 | 复用 `GroupRoomSummaryService.runExclusive`（room-summary.ts:304）同款模式，避免与总结/回复并发 |
| SQLite WAL | `PRAGMA journal_mode=WAL` + 批量事务（5 agent 并发写不锁死） |
| 全局并发 ≤5 | 防云 API 限流；退避重试（指数退避，上限 3 次） |
| O(1) 内存 | 分块加载不常驻全文 + 流式读取 |
| 重启续跑 | job 状态持久化，服务重启后 pending 续跑 |
| runBareModelAgent 超时 | 精读显式传 `timeoutMs: 600_000`（默认 300s 不够，P2-5） |
| 熔断验收 | kill 主进程 → 重启后续跑；Swap 监控不飙升 |

---

## 9. 测试计划

### 9.1 测试数据（埋点验证）
```bash
# 生成模拟法律文件：合同模板 + 变化条款，埋 50 个已知条款/金额/日期
python3 /tmp/gen_legal_docs.py --size 100MB --out /tmp/legal_case_100mb/ --encoding utf-8
python3 /tmp/gen_legal_docs.py --size 1MB --out /tmp/legal_case_1mb/ --encoding utf-8
python3 /tmp/gen_legal_docs.py --size 1MB --out /tmp/legal_case_gbk/ --encoding gbk   # 修订新增：编码嗅探
# 三种类型各一份：合同 / 判决书 / 无结构纯文本（测 generic 兜底）
```

### 9.2 冒烟（1MB 先跑通）
1. 建群聊房间，加 5 agent
2. 上传 1MB（utf-8 + gbk 各一份）→ 确认分块数、规则字段数、编码嗅探结果、广播
3. 观察精读：5 agent 逐块消化、进度条增长、卷摘要滚动
4. 聚合完成 → 群聊出现终稿（tool_name='document_report'）
5. 检查：无 OOM、每轮上下文日志 ≤55K tokens、quote 校验全过、document_report 未触发 mention 循环

### 9.3 压测（100MB 正式跑）
```bash
# Node 内存 + CPU
watch -n 2 'ps -o pid,rss,vsz,%cpu,etime -p $(pgrep -f "dist/server/index.js")'
# 精读进度 + 上下文预算
journalctl -u hermes-web-ui -f | grep -E "document-pipeline|ReadingJob|contextTokenEstimate"
# SQLite 状态
sqlite3 /opt/hermes-web-ui/hermes_data/state.db \
  "SELECT status, COUNT(*) FROM gc_file_chunks GROUP BY status;
   SELECT COUNT(*) FROM gc_document_facts;
   SELECT COUNT(*) FROM gc_volume_summaries;
   SELECT COUNT(*) FROM gc_document_fields WHERE verified_by_agent IS NULL;"
```

### 9.4 对照实验
- 单 agent 基线 vs 5 agent（吞吐提升验证，验收 ≥3.5×）
- 40K vs 80K tokens/块（耗时 vs 精度）
- 规则提取 vs 纯 AI 提取（字段准确率对比，验证程序化层价值）

### 9.5 验收标准（修订版）
| # | 指标 | 通过线 |
|---|------|--------|
| 1 | 全程无 OOM / V8 heap 超限 | 0 次 |
| 2 | 每 agent 每轮上下文 | ≤55K tokens（日志验证） |
| 3 | 主进程内存增量 | <200MB |
| 4 | 100MB 全自动跑完 | <1.5 小时（管道化后） |
| 5 | 已知条款/金额/日期抽取率 | 规则字段 100%（机械匹配）；AI 语义 ≥95% |
| 6 | quote 溯源校验 | 100% 通过（机械校验） |
| 7 | 终稿含：条款矩阵+风险清单+冲突清单+待办 | 全有 |
| 8 | kill 主进程重启后续跑 | 不丢 job，续跑成功 |
| 9 | 5 agent 吞吐 | ≥3.5× 单 agent 基线（修订，原 ≈5×） |
| 10 | GBK 文件 | 编码嗅探正确，切块/字段无乱码（修订新增） |
| 11 | document_report 消息 | 不触发 mention 路由/总结循环（修订新增） |

---

## 10. 实施顺序

1. **Phase 1 数据层**：6 张表 + document-store（不影响现有功能）
2. **Phase 2 入口**：路由 + 流式上传 + parser（编码嗅探 + 结构切块 + 规则提取）+ 前端上传/进度 UI + document_report 防循环过滤
3. **Phase 3 精读**：DocumentPipelineService + runBareModelAgent 复用 + 滚动卷摘要（进程内）
4. **Phase 4 聚合**：两级汇总 + 终稿写 gc_messages + 广播 document_report
5. **Phase 5 修债**：getMessagesForContext 分页 + 旧消息归档（独立于管道推进）
6. **测试**：9.2 冒烟 → 9.3 压测 → 9.4 对照 → 9.5 验收

每阶段可独立验证；Phase 1-2 纯增量不碰现有群聊；Phase 3 后即可跑 1MB 冒烟。

---

## 11. 与真实代码的挂接点（实施时对照）

| 挂接点 | 文件:行 | 说明 |
|---|---|---|
| `runBareModelAgent` 复用 | `room-summary.ts:210-257` | 精读/聚合/卷摘要压缩全部走它，`purpose: 'group-chat-document'` |
| per-room 锁范式 | `room-summary.ts:304` | `runExclusive` 同款，DocumentPipelineService 每房间一把锁 |
| 消息广播 | `group-chat/index.ts:1736` | `nsp.to(roomId).emit(...)` 复用于 document_ready/progress |
| mention 触发点 | `group-chat/index.ts:1753` | 跳过 `tool_name='document_report'` |
| 上下文过滤 | `group-chat/index.ts:528` | `getMessagesForContext` 追加 document_report 过滤 |
| 总结输入过滤 | `room-summary.ts:119` | `cleanGroupMessages` 追加 document_report 过滤 |
| 新表注册 | `schemas.ts:1266-1289` | `initAllHermesTables()` 群聊段 |
| 路由鉴权 | `routes/hermes/group-chat.ts:93-102` | `setGroupChatServer` + `managedRoom` 模式 |

---

## 附：分块参数速查（修订版）
| 参数 | 默认 | 依据 |
|------|------|------|
| 每块 token 预算 | 40K | flash 模型窗口 128K 内，留足输出/指令/摘要余量 |
| 卷摘要预算 | ≤8K | 每 10 块滚动压缩，单轮上下文 ≤55K |
| 单轮精读上下文 | ~50K | 指令 2K + 块 40K + 卷摘要 8K |
| 100MB 中文 → 块数 | ~400 | 4000 万 tokens ÷ 40K（按实际 token 估算动态调整） |
| 每 agent 认领 | 80 块 | 5 agent 均分 |
| 全局并发 | ≤5 | 防 API 限流；每 agent 窗口 = 1 |
| 卷摘要滚动周期 | 每 10 块 | 控制上下文累积 |
| 精读超时 | 600s | runBareModelAgent 显式传入（默认 300s） |
| 预计总耗时 | ~1 小时 | 管道化 + 80K 档位可再减半 |
