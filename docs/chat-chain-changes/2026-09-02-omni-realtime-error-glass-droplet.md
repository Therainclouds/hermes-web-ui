---
date: 2026-09-02
pr: pending
feature: Omni-Realtime four-repair pass — swallow "append image before append audio" red banner, kill chat-log jitter on interrupt, make the frosted-glass effect actually blur, reshape the core into a stationary water droplet
impact: The user-visible red error "Error append image before append audio" no longer surfaces in the realtime dialog (filtered at the Python proxy so the suppression inherits to every future client). Interrupting the AI no longer causes the chat bubbles to jump — the live subtitle now clears synchronously inside `interrupt()` and lives in its own TransitionGroup namespace so its 80ms fade does not race the committed bubbles' 420ms spring. The `.omni-stage` frosted glass now actually blurs: an `.omni-stage__backdrop` div carries the (semi-transparent) base color while the nebula / halo SVGs sit at `z-index: 1` above it, so `backdrop-filter` reads the real nebula+halo stack instead of a flat opaque color. The center visualizer core is redrawn from a 10-vertex catmull-rom blob (multi-frequency oscillation + slow self-rotation) into a single, axis-symmetric water-droplet bezier path — the only motion is the overall height breathing with the smoothed energy signal, so the core is visually still when silent and breathes (not twists) when AI speech arrives.
---

# Omni-Realtime four-repair pass

## Root causes

| User feedback | Root cause | File |
|---|---|---|
| "Error append image before append audio" red banner in the chat | `translate_event()` forwarded every upstream `error` event verbatim; the per-commit audio-freshness guard (`_audio_appended_since_commit`) catches the common path but a stale race can still let a frame slip through to DashScope — the resulting English copy then surfaced in the UI as if it were a user-facing fault | `omni_realtime_proxy.py:664-669` |
| Chat log jumps when interrupting the AI | `interrupt()` synchronously dropped `playingSourceCount` to 0, which fired the `watch(isOutputPlaying)` in a separate Vue flush and cleared `liveAssistantText` again — the bubble computed then re-ran, the TransitionGroup fired its 420ms spring enter + 280ms fade leave at the same time, and the bubble-stack visibly shifted | `useOmniRealtime.ts:256-260, 855-868` + `OmniRealtimeStage.vue:738-745` |
| Frosted glass effect did not actually blur anything | `.omni-stage` had `isolation: isolate` (good) **and** an opaque `background: var(--bg-primary)` (bad). The nebula / halo SVGs at `z-index: -1` were buried under that opaque parent background, so `backdrop-filter` on the header / panels was just blurring a flat color | `OmniRealtimeStage.vue:866-919` |
| Star core twist was not harmonious | The previous "liquid blob" drew 10 vertices on a circle and drove each vertex's radius with two independent multi-frequency sine waves (`baseWave` always on, `audioWave` gated by energy) — the multi-frequency interference made the silhouette twist; the slow `blobRotation` made the twist drift; together they looked like a jellyfish thrashing instead of a breathing droplet | `OmniVisualizer.vue:201-310` |

## Fixes

### 1. Proxy drops the "append image before append audio" error

`translate_event()` in `omni_realtime_proxy.py` now filters the error branch:

```python
if isinstance(message, str) and "append image before append audio" in message.lower():
    return None
```

The filter lives server-side (not in the client regex) so any future mobile / desktop client automatically inherits the suppression without depending on DashScope's exact English copy. The proxy already has the `_audio_appended_since_commit` pre-filter — if a stale frame still slips through, the resulting error is a proxy-internal audit issue and there is no actionable user message.

### 2. Interrupt no longer double-clears bubbles

`interrupt()` now clears `liveAssistantText` synchronously **before** sending `{type:'cancel'}`:

```ts
function interrupt(): void {
  stopPlayback()
  liveAssistantText.value = ''
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try { ws.send(JSON.stringify({ type: 'cancel' })) } catch { /* ignore */ }
}
```

The `watch(isOutputPlaying)` is kept as the natural-playback-finish safety net, so we still clear when audio truly drains. But during manual cancel the live text now reflows once in this tick, not twice across two Vue flushes.

The bubble layer in `OmniRealtimeStage.vue` is also split into two TransitionGroups with different animation namespaces:

