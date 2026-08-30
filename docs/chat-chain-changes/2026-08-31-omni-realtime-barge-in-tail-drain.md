---
date: 2026-08-31
commit: omni-realtime-barge-in-tail-drain-fix
feature: Omni-Realtime voice dialog barge-in and turn handover
impact: Speaking while the AI reply's audio is still draining now interrupts it
  immediately (previously the tail kept playing because `phase` had already
  flipped back to 'ready'), and a new response's audio no longer queues behind
  the previous segment — the old tail is cut the moment `response_started`
  arrives, so audio stays aligned with the subtitles.
---

## Goal

Fix two realtime-dialog playback bugs that share one root cause: the client
treats `phase` as "is the AI talking", but `phase` flips back to `ready` the
moment upstream emits `response_done` — well before the last queued buffer
finishes playing through the speakers.

## Behavior changes

- `maybeBargeIn` (server `listening` path) and the local mic-peak tick now
  fire while audio is *actually* playing (`isOutputPlaying`), not only while
  `phase === 'speaking'`. The user speaking during the tail-drain window now
  silences the AI immediately.
- `response.cancel` is only sent while an upstream response is in flight
  (`phase === 'speaking'`); during the tail-drain window the response has
  already fully drained, so the client silences locally without sending a
  cancel that could surface an upstream error.
- The `response_started` handler now calls `stopPlayback()` so leftover audio
  from the previous response is cut before the new reply's chunks are
  scheduled — without this, `flushPendingToSlot` chained the new audio behind
  `nextPlayTime` and the user heard the old segment while the subtitles
  already showed the new response.

## Non-goals

- No changes to the upstream proxy protocol, VAD behaviour, or phase
  semantics for the UI badges.
- No changes to manual barge-in (`interrupt()` / `abortResponse()`), which
  the UI already gates on `phase === 'speaking'`.
