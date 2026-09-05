<p align="center">
  <strong>Hermes Studio</strong>
  <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  A desktop app, local runtime, and web console for Hermes Agent.<br/>
  Chat with agents, manage models and profiles, connect platform channels,<br/>
  automate jobs, inspect files, run coding agents, and keep everything local.
  A full-featured web dashboard for Hermes Agent.<br/>
  Manage AI chat sessions, monitor usage & costs, configure platform channels,<br/>
  schedule cron jobs, browse skills — all from a clean, responsive web interface.
</p>

<p align="center">
  <code>npm install -g @quanthermes/hermes-web-ui && hermes-web-ui start</code>
</p>

## Core Capabilities

| Area | What Hermes Studio does |
| --- | --- |
| Agent chat | Runs Hermes Agent conversations with streaming responses, tool traces, file upload/download, and persistent local sessions. |
| Local control plane | Manages profiles, providers, models, credentials, memory, skills, plugins, logs, and runtime settings from one dashboard. |
| Automation | Configures platform channels, cron jobs, Kanban tasks, group-chat rooms, and MCP servers around the same Hermes profiles. |
| Workspace tools | Provides a file browser, web terminal, voice input/output, coding-agent runners, device discovery, and performance views. |
| Distribution | Ships as a desktop app for Windows/macOS/Linux, an npm CLI package, and a Docker image. |

## Features

### AI Chat

- Real-time chat streaming over Socket.IO `/chat-run`; chat runs execute through the Hermes agent bridge
- Multi-session management — create, rename, delete, switch between sessions
- **Self-built session database** — local SQLite storage for Web UI sessions; Hermes state.db remains a read-only source for Hermes history APIs
- Session grouping by source (Telegram, Discord, Slack, etc.) with collapsible accordion
- Active session indicator — live sessions pin to top with spinner icon
- Sessions sorted by latest message time
- Markdown rendering with syntax highlighting and code copy
- Tool call detail expansion (arguments / result)
- Profile-scoped file uploads
- File download support — download uploaded files and agent-generated files by resolved path across local, Docker, SSH, and Singularity backends
- Session search — Ctrl+K search across the Web UI local session database; read-only Hermes history sessions are not included
- Profile-aware model selector — discovers models available to the signed-in account through authorized Hermes profiles
- Per-session model display badge and context token usage

### Platform Channels

Unified configuration for **8 platforms** in one page:

| Platform      | Features                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Telegram      | Bot token, mention control, reactions, free-response chats             |
| Discord       | Bot token, mention, auto-thread, reactions, channel allow/ignore lists |
| Slack         | Bot token, mention control, bot message handling                       |
| WhatsApp      | Enable/disable, mention control, mention patterns                      |
| Matrix        | Access token, homeserver, auto-thread, DM mention threads              |
| Feishu (Lark) | App ID / Secret, mention control                                       |
| WeChat        | QR code login (scan in browser, auto-save credentials)                 |
| WeCom         | Bot ID / Secret                                                        |

- Credential management writes to `~/.hermes/.env`
- Channel behavior settings write to `~/.hermes/config.yaml`
- Per-platform configured/unconfigured status detection

### Usage Analytics

- Total token usage breakdown (input / output)
- Session count with daily average
- Estimated cost tracking & cache hit rate
- Model usage distribution chart
- 30-day daily trend (bar chart + data table)

### Scheduled Jobs

- Create, edit, pause, resume, delete cron jobs
- Trigger immediate execution
- Cron expression quick presets

### Kanban

- Profile-aware Kanban board for planning and tracking agent work
- Task creation, updates, and status movement from the dashboard
- Shared with the same local Web UI state and authentication model

### Model Management

- Auto-discover models from credential pool (`~/.hermes/auth.json`)
- Fetch available models from each provider endpoint (`/v1/models`)
- Add, update, and delete providers (preset & custom OpenAI-compatible)
- OpenAI Codex & Nous Portal OAuth login
- Provider URL auto-detection for non-v1 API versions (e.g. `/v4`)
- Provider-level model grouping with default model switching

### Multi-Profile

- Create, rename, delete, and switch between Hermes profiles
- Clone existing profile or import from archive (`.tar.gz`)
- Export profile for backup or sharing
- Profile-scoped configuration, cache, uploads, sessions, jobs, usage, memory, skills, plugins, providers, and model visibility
- Account-bound profile access: super administrators can manage every profile; regular administrators only see and use profiles assigned to their account

### File Browser

- Browse files on remote backends (local, Docker, SSH, Singularity)
- Upload, download, rename, copy, move, and delete files
- Store uploaded files under the selected/requested Hermes profile while keeping downloads path-based for agent-generated artifacts outside the upload directory
- Create directories
- View file content with syntax highlighting

### Group Chat

- Multi-agent chat rooms with real-time messaging via Socket.IO
- @mention routing — mention an agent to trigger a contextual reply
- Context compression — automatic conversation summarization when history exceeds token threshold
- Typing status and reply progress indicators
- Room creation, deletion, and invite code management
- Agent management — add/remove agents from rooms with per-agent profiles
- SQLite message persistence
- Mobile responsive with collapsible sidebar

### Coding Agents

