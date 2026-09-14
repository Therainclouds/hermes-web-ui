# 会议跑团插件（TRPG 0.1.2）

创建会议时选择跑团场景，右栏自动加载独立、懒加载的 TRPG 面板。

## 角色卡与高光

- 角色卡按 D&D 5E 的身份、六项属性、战斗、技能、背景与法术分组，可折叠。玩家/发言者与角色名分开，输出名称统一为【角色名】。
- AI 抄写员默认调用当前 Hermes 配置档案。PDF 先使用项目已有的 PDF.js 本地提取文字和坐标，再交给 Hermes 文本模型填卡；不向推测的供应商接口发送 PDF。提取失败或有歧义时，Agent 可读取临时原文件；扫描件仍需 OCR 工具。图片输入仍要求当前模型或工具具备识图能力。
- 草稿兼容 Markdown JSON、外围说明、嵌套 character/data/sheet、中文字段及属性缩写。Agent 最终答复优先于推理流。空结果仍明确报错，同一错误只显示一次。审阅后只应用非空字段。
- 抄卡界面直接复用 Hermes 的模型、供应商与认证配置。HTTP 直调仅作为显式 API 配置覆盖路径，避免把某供应商模型发送到另一个供应商的地址。PDF.js 从开发依赖提升为运行依赖，确保生产安装也可提取 PDF。
- 「生成图片 Prompt」直接调用会议分析 LLM：优先采用会议设置当前的 API Key/base URL/model，否则用服务端会议 LLM 配置。缺少配置明确提示，不悄悄切换 Agent。
- 高光默认只取点击时最近 60 句确认转写（上限 12000 字符），保留动作证据；未确认的尝试不能写成战果，不确定的“我”不能猜角色。**生成设置**可把范围改为「全部转写」「最近 N 句」或「指定段落」。
- 开启直接生图后，提示词和最多 4 张实际出场角色头像送到现有 profile 图像 API；返回图片在图库显示，点击放大后查看/编辑提示词。失败保留提示词可重试。provider/model 留空使用 profile 图像配置，不硬编码图像模型名称。
- 高光卡片支持**手动上传图片**（PNG/JPEG/WebP，≤ 5 MB）补上或替换生成结果：网页版超时、模型拒答时，可先在别处出图再上传回来，卡片仍保留提示词与 ASR 证据。上传图记录 `imageName`，`imageModel` 标记为「手动上传」，并随卡片一起持久化。
- 高光**不再按 30 条丢弃**：`TrpgPanel` 只 `unshift` 不 `slice`，图库默认显示最近 `HIGHLIGHT_RECENT_LIMIT`（30）条，底部「展开更早的 N 条高光」可查看并上传/替换更早的卡片；图库标题右侧的「管理高光」跳转到小说的插图页。
- ChatGPT 网页版生图走**异步任务 + 轮询**：`POST /api/hermes/media/chatgpt-web-image` 带 `async:true` 立即返回 `job_id`（202），客户端每 3s 轮询 `GET .../chatgpt-web-image/jobs/:jobId`，生成中的**瞬时失败会自动重试而不是 502**；完成的 job 服务端保留 1 小时（最多 30 个，按 profile 隔离）。面板会显示「打开项目 / 上传参考图 / 输入提示词 / 发送 / 等待 / 绘制 / 取图」各阶段。会话开始等待跟随 `timeout_ms`（下限 60s、上限 5min），且同时接受 `/c/<id>` 或停止按钮出现。
- 未命名角色草稿允许保存，不参加高光；已命名角色仍要求名称唯一、长度不超过 80 字，角色总数最多 20。
- 角色、头像、高光与设置存在独立 IndexedDB，按服务器、用户、profile、会议隔离；高光全部保留，不再截断（仅默认只显示最近 30 条）。离开前保存。
- 骰子区仅保留摄像头枚举、设备选择与禁用的检测按钮。没有启动摄像头、加载 ONNX 或连接 yolo 推理服务。

## 生成设置（ASR 范围与编年史配图）

场景命令栏的「⚙ 设置」打开 `GenerationSettings.vue`，一个入口集中三件事：

1. **高光转写范围** `campaign.asrSettings.highlight`：全部 / 最近 N 句 / 指定段落（默认最近 60 句）。
2. **编年史转写范围** `campaign.asrSettings.recap`：同上（默认全部）。`RecapSection` 用 `scopedSentences()` 取子集后再 `prepareRecap`，因此快照大小可控。
3. **编年史配图**：选择已保存编年史 + 封面/内容（内容可指定章节），用同一套生图设置生成并上传。

范围选择由 `AsrScopePicker.vue` 提供：`buildParagraphs()` 按说话人变化、录音停顿（> 45s）与长度把扁平句表分组为可读段落；勾选结果保存为**句子区间** `segments: {from,to}[]`（`mergeSegments()` 合并重叠/相邻并夹取边界），而不是段落 id，转写变化时不会静默失效。`scopedTranscript()` 从尾部截断到 12000 字符，保证最近的叙事不丢。设置随 campaign 一起存 IndexedDB（`snapshotCampaign()` / `normalizeCampaign()`）。

