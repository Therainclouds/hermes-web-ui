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
