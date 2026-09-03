---
date: 2026-09-02
pr: pending
feature: Speech-practice realtime hardening — full audio drain, Linux bubble scrolling, Qwen3.5-Omni full-modal report analysis
impact: (1) 口语对练/实时对话里 AI 语音不再被「跨工具调用的新响应」或回声误触发打断而中途截断，定时练习到点会先把当前句子播完再断开（useOmniRealtime 新增 stopGracefully，练习倒计时到点走优雅收尾）；(2) 对练全屏舞台左侧对话气泡区在小屏 / Linux 矮窗下可滚动到最底，新内容自动贴底（.practice-stage__stage / .practice-stage__bubbles 布局改为可滚动 + safe center + auto stick）；(3) 练习期间在内存里按轮录制用户语音（16 kHz PCM16 → WAV）并抽样保留摄像头帧，会话结束后点「保存分析报告」时先把录音 + 画面 + 转写 + 逐轮评分交给 DashScope Qwen3.5-Omni（HTTP 全模态，qwen3.5-omni-flash）生成一段「AI 全模态深度分析」，追加到确定性报告末尾再落盘（新增 POST /api/hermes/speech-practice/omni-analysis；素材缺失或模型调用失败时自动回落到原基础报告，不阻断保存）。
---

# 口语对练 realtime 三连修：音频播完、Linux 滚动、Qwen3.5-Omni 全模态评分报告

## 1. 「一段语音没播完就停了」的音频链路修复（useOmniRealtime）

三处根因，一并加固：

- **跨工具调用截断（主因）**：口语对练每轮 = 教练先说一句点评 → 调用
  `submit_practice_feedback` → `tool_result` 后 DashScope 立即 `response.create`
  发起续接响应。续接的 `response_started` 到达时上一句的音频往往还在扬声器
  里播放（drain 阶段），旧的 `response_started` 处理会 `stopPlayback()` 把尾巴
  掐掉——用户听到点评说一半就没了。修复：`response_started` 落在
  `TOOL_CONTINUATION_WINDOW_MS`（2s）内、紧跟我们自己发出的 `tool_result` 时，
  视为同一句话的续接，**不再停播**，新 chunk 由 `nextPlayTime` 自然排队接续。
- **回声误打断**：本地 barge-in 阈值 0.12 + 3 帧连击在 AEC 较弱/缺失的平台
  （部分 Linux 浏览器/声卡）会被扬声器回声误触发，把 AI 自己说的话掐断。
  修复：AI 输出期间（`isOutputPlaying` 或 `speaking`）要求更高峰值
  （0.16）与更长连击（6 帧）才判为用户开口。
- **倒计时到点截断**：`SpeechPracticeStage` 定时练习到点原先是立即
  `disconnect()`（停播），教练最后一句会说到一半被切断。修复：新增
  `useOmniRealtime.stopGracefully(timeoutMs)`（停推流 → flush pending →
  等 `isOutputPlaying` 归零 → 再 disconnect），`autoFinishByTimer` 改为先
  `stopGracefully(6000)` 收尾再进入结束面板并自动保存报告。手动「结束」仍
  即时断开（用户手势即意图）。

## 2. Linux 显示下对话泡泡无法滚到底部（SpeechPracticeStage 布局）

对练全屏舞台左栏原先整体 `overflow:hidden` + `justify-content:center`：矮窗 /
小屏 Linux 显示下「视觉球 + 气泡 + 提示 + 控件」超出一屏后，最新气泡/控件被
裁在视口外且没有任何滚动入口。

- `.practice-stage__body` 固定单行高度 `grid-template-rows: minmax(0, 1fr)`；
- `.practice-stage__stage` 改为 `overflow-y:auto` + `safe center`
  （不支持 safe 的浏览器回落 center），超高即可滚动、上下两端都滚得到；