## 编年史

新增「长文小说化」：选择目标 1/2/4/6 万中文字符，使用当前全部转写和公开外貌，在后台完成分块提取、章节规划、逐场景写作与审核，再组装全书。显示覆盖进度，支持取消、关闭页面后继续、重启后断点续写。章节数可提示 2–24，自动按可用场景调整。篇幅是目标，素材不足会提示；不通过原来的聊天标签页/MCP 一次保存路径。详见 [长文流水线与恢复说明](../../../../../docs/harness/trpg-long-novel.md)。

以下为原有三种模式：

选小说化 / 记录体 / 日志体和语气（默认史诗），可指定 2–8 章；自动通常 3–6 章，短素材允许更少。

1. POST `/api/plugins/trpg/recap` 保存点击时（按生成设置过滤后的）转写快照和公开角色信息，不带头像、角色卡秘密。
2. 服务端创建 Hermes 会话（source=trpg_recap）。点击发生在录音页，因此**本标签页不跳转**：先在手势内 `window.open('about:blank')` 占位，创建会话后把指令写入 `localStorage` 的 `hermes.pending_chat_prompt.<sessionId>`，再把新标签页导航到 `#/hermes/session/<id>`。新标签页的 ChatView 在会话就绪后一次性取出并发送该指令（通用机制，见 `utils/hermes/pending-chat-prompt.ts`）；桌面端走 `openChatWindow`。录音因此不中断。
3. Agent 使用新增的 meetings MCP 工具集逐页读取快照、切章、扩写、回写；不另造一套聊天执行器。每章用 from/to 句子索引（转写返回的 index）锚定证据，服务端据此截取引文；startQuote/endQuote 仍兼容但非必填，highlights 与 timeline 可省略。
4. 返回会议后加载服务端编年史列表，可展开章节、证据、时间线，也可刷新或删除；点「翻开编年史」在新标签页打开独立古籍阅读页。

### 编年史配图（封面 / 章节）

- 图片由 `chronicle-image.ts` 组装提示词：`chronicleCast()` 取该章 highlights 里的角色（封面取全篇；没有 highlights 回退到全部命名角色），`buildChronicleImagePrompt()` 写入标题、章节正文片段、角色外观与「不渲染文字」约束；`chronicleReferences()` 最多附 4 张头像。
- 出图走 `imageRequest.ts` 的 `requestImage()`（与高光共用：图片 API 或 ChatGPT 网页版），再由 `GenerationSettings` 调 `saveRecapImage()` 上传。
- 服务端 `services/trpg/recap.ts` 把图片写到 `recaps/<recapId>.cover[.<chapterId>].<ext>`，并在 `recaps.json` 的条目上记录 `images: RecapImage[]`（kind、chapterId、mime、model、prompt）。同一槽位重写会先删旧扩展名文件，删除编年史时一并清理。`GET/PUT /api/meeting-storage/:meetingId/recaps/:recapId/images/:kind[?chapterId=]` 按 profile 隔离。

### Markdown 存档

保存编年史时，服务端由已校验字段确定性地渲染一份 Markdown 文档，写到 `getWebUiHome()/meetings/<meetingId>/recaps/<recapId>.md`（标题、章节正文、角色高光批注）。重试同一 requestId 覆盖同一文件，删除编年史时一并删除。渲染不含任何本地化标签，正文与标题来自模型，便于离线保存/下载。

- GET `/api/meeting-storage/:meetingId/recaps/:recapId/markdown` 返回 `text/markdown; charset=utf-8`；`?download=1` 加附件头（标题用 RFC 5987 编码）。老记录缺少 .md 时按存储条目即时补写。读取按 profile 隔离。
- MCP 新增 `hermes_studio_meetings_recap_markdown`，可读回已保存的 `.md` 供核对。

### 古籍阅读页（独立网页）

`recap-book.html` + `src/plugins/trpg/recap-book-main.ts` 是 Vite 的第二个入口，独立于 Hermes SPA：不加载 App 外壳、不注册 SPA 路由，URL 形如 `/recap-book.html?meetingId=..&recapId=..`。页面用 `bookApi.ts` 直接带 token + profile 头请求（不 import `@/api/client`，避免把 SPA router 带进来）。

