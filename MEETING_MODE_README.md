# Meeting Mode - Hermes Web UI v0.73

## Overview

This update adds a comprehensive Meeting Mode to Hermes Web UI, enabling real-time speech-to-text transcription, speaker diarization, AI-powered analysis, and meeting management.

## Features

### 1. Real-time Speech Transcription
- WebSocket-based connection to Alibaba Cloud Paraformer ASR
- Real-time audio visualization with waveform display
- Support for both real-time transcription and speaker diarization modes

### 2. Meeting Management
- Create, save, and manage multiple meeting sessions
- Persistent storage using localStorage
- Meeting list in sidebar with quick access

### 3. AI Analysis Integration
- **Hermes Agent Mode**: Uses local Hermes Agent for intelligent meeting analysis
- **Custom Model Mode**: Supports external AI model configuration
- Automatic generation of meeting summaries, key points, action items, and topics
- HTML report generation with beautiful styling

### 4. Audio Recording & Playback
- Local audio recording and storage
- Playback with synchronized transcript highlighting
- Download audio files in WebM format

### 5. Export Capabilities
- Download transcript as TXT with timestamps
- Download audio recording
- Download AI analysis report as HTML

### 6. Configuration
- Alibaba Cloud DashScope API Key configuration
- ASR model selection (paraformer-realtime-v2, paraformer-v2)
- Hermes Agent profile selection for analysis

### 7. Whole-file transcription & post-recording speaker separation (2026-02)

The realtime path streams audio to the ASR as it is captured. Two additional
entry points send the **whole recording** instead, which is what the upstream
APIs need for reliable speaker diarization:

- **「拆分人声」button** (right-panel header, enabled once a recording exists)
  re-sends the finished recording and backfills speaker labels onto the
  transcript. Clicking it opens a small dialog where you pick the recognition
  engine (MiniMax / Qwen) and the speaker count; for Qwen the dialog also
  collects the OSS credentials inline, because DashScope's diarized file API
  only accepts a publicly reachable audio URL. "Start" stays disabled until
  the selected engine is usable, so the backend error is never the first
  feedback the user sees.
  Speaker labels are always rendered in the transcript (the realtime toolbar's
  own diarization switch is a separate, still-hidden control): each sentence
  shows a clickable speaker chip that opens a rename popover, and the new name
  is applied to every sentence of that speaker and synced to the server so a
  reload does not revert it.
- **「直接音频转录」tab** in the create-meeting dialog: pick an audio file,
  choose the engine and whether to separate speakers, then create the meeting —
  transcription starts immediately and the file is stored with the meeting so
  playback/download still work. The original microphone flow lives in the
  **「实时语音」** tab.

Engine support (see `python-backend/app/file_transcribe.py`):

| Engine | Diarization | Limits | OSS required |
|--------|-------------|--------|--------------|
| MiniMax (`asr-1.0`) | ✅ `response_format=verbose_json` + `segments[].speaker` | 500 s / 50 MB per request — longer audio is chunked at 480 s with global timestamps | no |
| Qwen (DashScope) | ✅ only via the async file API (`diarization_enabled`) | sync path: ≤5 min, no diarization | diarization only |

The create-meeting UI disables 区分人声 for Qwen (the sync endpoint has no
speaker labels). The 「拆分人声」 dialog, by contrast, exposes the OSS fields
inline for Qwen and enables the action once a bucket + AccessKey pair is
provided; the backend contract is the same API used by direct calls
(`POST /api/meeting-asr/transcribe/file?engine=qwen&diarize=true`). Because the
engine is chosen per action, both credentials are pushed to the backend —
`MeetingASRService.updateConfig()` forwards the MiniMax fields too, so a
DashScope session can still run a MiniMax pass without a restart.

Uploaded containers (webm/mp3/wav/m4a/…) are decoded to 16 kHz mono Int16 PCM
with `ffmpeg` (a declared device/Docker dependency). Transcription runs as a
background job so a long poll cycle never holds an HTTP request open:

- `POST /api/meeting-asr/transcribe/file?engine=&diarize=&speakerCount=&language=&sessionId=`
  — raw audio body → `{ job_id }`
- `GET /api/meeting-asr/transcribe/status/:jobId` — `{ status, progress, result | error }`

**Stale-backend self-heal.** The uvicorn child imports its Python modules once
at spawn, so rebuilding `dist/` and refreshing the browser updates the client
but leaves the running backend on the old code — a fixed bug keeps reproducing
until the service is restarted by hand. To prevent that:

- `MeetingASRService` hashes `python-backend/**/*.py` at spawn, passes it to the
  child as `MEETING_ASR_CODE_HASH`, and respawns on the next `start()` when the
  hash on disk changed (`status.codeHash` exposes the current value);