- `.practice-stage__visualizer-zone` 尺寸改为 `min(46vw, 420px, 42vh)`，
  矮屏让出高度；气泡层 `.practice-stage__bubbles` 变成有界滚动层
  （`max-height: min(36vh, 320px)` + 细滚动条），内部
  `.practice-stage__bubbles-inner` 保持 flex 列；
- 新增 auto-stick：用户停在底部时新气泡/live 文本自动把容器推到最底，
  用户上翻历史时不打扰（`handleStageScroll` / `scrollLiveToLatest`）。

## 3. 结束后「根据音频和视频」用 Qwen3.5-Omni 生成评分报告

现状：报告由 `buildPracticeReportMarkdown` 确定性聚合逐轮工具评分 + 转写生成，
不「听」录音也不「看」画面。本次新增 AI 全模态深度分析段：

- **素材收集（仅内存、随舞台关闭丢弃）**
  - 用户录音：`useOmniRealtime` 新增 `onUserTurnAudio` 回调——服务端 VAD
    打开用户轮次时把上行同源的 16 kHz PCM16 攒进缓冲，`user_transcript`
    提交时连同转写文本回调给舞台；舞台用
    `trimPcm16Silence`（裁首尾静音、截到 ≤20s）→ `encodePcm16ToWavBase64`
    生成 WAV，保留最近 12 段。
  - 摄像头帧：`captureAndSendFrame` 抽样保留最近 24 张 JPEG data URL
    （发送给实时模型的同款镜像画面）。
- **服务端**：新增 `POST /api/hermes/speech-practice/omni-analysis`
  （controller → `services/speech-practice-omni.ts`）。按百炼官方文档
  （help.aliyun.com/zh/model-studio/qwen-omni）走 OpenAI 兼容端点
  `…/compatible-mode/v1/chat/completions`：`model=qwen3.5-omni-flash`
  （可 body 覆盖）、`stream:true`（SSE，Qwen-Omni 强制）、`modalities:["text"]`；
  媒体 part 形态 `input_audio.input_audio.data="data:;base64,…"`（format wav）
  与 `image_url.url=data:image/jpeg;base64,…`。Key 解析：请求方提供的
  apiKey 优先，其次读 meeting-asr 持久化目录
  （`MEETING_ASR_DATA_DIR` 或 `cwd/data/meeting-asr` 的 config.json /
  config.env），再回落 `DASHSCOPE_API_KEY` 环境变量。输入有防御性上限
  （段数 12 / 单段 1e6 base64 字符 / 总量 11e6 / 帧 6），总量超预算丢最旧段。
- **客户端**：`handleSaveReport` 变为两步——先
  `requestOmniPracticeAnalysis`（有素材时）拿到 AI 段，用
  `composePracticeReportWithOmniAnalysis` 拼到确定性报告末尾，再走既有
  `/report` 落盘 + 下载。素材缺失或模型调用失败自动回落基础报告并显示
  状态行（不阻断保存）；新增 i18n：`speechPractice.reportAnalyzing /
  reportAnalyzed / aiAnalysisFailed`（11 个 locale）。
- 隐私说明：录音与帧仅在浏览器内存中存在；只有用户点击保存报告时才随请求
  上传到本服务端，服务端不落盘媒体，仅转给 DashScope 分析后返回文本。

## Files

- `packages/client/src/composables/useOmniRealtime.ts`（播放截断修复 +
  `stopGracefully` + `onUserTurnAudio`）
- `packages/client/src/components/hermes/chat/SpeechPracticeStage.vue`
- `packages/client/src/utils/practice-mode.ts`（WAV 编码 / 裁静音 / 抽帧 /
  报告拼接纯函数 + 预算常量）
- `packages/client/src/api/hermes/practice-report.ts`（omni-analysis API）
- `packages/server/src/services/speech-practice-omni.ts`（新）
- `packages/server/src/controllers/hermes/speech-practice.ts`
  （`generateOmniAnalysis`）
