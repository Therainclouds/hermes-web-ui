---
date: 2026-09-01
pr: pending
feature: Omni-Realtime UI hardening + Hermes Agent function-calling integration
impact: The Omni-Realtime dialog now persists its transcript and tool calls incrementally into the active chat session (so reloads and sidebar navigations no longer drop the conversation), opens a fresh server-persisted session from the 新建对话 → realtime drawer path, exposes a right-side tool-call panel with per-call status and duration, removes the silent 2-line caption truncation, and adds a `query_hermes_agent` tool that lets the realtime model dispatch real Hermes Agent work (MCP, skills, terminal, filesystem) through a one-shot server route.
---

# Omni-Realtime UI hardening + Hermes Agent function-calling integration

## Realtime dialog fixes (user-reported bugs)

- **Caption text now fully renders.** The previous `-webkit-line-clamp: 2` rule silently truncated every assistant reply to two lines. The caption now wraps with `white-space: pre-wrap`, scrolls after ~10 lines, and shows the full text.
- **Right-side tool call panel.** Each model-initiated function call is rendered as a card with a state icon (running spinner / error cross / success tick), the tool name, an args or output preview, and the execution duration. Mirrors the existing `RealtimeVoiceStage` card style so users see a consistent tool UI across both realtime paths.
- **History persistence across navigation.** The composable now exposes a `toolCalls` list; the stage watches `turns` and `toolCalls` and writes each completed turn and tool call into `chatStore.messages` immediately (not in one batch at endSession). A final flush runs from `endSession` and from `onBeforeUnmount`, so closing the dialog, navigating away, or refreshing the page all preserve the conversation.
- **新建对话 → realtime always opens a fresh persisted session.** `confirmNewChat` for the realtime branch now calls `chatStore.newChatWithRemoteCreate({ source: 'cli', agent: 'hermes' })` so the session is server-persisted (visible in the sidebar and stable across reloads). The previous `chatStore.newChat()` left `isLocalOnly=true`, hid the session from the sidebar, and was wiped by any navigation.

## Hermes Agent function-calling integration

- **New client tool `query_hermes_agent(question)`.** Added to `OMNI_REALTIME_TOOLS` so the realtime model can dispatch a concrete user question to a real Hermes Agent run on the backend. The model's existing read-only tools (`query_agent_memory`, `list_agent_skills`, `read_skill_detail`, `list_recent_sessions`, `list_jobs`) remain in place; the new tool covers the write / MCP / terminal / filesystem gap.
- **New server route `POST /api/hermes/realtime/agent-query`.** Lives in `packages/server/src/controllers/hermes/realtime-agent.ts` and reuses the existing `AgentBridgeClient` (same `/chat-run` IPC path) to run a one-shot transient session. Output is hard-capped at 16 KB on the server and clipped to 3.5 KB on the client. The route includes an agent-graceful-failure heuristic identical to `meeting-asr/agent-bridge.ts` so provider failure messages don't get returned as success replies.
- **Session lifecycle is non-intrusive.** The one-shot agent session is not added to the chat-run sidebar, so realtime tool invocations don't pollute the user's session list. After each tool call the bridge destroys the session via `bridge.destroy(sessionId, profile)`.

## Persistence shape (incremental writes)

- Each finalized realtime turn becomes a `{ role: 'user' | 'assistant', content, timestamp }` `Message`.
- Each tool call becomes a `{ role: 'tool', toolName, toolCallId, toolArgs, toolResult, toolPreview, toolStatus, toolDuration }` `Message`. The same `toolCallId` is reused, so existing `chat-core.ts` placeholders for assistant-with-`tool_calls` rows render these as proper tool messages in the history view after reload.
- Dedup keys (`writtenTurnIds`, `writtenToolCallIds`) prevent duplicate appends when both the watcher and `flushPendingPersistence` race during teardown.

## Files touched (chat chain)

- `packages/client/src/composables/useOmniRealtime.ts` — added `OmniDialogToolCall` type, `toolCalls` reactive list, dedup in `handleFunctionCall`, expose from returned API.
- `packages/client/src/components/hermes/chat/OmniRealtimeStage.vue` — incremental persistence watchers, right-side tool panel, caption fix, `flushPendingPersistence` on teardown.
- `packages/client/src/components/hermes/chat/ChatPanel.vue` — `openOmniRealtime` accepts `{ createFresh, persistRemote }`; `confirmNewChat` realtime branch uses `newChatWithRemoteCreate`.

## Server-side surface

- `packages/server/src/controllers/hermes/realtime-agent.ts` (new) — `runRealtimeAgentQuery`, `looksLikeStandaloneAgentFailure`, `queryAgent` controller.
- `packages/server/src/routes/hermes/realtime-agent.ts` (new) — `realtimeAgentRoutes` exporting `POST /api/hermes/realtime/agent-query`.
- `packages/server/src/routes/index.ts` — registers `realtimeAgentRoutes` after `meetingStorageRoutes` (before proxy catch-all).
- `packages/client/src/api/hermes/omni-tools.ts` — adds the `query_hermes_agent` tool definition and `toolQueryHermesAgent` executor with a 75-second client-side timeout.

## i18n

Added `omniRealtime.toolCallsTitle` and updated `omniRealtime.toolsHint` across all 11 locale files (en, zh, zh-TW, de, es, fr, ja, ko, pt, ru, ar).
