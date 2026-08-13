---
date: 2026-08-11
pr: pending
feature: 群聊大文件文档管道（map-reduce 全量精读 + 结构化事实库 + 两级聚合终稿）
impact: 群聊房间可上传 100MB 级文档自动整理出终稿；`getMessagesForContext` 与 mention/总结触发路径开始过滤 `tool_name='document_report'` 消息。
---

## Group chat large-document pipeline

新增进程内 `DocumentPipelineService`（`document-pipeline.ts`）驱动大文件全自动整理，链路：
上传（流式 multipart，免全缓冲）→ parser（编码嗅探 GBK/GB18030、结构切块、规则字段提取带 quote+offset）
→ 5 agent 并行精读（全局并发 ≤5，复用 `runBareModelAgent` 裸模型调用，每 10 块滚动卷摘要）
→ 两级聚合（每 agent 卷终稿 → 主持人终稿：条款矩阵+风险清单+冲突清单+待办）
→ 终稿以 `tool_name='document_report'` 标记写入 `gc_messages`。

6 张新表（`gc_documents` / `gc_file_chunks` / `gc_document_fields` / `gc_document_facts` /
`gc_reading_jobs` / `gc_volume_summaries`）+ 4 个新端点（上传 / 列表 / 进度 / 启动），
新文件：`document-store.ts`、`document-parser.ts`、`document-reading-context.ts`、
`document-pipeline.ts`、`controllers/hermes/group-chat-document.ts`，
及 `lib/multipart.ts` 新增 `streamMultipartFirstFile` 流式写盘。

## Chat-chain behavior change: document_report messages are bookkeeping

终稿消息（`tool_name='document_report'`）不参与 agent 上下文、不触发 @mention 路由、
不进入滚动总结输入，避免 100MB 文档内容通过终稿再次被拉进 agent 上下文：
- `getMessagesForContext`（group-chat/index.ts）过滤 `tool_name IN ('workspace_diff','document_report')`
- `handleMessage` 的 mention 路由触发条件跳过 `document_report`
- `cleanGroupMessages`（room-summary.ts）已按 `tool_name` 过滤所有 tool 消息，天然覆盖

文档：`docs/planning/group-chat-large-doc-pipeline-spec.md`（规格定稿）、
`docs/planning/group-chat-large-doc-pipeline-review.md`（对照真实代码评审）。