- `packages/server/src/routes/hermes/speech-practice.ts`
- `packages/client/src/i18n/locales/*.ts`（11 locale）
- 测试：`tests/server/speech-practice-omni.test.ts`、
  `tests/server/speech-practice-omni-controller.test.ts`（新），
  `tests/client/utils/practice-mode.test.ts`、
  `tests/server/speech-practice-wiring.test.ts`（扩展）

## 追加（同日二次反馈）：结束面板改“md 看板” + AI 流式生成 + 聊天页下载按钮

用户反馈：结束后想看方便阅读的渲染报告，而不是纯数字评分页；AI 生成过程要
实时流式返回（默认 text-only 省 token，有音频才播）；报告文件要在 Hermes
对话页出现可下载按钮。

- **结束面板改为渲染整份报告的 “md 看板”**：替换原来的平均分/汇总表数字区，
  直接 `MarkdownRenderer` 渲染 `基础报告 + AI 全模态分析`（含评分表、逐轮
  点评、对话记录与 AI 评审章节），内部纵向可滚、矮屏也能看全文。
- **AI 流式实时生成**：服务端 `streamOmniPracticeAnalysis`（async generator）
  把 DashScope 兼容端点 SSE 的文本增量逐段 yield；controller 在
  `body.stream=true`（或 `?stream=1`）时以 `text/event-stream` 转发
  `data: {"type":"delta"|"error"|"done",…}`，客户端断开即 abort 上游省 token；
  客户端 `streamOmniPracticeAnalysis` 解析增量并把每段实时追加进 aiSection，
  看板随生成过程实时渲染（贴底跟随，用户上翻不打扰）。请求保持
  `modalities:["text"]`（不申请音频、最省 token）；若将来需要朗读报告再开
  `audio`，客户端已能忽略未知事件字段。
- **结束即自动出报告**：`finalizeSession` 触发 `runEndReportFlow`——流式生成
  AI 段 → 拼最终 Markdown 落盘（/report）→ 保存成功后往该对练会话插入一条
  带附件（文件名 + 大小 + 下载图标）的 assistant 消息，聊天页气泡里即出现
  **可下载按钮**（MessageItem 的 attachment 文件块），关闭对练舞台后仍可点。
  保存失败时面板保留“保存分析报告”按钮供重试。
- 旧的数字汇总（avg/table）相关脚本与样式已随看板移除；确定性 md 中本身含
  综合评分表，因此无信息丢失。

## 未做 / 后续

- 播放截断的修复面向「跨工具续接 + 回声误打断 + 定时收尾」三类根因；若在
  具体设备上仍偶发截断，可进一步按设备音量校准
  `LOCAL_BARGE_IN_PEAK_DURING_OUTPUT` / `LOCAL_BARGE_IN_STREAK_DURING_OUTPUT`
  阈值。
- Omni 分析的模型与温度等未暴露到 UI（走常量 `qwen3.5-omni-flash`）；如需
  在设置里选 Plus / 自定义，可扩展 realtime-model store。
- AI 报告看板当前只出文本（省 token）；如用户要“AI 朗读报告”，需要请求
  `modalities:["text","audio"]` 并处理音频播放，属于后续可选增强。

---

## 追加（skill 化 v2：跨场景练习技能 + 同会话收尾总评 + 素材证据）

改动动因：把「实时口语对练」升级为跨场景模块（语言学习 / 销售培训 / 面试陪练 /
知识点掌握测评…），评分、评价标准、打分逻辑、前置提示词全部技能化。

