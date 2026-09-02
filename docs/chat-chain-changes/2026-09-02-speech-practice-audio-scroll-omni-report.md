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

## 未做 / 后续

- 播放截断的修复面向「跨工具续接 + 回声误打断 + 定时收尾」三类根因；若在
  具体设备上仍偶发截断，可进一步按设备音量校准
  `LOCAL_BARGE_IN_PEAK_DURING_OUTPUT` / `LOCAL_BARGE_IN_STREAK_DURING_OUTPUT`
  阈值。
- Omni 分析的模型与温度等未暴露到 UI（走常量 `qwen3.5-omni-flash`）；如需
  在设置里选 Plus / 自定义，可扩展 realtime-model store。