- `/healthz` advertises `transcribe` (a capability marker mirrored by
  `TRANSCRIBE_CAPABILITY` in `MeetingView.vue`) plus `code_hash`;
- both whole-file entry points call `ensureTranscribeBackend()`, which probes
  those fields and stops the service when they do not match, forcing a fresh
  spawn before transcribing.

Job errors carry the failing call site, e.g.
`not enough values to unpack (expected 4, got 1) [file_transcribe.py:283]`, so a
field report points straight at the code.

**Backend transport + crash diagnostics.**

- Every Node → Python call (health probe, hot config push, analysis proxy, the
  file-transcription proxy and the SSE stream) uses `node:http(s)`. undici's
  `dispatcher` option rejects a `node:https.Agent` with `agent.dispatch is not
  a function`, which used to turn every proxied call into a 502 on device
  images that spawn uvicorn with the self-signed cert
  (`HERMES_WEB_UI_MEETING_ASR_TLS=true`).
- `start()` picks the first **free** port at/after the configured one. A
  `detached:false` uvicorn survives a Node restart and keeps 8000/8001; without
  this, the new child failed to bind while `waitForReady` got healthy answers
  from the orphan — which still ran the old code.
- The child's stdout/stderr keeps a bounded 25-line tail; an unexpected exit
  folds it into `status.error`, which the 503 body exposes as `detail`. The UI
  logs that raw detail to the browser console and shows a targeted message
  (service restarting vs. job lost) instead of a bare HTTP status.

### 8. Speech Evaluation Mode (演讲评分)
- **陪伴型成长教练 AI 点评**：实时点评与最终报告都以温暖、说人话的方式输出，先肯定再给方向，多鼓励（不输出正式文档/工作汇报风格）。
- **3+1 反馈**：每轮最多 3 条亮点 + 1 个最重要、可落地执行的提升点。
- **按发言人区分**：赘语、金句、语法问题尽量带 speaker 标注；设备/主持人串场词不作为演讲内容评价；报告按发言人呈现金句与用时。
- **赘语宽容判定**：明确赘语清单（呃/啊/那个/然后/就是说…），平均 3 分钟 10 个以下不算问题。
- **金句定义**：有观点、有感染力、能让人记住、可单独引用的一句话，注明出处与理由。
- **方言/口音过滤**：因方言或识别偏差导致的"不通顺"不作语法问题报出。
- **肢体语言与台风**：AI 看不到画面，由人工记录观察（表情/手势/眼神/站姿），报告结合观察点评并给出台风建议。
- **串场计时**：计时器支持"演讲计时 / 串场计时"两种模式，串场用时进入报告，AI 在时间把控评分中体现。
- **声音提醒**：黄牌 / 红牌 / 时间到 时语音播报（浏览器 TTS），可在计时区一键开关。
- **发言人用时**：根据转写时间戳估算每位发言人的用时，展示在面板并注入报告数据。

## Technical Implementation

### New Files
- `packages/client/src/stores/hermes/meeting.ts` - Meeting state management store
- `packages/client/src/views/hermes/MeetingView.vue` - Main meeting page component

### Modified Files
- `packages/client/src/router/index.ts` - Added meeting route
- `packages/client/src/App.vue` - Added meeting to page sidebar list
- `packages/client/src/components/layout/PageSidebarNav.vue` - Added meeting button
- `packages/client/src/i18n/locales/zh.ts` - Chinese translations
- `packages/client/src/i18n/locales/en.ts` - English translations

### API Integration
- WebSocket connection to ASR service (port 8000/8001)
- Hermes Web UI `/api/chat-run/runs` for AI analysis
- Local audio recording using MediaRecorder API

## Usage

1. Click the meeting icon in the bottom navigation bar
2. Enter meeting name and configure ASR API Key
3. Select analysis mode (Hermes Agent or Custom Model)
4. Click "Create Meeting" to start
5. Use the microphone button to start/stop recording
6. Click "Analyze Now" to generate AI analysis
7. Use download buttons to export audio, transcript, or report

## Configuration

### ASR Configuration
- **DashScope API Key**: Required for speech recognition service
- **WebSocket URL**: Default `wss://ws-ldehaph6v8h68lwu.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
- **Model**: `paraformer-realtime-v2` for real-time, `paraformer-v2` for file transcription

### Analysis Configuration
- **Hermes Agent**: Uses local Hermes Agent with selected profile
- **Custom Model**: Configure external AI provider and model

## Dependencies

- Alibaba Cloud DashScope API for ASR
- Hermes Agent for AI analysis (optional)
- Browser MediaRecorder API for audio recording

## Notes

- Audio data is stored locally in the browser
- Meeting data persists across sessions using localStorage
- CORS configuration may be needed for external ASR service access