### 练习技能（hermes_practice 契约，schema 1）
- SKILL.md frontmatter 带 `hermes_practice` 即练习技能（复用现有技能页下载/导入/编辑）：
  - `scene` / `targetLanguages`（限定语言，新建对话语言下拉收敛并自动切换、单语言锁定）/
    `directions`（方向占位）/ `entry.{label,hint,voice}`（下拉展示 + 建议音色）；
  - `coach.{soul,role,userRole,interaction,plannedTurns,extraRules,tools}`（前置提示词与
    角色结构；tools 支持工作台工具子集，借鉴 agent 模式）；
  - `evaluation.{scale{min,max,step}, dimensions[{id,label,description,rubric,weight}],
    overallMode(model|weighted|average), resultBands}`——评分维度/量表/打分逻辑可配，
    报告给「结论档位」（如知识点掌握度）；
  - `reviewOnEnd` / `report.{conclusion, omni{enabled,requireAudio,requireFrames,instructions}}`。
- 默认「通用口语教练」与语言类技能沿用六维兼容路径，行为与旧版逐字节一致；
  维度集合本身开放自定义（此前决策已放开，经用户确认）。
- 内置示例技能包 4 个（`packages/skills/practice-*`）：雅思 Part2 考官、新品销售角色扮演、
  知识点掌握测评、行为面试陪练；服务端 `ensurePracticeSampleSkills` 缺失时自动安装到
  profile `skills/practice/`（先例：meeting-asr skill-resolver；测试环境跳过）。

### 服务端
- `GET /api/hermes/skills/practice`（本地 + 外部目录）：解析 frontmatter（js-yaml
  DEFAULT_SCHEMA）、校验 schema=1、白名单字段，返回
  `{category,name,description,enabled,source,manifest}`；路由注册在 `{*path}` 之前。
- 深度分析提示词 v2：`config.skill{displayName,criteria,instructions,background}` 注入
  「练习技能（评分标准）」段与「技能专属评审要求」；逐轮评分改按维度 id 通用打印
  （不再绑定语言五维）；SSE 首帧新增 `{type:"meta",audioSegments,frames,model}`。

### 客户端
- 新 `utils/practice-skill.ts`（纯函数）：契约类型/归一化/默认技能/语言绑定/
  维度读取/综合分聚合/结论档位/评分工具 schema 生成（`submit_practice_feedback`
  按技能动态生成，overall+维度必填、量表进 min/max）/收尾总评指令/收尾语识别。
- `ChatPanel`：新建对话 ▸ realtime ▸ 口语对练新增「练习技能」下拉（默认=通用口语教练 +
  已下载练习技能）；语言下拉随技能 `targetLanguages` 收敛/锁定/自动切换；方向占位用技能
  directions；`config.skillRef{category,name}` 随会话持久化（localStorage v2 兼容 v1）。
- `SpeechPracticeStage`：按 skillRef 拉取并归一化技能 → connect 用技能 coach soul/
  守则/工具集（工作台子集 + 动态评分工具，`useOmniRealtime.setTools`）；评分卡维度/
  量表随技能渲染；反馈记录顶层写入技能维度分；报告头部带技能名与素材证据行、
  附录带「技能与评价标准」、综合分/结论档位按技能算法。
- `useOmniRealtime`：新增 `drainOutput()`、`askText()`（同会话文本注入，闭麦排空后
  收集教练语音转写）与 `setTools()`；connect 可传本次工具集。
- python 代理：客户端控制帧 `{"type":"text","text":...}` → `conversation.item.create`
  （input_text）+ `response.create`（同会话复用已看/已听上下文，不另开离线窗口）。

### 收尾总评（复用 WS 上下文）
- 倒计时到点/手动结束且连接存活、技能 `reviewOnEnd`、用户末句非口头收尾语时，
  先 `drainOutput` → `askText(收尾总评指令)` → 教练口头总评（转写进会话与报告）→ 断开。
- 失败/超时静默，离线全模态深度分析照常兜底（书面、可下载）。

### 素材证据（media manifest）
- 结束面板 AI 状态显示「正在听 N 段录音 · 看 M 帧画面」；SSE meta 双保险。
- md 报告头部与聊天下载消息固定带证据行（用了哪些素材 / 无素材的明确说明）。
