---
date: 2026-09-02
pr: pending
feature: Omni-Realtime soul inheritance + entry unification + barge-in hardening
impact: The realtime voice dialog now inherits its persona from the active profile's SOUL.md (instead of a hardcoded "小合" prompt), composes instructions through one shared pure-function seam (persona → voice supplement → tool rules → optional history/meeting-context blocks), lets an existing text chat session switch into voice mode from a chat-header button (reusing the session with history re-injection), shows a near-context-cap warning banner, offers a resume button after a dropped connection, and hardens local barge-in with RMS-based sustained-voice gating. The meeting-side panel was rebuilt as the InlineRealtimePanel thin wrapper (same UX, same audio chain, soul + meeting-context injection); RealtimeDialogPanel.vue was removed.
---

# Omni-Realtime soul inheritance + entry unification + barge-in hardening

## Soul inheritance (persona comes from the active profile)

- **`packages/client/src/utils/realtime-instructions.ts` (new, pure functions).** `buildRealtimeInstructions(soul, { history?, meetingContext? })` composes: current profile's `SOUL.md` (clipped to 1500 chars, fallback persona when empty/unreadable) → realtime voice supplement (oral short answers, no Markdown, Chinese, tools-per-downloaded-list) → tool reference + usage rules → optional history summary (3000-char budget) → optional meeting-context block. `serializeChatHistory` keeps the last 20 user/assistant messages within budget; `countUserTurns` counts only user turns for the capacity warning.
- **`OmniRealtimeStage.vue`** fetches the soul via `fetchMemory()` in parallel with `ensureBackendAvailable()` (memory failure never blocks the session). The setup card shows the persona source (`当前人格：{profile} · 继承自 SOUL.md`).
- **`InlineRealtimePanel.vue` (new, replaces RealtimeDialogPanel).** Same meeting-side UX (push-to-talk, transcript list, meter), same `useOmniRealtime` audio chain, plus soul + meeting-context injection through the same `buildRealtimeInstructions` seam. It does NOT persist to chatStore — meeting voice dialogs are ephemeral by design.

## Entry unification (voice mode is a chat capability)

- **Chat-header 🎙️ button.** An existing text session can switch into voice via the new `header-actions` button, calling `openOmniRealtime()` with no options — it reuses the active session, and the stage injects the session's recent text messages into the instructions so the voice dialog continues from what was already discussed.
- **New-chat drawer path unchanged.** `confirmNewChat` realtime branch still creates a fresh server-persisted session.
- **`RealtimeDialogPanel.vue` deleted** after its capabilities (meeting-context injection, push-to-talk, editable instructions) were absorbed by `InlineRealtimePanel`; the MeetingView `#realtime` slot now mounts the new panel.

## Context + connection resilience

- **Near-capacity warning.** When completed user turns reach 80% of the model's `audioTurns` cap (per the realtime-model store limits), the live stage shows a dedicated warning banner (not in the caption — caption branch order is anchored by tests).
- **Resume after disconnect.** On `phase === 'error'` the stage offers a 继续对话 button that re-runs the connect path and re-injects persisted turns as history, so a dropped WS does not force a memory reset.

## Barge-in hardening (no changes to the upstream audio feed)

- The mic send path (`workletNode.port.onmessage`) is untouched — DashScope's `semantic_vad` needs the full stream for turn segmentation.
- The local barge-in tick now computes an EMA-smoothed RMS alongside the peak; the streak requires both peak ≥ threshold (0.15 → 0.12) and smoothed RMS ≥ 0.035 sustained-voice floor, filtering transient echo clicks. Debounce window 600 → 800 ms.

## Files touched (chat chain)

- `packages/client/src/utils/realtime-instructions.ts` (new) — instructions composition + history serialization + user-turn counting.
- `packages/client/src/components/hermes/chat/OmniRealtimeStage.vue` — soul fetch, history injection, near-cap banner, resume button, persona source hint.
- `packages/client/src/components/hermes/chat/ChatPanel.vue` — chat-header voice button; `openOmniRealtime` comment updated for the now-live reuse path.
- `packages/client/src/components/hermes/meeting/InlineRealtimePanel.vue` (new) / `RealtimeDialogPanel.vue` (removed).
- `packages/client/src/composables/useOmniRealtime.ts` — RMS-smoothed barge-in gating, threshold/debounce retuning.
- `packages/client/src/views/hermes/MeetingView.vue` — `#realtime` slot mounts `InlineRealtimePanel`.

## Tests

- `tests/client/utils/realtime-instructions.test.ts` (new) — 13 cases: fallback persona, soul clipping, history/meeting-context blocks, serialization budgets, user-turn counting.
- `tests/server/omni-realtime-wiring.test.ts` — MeetingView/panel assertions retargeted to `InlineRealtimePanel`; voice-picker regression list updated; all other source anchors (caption order, playback flush, drop-window, master-gain ordering) unchanged and green.