- `<TransitionGroup name="omni-bubble">` — committed rows (`'user:…'` / `'assistant:…'` keys), keep the 420ms spring enter
- `<TransitionGroup name="omni-bubble-live">` — the live bubble (`'live-user'` / `'live-assistant'` key), only a 80ms opacity fade in/out

The live-slot is positioned absolutely on top of the committed stack so it can swap keys without the committed rows re-running their leave/enter animation in parallel. Net effect: a manual cancel replaces the live bubble with a clean fade, no up-and-down jiggle.

### 3. Frosted glass actually blurs the nebula

`OmniRealtimeStage.vue` now contains an explicit `.omni-stage__backdrop` wrapper:

```html
<div class="omni-stage__backdrop" aria-hidden="true">
  <img class="omni-stage__nebula omni-stage__nebula--a" … />
  <img class="omni-stage__nebula omni-stage__nebula--b" … />
  <img class="omni-stage__halo" … />
</div>
```

CSS:

```css
.omni-stage { background: transparent; }   /* was: var(--bg-primary) */

.omni-stage__backdrop {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: rgba(var(--bg-primary-rgb), 0.88);
}
.omni-stage__nebula,
.omni-stage__halo { z-index: 1; }          /* was: -1 */
```

`.omni-stage` still keeps `isolation: isolate`, so `backdrop-filter` on header / panels now blurs the backdrop layer (translucent base color + nebula + halo) instead of a flat opaque color. Light mode reads as pale frosted glass over a soft pink/violet wash; dark mode reads as inky glass over the same wash.

### 4. Core is now a stationary water droplet

`drawBlob` is gone; `drawDrop` draws a single axis-symmetric water-droplet bezier path with no per-vertex oscillation, no self-rotation:

```ts
function drawDrop(ctx, cx, cy, unit, energy, …) {
  const userPulse = smoothInput * 0.07
  const w = unit * (0.28 + energy * 0.04 + userPulse)
  const h = w * (1.18 + energy * 0.08)
  // 4 symmetric beziers: left-bottom → bottom → right-bottom → top apex → left-top
  …
  ctx.closePath()
  // radial gradient (top-left bright)
  ctx.fill()
}
```

- Width `w` and height `h` both come from the single energy signal — the shape breathes with AI speech without any vertex-level noise
- The 10-vertex catmull-rom and the slow `blobRotation` are gone — no twist
- The user-pulse channel (`smoothInput`) is the only thing that can briefly inflate the radius when the user speaks
- The top highlight is fixed at the apex of the drop (no longer drifts around the upper-left of a blob)

## What stays unchanged

- `<OmniVisualizer :phase :input-level :output-level>` props
- `useOmniRealtime` audio / WebSocket wiring
- Theme tokens (`--glass-realtime-*`, `--bg-primary`, `--text-primary-rgb`)
- Particle ring + 3 nebula / halo SVGs from the previous visual rework
- Caption / tool-call inline layout

## Files

| Path | Change |
|------|--------|
| `packages/server/src/services/meeting-asr/python-backend/app/omni_realtime_proxy.py` | `translate_event()` error branch filters "append image before append audio" |
| `packages/client/src/composables/useOmniRealtime.ts` | `interrupt()` synchronously clears `liveAssistantText` |
| `packages/client/src/components/hermes/chat/OmniRealtimeStage.vue` | backdrop wrapper + nebula z-index + bubble namespace split |
| `packages/client/src/components/hermes/chat/OmniVisualizer.vue` | `drawBlob` → `drawDrop` (axis-symmetric droplet, single energy driver) |
| `tests/server/omni-realtime-wiring.test.ts` | +1 proxy filter assertion |
| `docs/chat-chain-changes/2026-09-02-omni-realtime-error-glass-droplet.md` | new |

## Verification

```bash
npm run harness:check && npm run build && \
  npx vitest run tests/server/omni-realtime-wiring.test.ts \
                 tests/client/components/omni-visualizer.test.ts \
                 tests/client/utils/realtime-instructions.test.ts
```

Manual checks for the four user-reported issues:

1. Camera on while AI talks — no red "Error append image before append audio" banner
2. Mid-sentence interrupt button — bubbles do not visibly jump, the live subtitle just fades
3. Light / dark theme — backdrop visibly shows the nebula / halo wash through the frosted header, panels, and the live-bubble glass card
4. AI speaking — center is a still water droplet that breathes vertically with the AI's volume, no twist, no self-rotation; user speaking briefly inflates the droplet