- 样式 `recap-book.css`：D&D 牛皮纸/羊皮卷（feTurbulence 纹理 + 余烬漂浮 + 火把闪烁），深色皮革封面 + 题签 + 红色印章，纸面色差、内阴影与墨迹显影。
- 字体：内置毛笔手写体 `Ma Shan Zheng`（woff2，OFL，`public/fonts/`，本地 `@font-face`，CSP `font-src 'self'`），回退 ZCOOL KuaiLe 与系统楷体。
- 分页：`recapBook.ts` 纯函数切章/切块，`ChronicleBook.vue` 用隐藏度量容器按真实排版分页；单块超页时按句切分，并为章节标题做孤行保护。
- 翻页：统一为 0→1 进度模型。宽屏（≥820px）双页对开，叶子 `preserve-3d` 绕书脊 `rotateY`；窄屏单页绕外缘。**鼠标拖拽直接驱动角度（纸张跟随指针）**，松手按 36% 阈值用 720ms 缓动补完或弹回；点击页边、方向键、底部按钮走同一模型自动补完。中途叠加随进度变化的高光与投影。
- **右侧插画栏**：`RecapBookView` 按条目 `images[]` 用 `loadRecapImage()` 取回字节（带鉴权头，转 object URL）传给 `ChronicleBook`。封面页显示封面图，正文页显示「当前章节」的内容图（无绑定则用全篇内容图）。点击图画或工具栏的 🖼 按钮打开放大层，Esc/点击遮罩关闭；窄屏（≤860px）隐藏侧栏，仅保留工具栏按钮。
- 左侧「人物名册」按钮：抽屉显示玩家头像与基础属性。头像/属性只存在 TRPG 面板的 IndexedDB（`hermes-plugin-trpg` / `campaigns`），阅读页用与面板完全一致的 key（`campaignStorageKey()`）读取；本地没有卡片时回退到编年史自带的角色名单（仅姓名/玩家）。

Skill：`packages/skills/trpg-recap/SKILL.md`，随现有 bundled skill 同步机制安装。MCP：`hermes_studio_meetings_toolset` 的 list/describe/call 暴露 meetings_list/get/transcript_get/recap_save/recap_markdown。

存储在 `getWebUiHome()/meetings/<meetingId>/recaps.json`，Markdown 在同目录 `recaps/<recapId>.md`，快照在同目录 `recap-requests/`。按 profile 过滤；原子写入、会议级串行队列；同一 requestId 的保存重试覆盖原结果。章节正文最多 1800 字符；锚点优先用 from/to 句子索引，手写引句和角色动作证据仍须在快照中逐字出现（允许空白差异）。校验失败返回 `invalid_recap` 加 `detail`，指明具体字段与原因。语义上的剧情一致性仍需读者审阅。

相关 API：GET/PUT `/api/meeting-storage/:meetingId/recaps`、GET `.../recaps/:recapId/markdown`、GET/PUT `.../recaps/:recapId/images/:kind[?chapterId=]`、DELETE `.../recaps/:recapId`、GET `.../transcript?requestId=...&cursor=...`。

## 高光插图页（小说工作台内）

`recap-book.html?workspace=novel&…&panel=highlights` 的「高光插图」页与 `workspace=highlights` 独立页共用 `HighlightWorkbench.vue`：

- 读取与面板相同的 IndexedDB（`campaignStorageKey(meetingId)`），列出全部高光（默认最近 30 条 + 展开更早），可**手动新建**高光（备注/标题、转写原文、生图提示词、可选图片）、就地编辑并保存。手动高光写入 `title` / `source: 'manual'`，与 ASR 生成的高光一起持久化。
- 传入 `jobId` 时读取该长篇任务的 `layout`，选择章节后对某条高光点「关联分析」：`highlight-match.ts` 按句取字符二元组重叠率（`matchHighlight()`）与所选章节各场景的 `evidence` 原文比对，给出关联度百分比、最匹配场景与命中的原句；分数越高越说明这张插图属于该章。
- 若任务已完成（`job.recapId`）且高光带图片，可用「用作本章插画」把图片 base64 上传到编年史的内容图槽位（`PUT .../recaps/:recapId/images/content`），直接对应到生成小说的章节。
- 图库「管理高光」链接优先打开最近的长篇任务并定位到该页；没有长篇任务时退回 `workspace=highlights` 独立页（此时只做增删改，不做关联分析）。

## 边界与验证

前端业务位于本目录；服务端位于 `services/trpg/`，控制器和路由保持薄层。共享字段定义不依赖 Vue/Koa。聊天核心仅增加 recap 来源与现有 Hermes 执行路径衔接；阅读页是独立构建入口，核心 router 不感知。

定向验证涵盖角色草稿解析、PDF 请求形状、会议 LLM 调用、编年史证据/并发/隔离/Markdown 存档、配图槽位校验与删除清理、古籍分页纯函数与组件翻页、阅读页插画栏与放大层、ASR 范围纯函数（段落分组/区间合并/尾部截断）、客户端会话跳转、MCP 协议（含 recap_markdown）、角色/图片浏览器流程及生产构建。模型/生图响应使用 mock，不消耗真实模型额度。服务重启后，新 Skill 与 MCP 配置由现有同步机制加载。