- Launch and monitor local coding-agent sessions from the web dashboard
- Dedicated proxy routes for Codex and Claude Code integrations
- DeepSeek Harness (`deepseek-harness`) as a managed coding agent, driven over JSON-RPC stdio and mapped onto the same streaming event pipeline
- Stores agent output and reasoning metadata for later inspection

### Skills & Memory

- Browse and search installed skills
- View skill details and attached files
- User notes and profile management

### Logs

- View agent / server / error logs
- Filter by log level, log file, and keyword
- Structured log parsing with HTTP access log highlighting

### Admin & Runtime Management

- Device and LAN peer views for local-network discovery and peer tooling
- MCP manager for the managed `hermes-studio` MCP server and profile injection
- Runtime version and version-preview tooling for testing newer builds in isolation
- Performance monitor views for super administrators

### Authentication

- Token-based auth (auto-generated on first run or set via `AUTH_TOKEN` env var)
- Username/password login with account management in Settings
- Default bootstrap credentials are `admin` / `123456`; users are prompted after login to change the default username and password
- Super administrators can manage users and profile bindings; regular administrators can manage their own account details

CLI maintenance commands:

```bash
# Delete persisted login IP lock records
hermes-web-ui clear-login-locks

# Delete login locks and restart the running Web UI process
hermes-web-ui clear-login-locks --restart

# Create or reset the default super administrator login to admin / 123456
hermes-web-ui reset-default-login
```

`clear-login-locks` removes `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/.login-lock.json`. If the server is running, restart it to clear in-memory lock state. `reset-default-login` updates the Web UI account database; if an `admin` user already exists, its password is reset to `123456` and the account is enabled as a super administrator.

When the login page reports that the IP is locked (HTTP 429/503), the same operations are available directly in the UI as two buttons — "Clear Login Lock" and "Reset Default Password" — protected by a single shared recovery password. By default the recovery password equals the shipped default admin password (`12345678`); override it with the `HERMES_WEB_UI_RECOVERY_PASSWORD` environment variable to use an independent value.

### Device QR Login (Token Platform)

