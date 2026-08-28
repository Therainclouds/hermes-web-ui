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

### 6. Speech Evaluation Mode (演讲评分)
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
