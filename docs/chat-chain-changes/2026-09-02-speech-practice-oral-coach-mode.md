---
date: 2026-09-02
pr: pending
feature: Realtime sub-modes — Agent mode (default) + speech-practice (口语对练) coach mode in New Chat
impact: New Chat's realtime entry now hosts extensible sub-modes: Agent mode (default; unchanged voice dialog where the model can drive the Hermes Agent toolchain via function calling) and 口语对练 (speech practice), where the user picks a target language, difficulty, and types a practice direction. The practice session runs under a coach persona that calls a new `submit_practice_feedback` tool after every user turn (structured 1–10 scores on fluency/pronunciation/grammar/vocabulary/content plus comments), keeps all existing workspace tools (memory/skills/sessions/jobs/`query_hermes_agent`) available, persists each turn and tool call into the chat session, and lets the user save the full per-turn analysis + transcript as a Markdown report (persisted server-side under the Web UI state dir and downloadable). New coach modes (interview / sales practice, etc.) are added by registering one sub-mode option + a drawer branch and reuse the same practice stage/config.
---

# Realtime sub-modes: Agent mode (default) + speech-practice (口语对练) in New Chat

## Mode entry (新建对话 drawer)

- **`ChatPanel.vue`** keeps the top-level conversation-mode radio at `standard | realtime`; picking realtime reveals a 模式 (sub-mode) picker driven by the `realtimeSubModeOptions` registry (`{ value, labelKey }`):
  - `agent`（默认）— the original Agent-mode behavior: hands-free voice dialog (`OmniRealtimeStage`) whose model can drive the Hermes Agent toolchain via function calling (memory / skills / sessions / jobs / `query_hermes_agent` real workspace capabilities), plus the Qwen-Omni model picker;
  - `practice`（口语对练）— the coach mode with a language picker (中文/English/日本語/한국어), a free-text 练习方向 textarea (optional — empty means free conversation), and a difficulty selector (入门/进阶/高级). Confirming creates a fresh server-persisted session titled with the direction, then mounts the practice stage with the chosen config.
- Extensibility: future coach modes (面试 / 销售话术 …) add one `realtimeSubModeOptions` entry (label key in `omniRealtime` / `speechPractice` namespaces), a drawer config area, and a `confirmNewChat` sub-branch — `SpeechPracticeStage` and the language/direction/difficulty config are reused unchanged.
- **`SpeechPracticeStage.vue` (new).** Full-screen voice stage reusing the exact `useOmniRealtime` audio chain as `OmniRealtimeStage` (hands-free mic, server VAD, barge-in, transcript bubbles, mute/interrupt/end controls). Distinctive additions:
  - Session instructions are composed via `buildRealtimeInstructions(soul, { history, scenario })` — the scenario block (from `utils/practice-mode.ts`) is appended last and instructs the model to act as an oral coach in the target language around the user's direction.
  - Right-hand scoreboard shows the latest turn's structured feedback plus the history of earlier turns (每轮评分); overall/fluency/pronunciation/grammar/vocabulary/content are color-coded.
  - Ending the session shows a summary panel (per-dimension averages/max/min) with actions: 保存分析报告 (.md), 复制 Markdown, 返回对话.

## Scoring via function calling (agent toolchain preserved)

- **`api/hermes/omni-tools.ts`** gains `SUBMIT_PRACTICE_FEEDBACK_TOOL` and `PRACTICE_REALTIME_TOOLS = [...OMNI_REALTIME_TOOLS, submit_practice_feedback]` — every existing base tool (query_agent_memory, list_agent_skills, read_skill_detail, list_recent_sessions, list_jobs, and `query_hermes_agent`) stays available in practice mode.
- The stage's `onToolCall` executes `submit_practice_feedback` locally (updating the scoreboard/analysis state and returning a short confirmation to the model) and delegates everything else to the existing `executeOmniTool`, so the realtime model keeps its full Agent-backed capability (MCP/skills/terminal/file reads via the Hermes Agent bridge) mid-practice.
- Every completed turn and tool call is incrementally persisted into the current chat session (same pattern as `OmniRealtimeStage`), so the transcript survives page reloads while it lasts.

## Markdown report persistence

- **`utils/practice-mode.ts` (new, pure).** `buildPracticeInstructionBlock(config)`, `buildPracticeReportMarkdown(input)` (deterministic report: metadata → per-dimension score table → per-round feedback + dialogue → full transcript; export-file headings hard-coded Chinese per the speech-export precedent), and `practiceReportFileStem(...)` filename helper.
- **Server:** `services/speech-practice-report.ts` (singleton store writing under `config.getUploadDir()/speech-practice` — honoring `HERMES_WEB_UI_HOME`/`UPLOAD_DIR`, never cwd), thin controller + route `POST /api/hermes/speech-practice/report`, registered in `routes/index.ts` before the catch-all. Download reuses the existing `/api/hermes/download` (markdown MIME + local read for upload-dir files).
- Client wrapper `api/hermes/practice-report.ts` posts the markdown and returns `{ fileName, path }`; the stage builds the download link via `getDownloadUrl`.

## i18n

- New `speechPractice` namespace added to all 11 locale files (zh/en/zh-TW/ja/ko/fr/es/de/pt/ru/ar), key-for-key identical.

## Tests

- `tests/client/utils/practice-mode.test.ts` — instruction block + report markdown builder + filename stem.
- `tests/server/speech-practice-report-store.test.ts` — store path resolution / traversal safety / uniqueness / size caps (temp state dir).
- `tests/server/speech-practice-report-controller.test.ts` — controller validation + response mapping with a mocked store.
- `tests/server/speech-practice-wiring.test.ts` — source-text guardrails for the drawer entry, toolchain preservation, route registration, and per-locale i18n presence.