Hardware Hermes devices (QuantClaw, 量迹龙虾盒子, etc.) can bind themselves to a [Token Platform](https://api.quantclaw.vip) account on first boot by scanning a WeChat QR code — no manual username/password typing on the device. Once bound, the device holds a dedicated API key + model whitelist and the binding is restored on every subsequent boot.

Flow:

1. Device boots for the first time and the LoginView renders a WeChat QR (`WeChatQrPanel.vue`).
2. The BFF calls Token Platform `POST /api/device-login/request` with the device's stable `hardware_id` (a random UUID persisted under `HERMES_WEB_UI_HOME/device-id`, regenerated only if missing) and receives `{appid, state, redirect_uri}`.
3. User scans the QR with WeChat and confirms on the phone.
4. The device polls `GET /api/device-login/status?login_id=..`; on approval Token Platform returns `{api_base, api_key, models, device_id}` (one-shot, `KeyDelivered` flag prevents leak).
5. The BFF (`POST /api/auth/device-login`) validates the device API key via `verifyDeviceApiKey`, resolves the bound user profile, auto-bootstraps a local `admin` super admin on first run, issues a Hermes JWT, and persists the binding to `${HERMES_WEB_UI_HOME}/device-binding.json` (`api_base / api_key / models / display_name / username / bound_at / expires_at`).
6. On later boots, `useDeviceBinding` reads `device-binding.json` and calls `POST /api/auth/device-login/restore` to re-issue a Hermes JWT without re-scanning.

Configuration:

- `TOKEN_PLATFORM_BASE_URL` (default `https://api.quantclaw.vip`) — Token Platform base URL.
- `HERMES_WEB_UI_HOME` — directory holding `device-id` and `device-binding.json`.

Endpoints (Web UI BFF):

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/device-login` | none | Complete WeChat-scan login with `{api_base, api_key, device_id, device_name, models}`. |
| `POST` | `/api/auth/device-login/restore` | none | Re-issue JWT from a persisted `device-binding.json` on later boots. |
| `GET`  | `/api/auth/device-binding` | required | Read the currently persisted binding. |
| `DELETE` | `/api/auth/device-binding` | required | Clear the binding so the next boot shows the QR panel again. |

Unbind from the UI: **Settings → Device Binding → Unbind**, or call `DELETE /api/auth/device-binding`. Unbinding only clears the local binding file; the Token Platform account and its device API key remain active until you remove the device from `https://api.quantclaw.vip`.

### Settings

- Display (streaming, compact mode, reasoning, cost display)
- Agent (max turns, timeout, tool enforcement)
- Memory (enable/disable, char limits)
- Session reset (idle timeout, scheduled reset)
- Privacy (PII redaction)
- Model settings (default model & provider)
- Profile and provider configuration

### Voice / TTS / STT

- Read assistant replies aloud from chat and group-chat messages.
- Providers: browser Web Speech, built-in Edge TTS, OpenAI-compatible `/audio/speech`, custom OpenAI-compatible TTS endpoints, and MiMo.
- MiMo supports preset voices, voice design prompts, and voice clone reference audio (`.mp3`/`.wav`, max 10 MB) with selectable auth header mode (`Authorization`, `api-key`, or both).
- Edge/OpenAI-compatible/custom/MiMo playback uses the Web UI backend's unified `/api/hermes/tts/synthesize` endpoint, so stop/pause state is shared and in-flight fetches are aborted when possible.
- Provider API keys and MiMo clone reference audio are saved in server-side TTS settings, with only masked secret status shown back to the browser.
- Save provider settings in Settings → Voice before using OpenAI/custom/MiMo playback. Message playback sends text and non-secret playback options; the backend reads the stored per-user secret when synthesizing.
- Turn-based voice input is available from the chat input mic control: start/stop a voice turn, transcribe it, stage the transcript in the current input box for editing, then send it with the normal Send button.
- Voice input / STT can use browser speech recognition when available or a server-backed provider configured in Settings → Voice.
- Starting a new voice turn while assistant audio is playing stops playback first. This barge-in boundary does not implicitly cancel an active agent run; stopping a run remains an explicit action.
- For supported settings, security notes, and current non-goals, see [`docs/voice-dialogue.md`](./docs/voice-dialogue.md).
- Limitation: external TTS providers may continue processing a request after the browser/server aborts; custom/OpenAI-compatible and MiMo base URLs must be public `http`/`https` endpoints and cannot target localhost/private networks.

### Meeting Mode

Real-time speech transcription with AI-powered meeting analysis, speaker diarization, and smart meeting minutes generation.

**Core Features:**

| Feature | Description |
|---|---|
| Real-time Speech Transcription | WebSocket connection to ASR service for live speech-to-text |
| Speaker Diarization | Alibaba Cloud DashScope Paraformer model for automatic speaker identification |
| Speaker Renaming | Click speaker labels to customize names, auto-syncs to all related sentences |
| Speaker Count Setting | Auto-detect or manually specify 2-8 speakers for improved accuracy |
| Audio Recording & Playback | Record meeting audio with progress bar, drag seek, and click-to-jump on sentences |
| AI Analysis | Hermes Agent or custom model analysis for summaries, key points, and action items |
| Multi-format Export | Download audio (WebM), transcript (TXT), structured JSON data, and HTML reports |

**Speaker Diarization Mode:**

- Enable speaker diarization to automatically identify different speakers
- Manually set speaker count (2-8) to improve identification accuracy
- Speaker IDs are automatically mapped to readable names (Speaker 1, Speaker 2...)
- Rename speakers with auto-sync across all historical records

**JSON Export Format:**

```json
{
  "title": "Meeting Title",
  "createdAt": "2026-07-17T10:00:00.000Z",
  "speakers": [
    { "id": "0", "displayName": "Alice" },
    { "id": "1", "displayName": "Bob" }
  ],
  "sentences": [
    {
      "index": 1,
      "text": "Meeting transcript content",
      "startTimeMs": 1000,
      "endTimeMs": 3500,
      "speakerId": "0",
      "speakerName": "Alice"
    }
  ],
  "analysis": {
    "summary": "Meeting summary",
    "meeting_type": "Project Update",
    "key_points": ["Point 1", "Point 2"],
    "action_items": [
      { "task": "Draft the rollout plan", "assignee": "Alice", "deadline": "2026-07-25" }
    ],
    "decisions": ["Ship v0.74 behind a feature flag"],
    "risks": ["ASR backend still single-node"],
    "learnings": [],
    "feedback": { "positive": [], "negative": [] },
    "topics": ["Topic 1", "Topic 2"]
  }
}
```

**Analysis pipeline (v0.74):**

- **Typed analysis triggers.** Each session picks one of three modes:
  - `sentences` — auto-analyze every N sentences (default 10, range 1–100).
  - `time` — auto-analyze every N seconds (default 60, range 10–600).
  - `both` — trigger on either condition.
  Configure from the right-panel toolbar (cog icon) or via the `analysisTriggerMode` / `analysisIntervalSentences` / `analysisIntervalSeconds` fields on `MeetingSession`.
- **Meeting type classification.** The LLM first labels the meeting as one of *Minutes*, *Customer Follow-up*, *Brainstorm*, *Project Update*, *Training*, or *Other*, and emits type-specific fields (decisions / feedback / risks / learnings) accordingly.
- **Structured action items.** `action_items` is now `[{ task, assignee, deadline }]` on both the client store and the Python backend. Legacy `string[]` values are still rendered for backward compatibility.
- **HTML report pipeline.** When analysis runs, the server renders a complete, self-contained HTML document (CSS + JS inlined, ECharts only when `relationships` are present) tailored to the detected meeting type. The client caches `html_content`; the Agent panel shows a "View HTML" shortcut and a cached-report banner on the empty state.
- **Composable utilities.** `useMeetingAnalysis` (`packages/client/src/composables/useMeetingAnalysis.ts`) extracts balanced JSON from agent output, escapes HTML, and detects analysis-shaped payloads. Covered by `tests/client/useMeetingAnalysis.test.ts`.

**Reliability patch (v0.74.1):**

- **Broader HTML report extraction.** `useMeetingAgent.ts` now pulls the AI-generated HTML from any of three sources — `write_file` (and similar) tool arguments, the matching tool result, or an assistant ` ```html ` code block (including blocks that only appear after concatenating multiple assistant messages). Falls back to the templated report only when none of the three contain a real HTML document. This stops the empty-state HTML viewer when the agent returns the report inline instead of writing a file.
- **Reentry guards.** `sendMessage` and `runAgent` short-circuit while a run is already in flight (`isRunning` flag), so duplicate clicks on the trigger no longer spawn a second concurrent agent run or fight over the `isRunning` state previously owned by the run callbacks.
- **Aligned Python LLM accessor.** `meeting-asr/python-backend/app/llm_service.py` switched from the deprecated `storage.get_llm_config()` to `storage.get_config().llm`, matching the storage refactor introduced in v0.74. Without this the ASR backend would raise on every analysis or HTML render once the legacy accessor was removed.

**Transcript correction (v0.74.2):**

- **AI transcript correction.** A new "Correct Transcript" action in the agent panel sends the current sentences to Hermes as an ASR proofreading task. The agent returns a JSON `{index, original, corrected}` array; the client applies the changes back into the active session and refreshes `finalSentences`. Implemented by `correctTranscript()` in `useMeetingAgent.ts`, surfaced as a button in `MeetingAgentPanel.vue`, and wired into the session store from `MeetingView.vue` (`onAgentCorrectTranscript`).
- **Auto-close on completion.** The panel now emits a `completed` event when an analysis run finishes; `MeetingView.onAgentCompleted` closes the panel if an HTML report was produced, so the report view takes over without an extra click.
- **Locale strings.** `meeting.correctTranscript` and `meeting.correctTranscriptHint` are added to the English and Chinese locale files. Other locales fall back to the English strings until translated.

**ASR model picker & save-mode (v0.74.3):**

- **Per-meeting ASR model selection.** The create-meeting dialog now exposes an ASR model picker with three options — `paraformer-v2`, `fun-asr`, `fun-asr-mtl` — each with a short description in both locales. The selected model is stored on `MeetingSession.asrModel` and forwarded to the ASR websocket as part of the runtime config.
- **Save mode (diarize-only).** A new `saveMode` toggle on `MeetingView` opens a dedicated `diarize` websocket instead of the live ASR stream. Audio is uploaded to the diarize backend and speaker labels come back asynchronously, which is enough for later analysis/HTML report generation and skips DashScope's per-second ASR billing for users on tight quotas.
- **ASR-only branch.** `startRecording` now splits the websocket setup into three explicit branches — `saveMode` (diarize-only), `useDiarize` (ASR + diarize side-by-side), and the new plain ASR-only path — so users who don't need speaker labels skip the diarize websocket entirely.
- **Speaker rename sync.** `confirmRenameSpeaker` now mirrors the updated `speakerMap` from the store back into the live `MeetingView` refs in addition to `finalSentences`, so a rename reflects immediately without a session reload.

**Transcript correction hardening (v0.74.3):**

- **Robust correction extraction.** `extractCorrections()` in `useMeetingAnalysis.ts` now validates every parsed item (`index` number + `original`/`corrected` strings) and tolerates three extra shapes the LLM occasionally emits: a bare JSON array, a `corrections = [...]` assignment-style line, and a JSON block wrapped in surrounding prose. Invalid payloads return `null` instead of a half-populated array.
- **Stricter proofreading prompt.** The correction prompt in `useMeetingAgent.correctTranscript` was rewritten to be explicit about the proofreading role and to forbid tool calls. A pinned `instructions` is now sent alongside the run so Hermes does not detour into web search or file writes mid-correction.
- **Coverage.** `tests/client/extractCorrections.test.ts` adds 6 cases covering the new shapes and the validation guard (16/16 green).

**Agent panel polish (v0.74.4):**

- **Session-switch reload.** `MeetingAgentPanel.vue` now `watch`es `sessionId` and reloads `messages`, `analysisResult`, and `reportHtml` from the new session, plus resets `isRunning` / `error` / `completed` / `correctedSentences`. Previously the panel kept showing the previous meeting's conversation after the user switched sessions in `MeetingView`.
- **Markdown rendering for assistant content.** The plain-text `<div class="assistant-content">{{ msg.content }}</div>` is replaced with an async-loaded `MarkdownRenderer` so analysis output is rendered as actual Markdown (headings, lists, tables, code blocks) instead of escaped text.
- **Smarter report prompt.** `useMeetingAgent.generateReport` now passes a pinned `instructions` payload to Hermes, includes the session title, and folds in any prior `analysisResult` plus the previous assistant/system messages as `### Previous analysis result` / `### Previous conversation` blocks. This keeps a re-run of "Generate Report" idempotent instead of re-analyzing from scratch, and the strict instructions enforce the `write_file + ```html code block` contract that `extractHtml` looks for.
- **Looser HTML detection.** `looksLikeHtmlDocument` now also accepts `<!DOCTYPE html>` prefixes and drops the minimum-length threshold from 200 to 100 characters, so shorter ECharts-free reports are still recognized as full HTML documents.

### Speech Practice / Oral Coach (v0.8.0)

Real-time voice dialogue with AI-powered oral practice and coaching.

**Core Features:**

| Feature | Description |
|---|---|
| Realtime Voice Dialogue | WebSocket-based Omni realtime conversation with streaming responses |
| Oral Coach Mode | Strict target-language discipline with dedicated coach persona |
| Body Language Scoring | Camera-based gesture and posture analysis during practice |
| Timed Practice | Configurable practice duration with pacing control |
| Session Type Routing | Voice entries automatically route by session type (coach vs. realtime) |
| Dual Theme | Moon/sun celestial artwork that follows light/dark theme |
| Voice Visualizer | 64-bar radial equalizer for audio visualization |
| **Realtime Model Persistence** | Save and restore realtime model settings across sessions |
| **Omni Tool-Call Guard** | Prevents tool calls during voice dialogue for safety |
| **Omni Controller** | Centralized controller for managing Omni realtime connections |

**Visual Design (v0.8.0):**

- Celestial body now rendered as moon/sun SVG artwork that switches with theme
- Voiceprint displayed as 64 radial equalizer bars
- Controls anchor to bottom; speech bubbles no longer overlap text
- Light-mode stage features dawn-gradient backdrop with high-contrast controls
- Unified monochrome ink palette with purple-blue accent throughout

**Coach Persona:**

- Dedicated oral coach persona independent of Agent SOUL — no more personality conflicts
- Strict target-language enforcement: coach responds only in the practice language
- Session entry routes automatically based on session type

**Audio & Report Enhancements (v0.8.0):**

- **Graceful audio shutdown:** Timed practice now drains the current sentence before disconnecting — AI speech is no longer cut off mid-word when the timer expires
- **Cross-tool call fix:** AI responses spanning multiple tool calls no longer get truncated when a new response arrives while audio is still playing
- **Echo interrupt protection:** Improved barge-in threshold on Linux/speakers with weak AEC — AI no longer cuts itself off
- **Qwen3.5-Omni multimodal report:** After each session, audio recordings and camera frames are submitted to DashScope Qwen3.5-Omni for AI-powered full-modal depth analysis, appended to the deterministic report
- **Streaming AI report:** AI analysis streams in real-time as markdown while generating — no waiting for the full result
- **Report download:** After saving, the report file appears as a downloadable attachment in the chat page — accessible even after closing the practice stage

**Legacy Voice Retirement (v0.8.0):**

- The legacy realtime voice page has been retired
- All voice entries now open the unified Omni realtime dialog
- Voice sessions can continue from text-chat context seamlessly

### Document Scanner (v0.8.0)

A camera-driven document scanner plugin. Connect a UVC USB camera, frame the
paper, and let Smart Capture drive the whole pipeline — edge detection, ML
verification, perspective correction, OCR, multi-page PDF, and saving into the
active Hermes profile workspace.

**Core Features:**

| Feature | Description |
|---|---|
| UVC camera preview | Live preview with device picker, idle/live state, and clear error messages for permission / missing-device / browser blocks. |
| Smart Capture | Live edge detection with a draggable selection box; auto-shoots when the box is stable. Manual mode is still available. |
| Multi-page session | Capture, review, re-shoot, delete, and re-OCR each page in a single session. |
| Built-in enhance | Auto levels, contrast/brightness, and black & white controls in the page detail view. |
| OCR | Multi-page OCR via DashScope Qwen-VL-OCR (server route `POST /api/scanner/ocr`). |
| PDF export | Bundle selected pages into an A4 (or original-ratio) PDF with embedded images (server route `POST /api/scanner/pdf`). |
| Workspace save | Persist captured pages and OCR text into the active Hermes profile's workspace (server route `POST /api/scanner/save`). |
| Plugin architecture | Lives under `packages/client/src/plugins/scanner` with its own Vue views, composables, vision modules, and locale bundles (en/zh + 9 others). |

**Vision pipeline (pure JS, runs in a Web Worker):**

- **Multi-strategy detection.** A primary `bright` (Otsu dual-polarity) pass,
  a Canny-style `edge` fallback, and an optional `ml` pass via
  Transformers.js + YOLOv8n (ONNX WASM bundled locally, CSP
  `wasm-unsafe-eval` enabled). Strategies run in parallel; results are merged
  by score.
- **AI proposal revalidation.** ML bounding boxes are not accepted as-is. Each
  proposal is cropped and re-validated against the *current* pixels with the
  classic edge/brightness pipeline, scaled back to full-frame coordinates, and
  re-checked against `minAreaRatio` / `maxAreaRatio`. A pure-prior proposal is
  rejected before it can corrupt the crop.
- **Otsu split for low-contrast pages.** When printed text dominates the dark
  cluster, a second Otsu pass on the upper half of the histogram separates the
  page from a low-contrast background — the previous single-pass Otsu often
  collapsed on invoices or text-heavy pages.
- **Stable Sobel directions.** Sobel gradient directions use 22.5°/67.5°
  sector boundaries so Canny-style hysteresis keeps thicker page edges on the
  correct side of the corner.
- **Robust hull anchoring.** The convex hull always retains its starting
  point; for near-vertical edges after blur, that start can land mid-edge. The
  anchor now walks to the top-left-most point so Douglas–Peucker simplification
  begins on a real corner.
- **Tolerant corner refinement.** When `refinePaperQuad` rejects a tight
  Douglas–Peucker approximation, the algorithm steps to the next tolerance
  rather than dropping the detection entirely.

**Smart Capture UX (v0.8.0):**

- **Sticky selection.** Once the box is shown, a few miss frames no longer
  unmount it — the selection transitions to the `held` state ("Selection
  retained — adjust corners or reset") and the user can still drag, retake, or
  reset.
- **Drag freezes tracking.** A pointer-down on a corner handle calls
  `lockSelection()` so detection results cannot move the crop mid-drag;
  `resumeTracking()` on pointer-up re-enables following without clearing the
  edited corners.
- **Distant target reacquire.** When a moving paper genuinely leaves the box,
  the new position is accepted even if it differs by more than the historical
  stability tolerance — the previous tolerance required capture-level stillness.
- **Bigger handles.** Corner handles grew from 22 px to 44 px so the box is
  easier to grab on touch and high-DPI cameras.
- **Pointer-capture safe.** The drag handler listens for `lostpointercapture`
  so a dropped pointer event (e.g. another window stealing focus) still
  releases the corner cleanly.
- **Reactive proxy safety.** Vue's `reactive()` proxy coordinates are
  `structuredClone`-cloned before `postMessage` to the worker, so the very
  first frame after the user releases a corner is no longer silently dropped.

**Server pipeline:**

- `POST /api/scanner/ocr` — DashScope Qwen-VL-OCR over `data:image/...`
  URLs; validates MIME, page count, and per-image size; reuses the Realtime
  store's DashScope API key when the request omits one.
- `POST /api/scanner/pdf` — packages selected images into a PDF (no external
  PDF dependency; pages are image-embedded).
- `POST /api/scanner/save` — writes images + OCR text into the active Hermes
  profile workspace via `getActiveProfileDir()`; configurable base directory,
  filename pattern, and overwrite policy.

**Coverage:**

- Unit tests for the worker bridge (`scanner-detector-worker.test.ts`),
  vision precision regressions (`scanner-vision-precision.test.ts`),
  enhancement filters, OCR validation, PDF building, and Smart Capture state
  machine (`scanner-smart-capture.test.ts`).
- E2E (`scanner-precision.spec.ts`) exercises the live preview: selection
  retention through `held`, drag-time freeze, post-release camera tracking,
  and 13" laptop vs. mobile viewports.

### Web Terminal

- Integrated terminal powered by node-pty and @xterm/xterm
- Multi-session support — create, switch between, and close terminal sessions
- Real-time keyboard input and PTY output streaming via WebSocket
- Window resize support

### Desktop App & Updates

- Native Electron shell for Windows, macOS, and Linux
- Bundles the Web UI runtime and starts the local Hermes Studio server automatically
- Uses Cloudflare download endpoints for desktop auto-update metadata and assets first
- Falls back to GitHub Releases `latest` assets if the Cloudflare update feed is unavailable
- Windows upgrades attempt to close an existing Hermes Studio process before replacing files

---

## Quick Start

### npm (Recommended)

```bash
npm install -g @quanthermes/hermes-web-ui
hermes-web-ui start
```

Open **http://localhost:8648**

### One-line Setup (Auto-detect OS)

Automatically installs Node.js (if missing) and hermes-web-ui on Debian/Ubuntu/macOS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/main/scripts/setup.sh)
```

### WSL

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/main/scripts/setup.sh)
hermes-web-ui start
```

> WSL uses the same Web UI daemon startup flow as other local installs; no separate gateway service is started by Web UI.

### Docker Compose

Single-container deployment with integrated Hermes Agent:

```bash
# Use pre-built image (Recommended)
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# Or build from source
docker compose up -d --build

docker compose logs -f hermes-webui
```

Open **http://localhost:6060**

- Persistent Hermes data is stored in `./hermes_data`
- Web UI auth token is stored in `./hermes_data/hermes-web-ui/.token`
- On first run with auth enabled, the token is printed to container logs
- All runtime settings are environment-variable driven in `docker-compose.yml`

For detailed notes and troubleshooting, see [`docs/docker.md`](./docs/docker.md).

### Source Deployment Note

For Armbian / Ubuntu host-level source deployment, review [`docs/work-log.md`](./docs/work-log.md) before following deployment steps.

- The 2026-05-19 log records a real failure where Hermes was installed under `root` while `hermes-web-ui.service` ran as `hermesui`
- That mismatch caused the agent bridge to fail with `run_agent.py not found`, and chat requests then hit `ENOENT /tmp/hermes-agent-bridge.sock`
- After source deployment, verify that `/home/hermesui/.local/bin/hermes` belongs to `hermesui` rather than linking into `/root/.local/...`

### Hermes Agent Runtime Discovery

When Web UI starts backend chat features, it prefers a source checkout that
contains `run_agent.py` such as `~/.hermes/hermes-agent`. If no source checkout
is found, it falls back to the Python environment used by the installed
`hermes` command, then the system Python. This supports both source installs
and package installs such as `pip install hermes-agent`.

## Web UI Environment Variables

These variables configure Hermes Web UI itself. Provider API keys and Hermes Agent settings are managed separately through Hermes profiles.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8648` | Web UI listen port. |
| `BIND_HOST` | `0.0.0.0` | Web UI bind host. Set `::` explicitly for IPv6. |
| `HERMES_LAN_ADVERTISE_URL` | unset | Reachable Studio origin used in App LAN QR codes. Set this to the Docker host's LAN URL when Studio is opened through `localhost`, for example `http://192.168.1.20:6060`. |
| `HERMES_APP_ENTITLEMENT_REQUIRED` | `true` | Require a valid cloud-signed App entitlement before accepting a LAN App relay connection. Set `false` only for temporary compatibility diagnostics. |
| `HERMES_APP_ENTITLEMENT_PUBLIC_KEY` | built in | Optional PEM public-key override for RS256 App entitlements. The expected issuer is `hermes-studio-server` and audience is `ekko-studio`. |
| `HERMES_WEB_UI_HOME` | `~/.hermes-web-ui` | Web UI data home for auth token, credentials, logs, DB, and default uploads. `HERMES_WEBUI_STATE_DIR` is also supported as a compatibility alias. |
| `HERMES_WEBUI_STATE_DIR` | unset | Compatibility alias for `HERMES_WEB_UI_HOME`. |
| `HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT` | unset | Disable startup injection of the managed `hermes-studio` MCP server into Hermes profile configs. |
| `HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT` | unset | Allow managed MCP injection when `HERMES_WEB_UI_HOME` is under a temporary directory, such as Version Preview runtimes. |
| `UPLOAD_DIR` | `$HERMES_WEB_UI_HOME/upload` | Upload root override. Files are stored below profile-scoped subdirectories. |
| `CORS_ORIGINS` | same host only | Comma- or space-separated cross-origin allowlist for HTTP, Socket.IO, and WebSocket requests. Set `*` only when you intentionally need legacy wildcard CORS. |
| `AUTH_TOKEN` | auto-generated | Explicit bearer token. If unset, Web UI creates one under `HERMES_WEB_UI_HOME`. |
| `PROFILE` | `default` | Startup/default Hermes profile. Runtime requests use the profile selected by the frontend and authorized for the current account. |
| `LOG_LEVEL` | `info` | Server log level. |
| `BRIDGE_LOG_LEVEL` | `$LOG_LEVEL` or `info` | Bridge log level. |
| `MAX_DOWNLOAD_SIZE` | `200MB` | Maximum file download size. |
| `MAX_EDIT_SIZE` | `10MB` | Maximum editable file size. |
| `WORKSPACE_BASE` | current user's home directory | Base directory for workspace browsing. |
| `HERMES_HOME` | platform default | Hermes data home. Windows uses `%LOCALAPPDATA%\hermes`; macOS/Linux uses `~/.hermes`. |
| `HERMES_BIN` | `hermes` | Custom Hermes CLI binary path. |
| `HERMES_AGENT_ROOT` | auto-discovered | Hermes Agent source checkout containing `run_agent.py`. |
| `HERMES_AGENT_BRIDGE_PYTHON` | auto-discovered | Python interpreter used to launch the agent bridge. |
| `HERMES_AGENT_BRIDGE_UV` | auto-discovered | `uv` executable used to launch the agent bridge when available. |
| `UV` | auto-discovered | Fallback `uv` executable path. |
| `PYTHON` | auto-discovered | Fallback Python executable for the agent bridge. |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | platform default | Agent bridge broker endpoint. Windows defaults to `tcp://127.0.0.1:18765`; macOS/Linux defaults to `ipc:///tmp/hermes-agent-bridge.sock`. |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | `120000` | Timeout for Node requests to the bridge broker. |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | `5000` | Short retry window for connecting to the bridge socket. |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | `120000` | Timeout while waiting for the Python bridge to become ready. |
| `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN` | enabled | Stop the bridge broker during Web UI shutdown and restart. Set `0`, `false`, `no`, or `off` to keep the bridge across restarts. |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | enabled | Auto-restart the bridge broker after unexpected exit. Set `0`, `false`, `no`, or `off` to disable. |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | `1000` | Base delay for bridge auto-restart backoff. |
| `HERMES_AGENT_BRIDGE_PLATFORM` | `cli` | Platform identity passed to Hermes Agent. |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | platform default | Profile worker transport. Set `tcp` for loopback TCP or `ipc`/`unix` for Unix domain sockets; defaults to Windows TCP and macOS/Linux IPC. |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | `18780` | Base port for TCP worker endpoints. |
| `HERMES_BRIDGE_PROVIDER` | profile/default | Provider override for bridge runs. |
| `HERMES_BRIDGE_TOOLSETS` | profile/default | Toolset override for bridge runs. |
| `HERMES_BRIDGE_MAX_TURNS` | profile/default | Maximum turn override for bridge runs. |
| `HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT` | `cli` | Controls bridge platform hint suppression passed to Hermes Agent. |
| `HERMES_OPENROUTER_APP_REFERER` | unset | OpenRouter attribution referer sent by bridge runs. Set this to your own public site if needed. |
| `HERMES_OPENROUTER_APP_TITLE` | `Hermes Web UI` | OpenRouter attribution title sent by bridge runs. |
| `HERMES_OPENROUTER_APP_CATEGORIES` | `cli-agent,personal-agent` | OpenRouter attribution categories sent by bridge runs. |
| `HERMES_WEB_UI_MANAGED_GATEWAY` | enabled | Controls Web UI-managed Hermes gateway process handling. Set `0`, `false`, `no`, or `off` to use `hermes gateway start` instead. |
| `HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART` | unset | Skip startup gateway checks/autostart. Set `1`, `true`, `yes`, or `on` for dashboard-only deployments where another service owns Hermes gateway lifecycle. |
| `HERMES_WEB_UI_DISABLE_SKILL_INJECTION` | unset | Skip startup bundled skill injection. Set `1`, `true`, `yes`, or `on` when bundled skills are managed outside Hermes Web UI. When injection is enabled, Web UI updates only skills it previously installed or identical existing bundled copies; local edits and user-owned same-name skills are skipped. |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | enabled in production | Controls whether Web UI shutdown also stops managed gateway processes. Set `0` or `false` to detach them. |
| `HERMES_GATEWAY_URL` / `GATEWAY_URL` | unset | Explicit Hermes gateway upstream URL for proxy routes. |
| `GATEWAY_HOST` | `127.0.0.1` | Default Hermes gateway upstream host for proxy routes. |
| `GATEWAY_PORT` | `8642` | Default Hermes gateway upstream port for proxy routes. |
| `HERMES_WEB_UI_PREVIEW_REPO` | package repository | GitHub repository used by Version Preview. |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | platform default | Version Preview broker transport. Set `tcp` to use loopback TCP for Preview on macOS/Linux; when unset, Preview follows `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp`. |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | isolated preview endpoint | Directly overrides the Version Preview broker endpoint. |
| `HERMES_WEB_UI_BACKEND_PORT` | `8648` | Backend port used by the Vite dev proxy. |
| `HERMES_WEB_UI_FRONTEND_PORT` | `8649` | Frontend Vite dev server port. |
| `HERMES_WEB_UI_MEETING_ASR_TLS` | `false` | When `true` the meeting ASR Python child process is spawned with `--ssl-keyfile/--ssl-certfile` and the Node WS proxy communicates over `tls.connect`. Set this on device images where uvicorn needs TLS; local dev keeps the default `false`. |
| `HERMES_WEB_UI_SSL_CERTFILE` | `{product_dir}/certs/server.crt` | Override path for the self-signed TLS certificate shared by the Node HTTPS server and the meeting ASR uvicorn child. |
| `HERMES_WEB_UI_SSL_KEYFILE` | `{product_dir}/certs/server.key` | Override path for the TLS private key. |

### CLI Commands

| Command                           | Description                        |
| --------------------------------- | ---------------------------------- |
| `hermes-web-ui start`             | Start in background (daemon mode)  |
| `hermes-web-ui start --port 9000` | Start on custom port               |
| `hermes-web-ui stop`              | Stop background process            |
| `hermes-web-ui restart`           | Restart background process; stops the bridge by default |
| `hermes-web-ui status`            | Check if running                   |
| `hermes-web-ui update`            | Update to latest version & restart |
| `hermes-web-ui upgrade`           | Alias for `update`                 |
| `hermes-web-ui -v`                | Show version number                |
| `hermes-web-ui -h`                | Show help message                  |
| `hermes-web-ui start [port]` | Start in background; accepts a positional port or `--port <port>` |
| `hermes-web-ui client [port]` | Start for a remote client with gateway autostart disabled and permissive CORS |
| `hermes-web-ui restart [port]` | Restart; stops the bridge by default |
| `hermes-web-ui clear-login-locks [--restart]` | Clear persisted login locks, optionally restart |
| `hermes-web-ui reset-default-login` | Create or reset the default administrator login |
| `hermes-web-ui version` / `-v` | Show the version |
| `hermes-web-ui-mcp [api\|browser\|devices\|use]` | Run one managed Web UI MCP toolset (same as `hermes-studio-mcp`) |


`update` / `upgrade` first attempt `npm cache clean --force`, then run `npm install -g @quanthermes/hermes-web-ui@latest` and restart. Cache cleanup is best-effort; if it fails, the updater continues with the install.

## npm Release

- Publish package: `@quanthermes/hermes-web-ui`
- Install globally: `npm install -g @quanthermes/hermes-web-ui`
- Runtime command: `hermes-web-ui start`
- Release workflow: push a `v*` tag to trigger [`.github/workflows/npm-publish.yml`](./.github/workflows/npm-publish.yml)
- Release runbook: [`docs/npm-release.md`](./docs/npm-release.md)

### Auto Configuration

On startup the BFF server automatically:

- Initializes Web UI data directories, local databases, and bundled skills
- Starts the Hermes agent bridge used by `/chat-run`
- Opens browser on successful startup

---

## Development

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- BFF Server: http://localhost:8648

```bash
npm run build   # outputs to dist/
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for project development guidelines.

## Architecture

```
```
Browser → BFF (Koa, :6060) → Socket.IO /chat-run
                ↓
                ↓
           Hermes CLI / profiles
           profile config.yaml    (channel/provider behavior)
           profile auth.json      (credential pool)
           Tencent iLink API      (WeChat QR login)
```

The frontend is designed with **multi-agent extensibility** — all Hermes-specific code is namespaced under `hermes/` directories (API, components, views, stores), making it straightforward to add new agent integrations alongside.

The BFF layer handles Socket.IO chat streaming, the Hermes agent bridge, profile-aware file upload and path-based download (multi-backend: local/Docker/SSH/Singularity), session CRUD, account- and profile-scoped management, config/credential management, WeChat QR login, model discovery, skills/memory/plugin management, TTS/STT, coding-agent proxies, MCP/runtime management, log reading, and static file serving.

## Tech Stack

**Frontend:** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**Backend:** Koa 2 (BFF server) + node-pty (web terminal)

## License

[BSL-1.1](./LICENSE)

The license covers Hermes Studio, the former Hermes Web UI name, the
`hermes-web-ui` npm package and CLI, desktop applications, firmware, release
artifacts, documentation, and associated files in this repository.
