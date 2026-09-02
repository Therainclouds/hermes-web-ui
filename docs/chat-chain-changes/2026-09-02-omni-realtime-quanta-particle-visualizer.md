---
date: 2026-09-02
pr: pending
feature: Omni-Realtime Quanta persona + particle-ring visual redesign
impact: The realtime assistant is now named Quanta everywhere (Python proxy fallback, client fallback persona, seeded SOUL.md for new profiles, and the local factory template upgraded in place). The stage's CSS orb was replaced by a canvas particle-ring visualizer driven by real mic + playback levels (new parallel AnalyserNode tap), and the caption no longer carries conversation text — a new Q-bounce bubble layer (TransitionGroup, spring easing) shows the last 3 turns plus live text.
---

# Omni-Realtime Quanta persona + particle-ring visual redesign

## Quanta persona unification

- **Python proxy fallback** (`omni_realtime_proxy.py`): `DEFAULT_INSTRUCTIONS` renamed from "小合" to Quanta.
- **Client fallback** (`realtime-instructions.ts`): `DEFAULT_SOUL_FALLBACK` is now the Quanta identity.
- **`seed-quanta-soul.ts` (new)**: after `hermes profile create`, the Web UI seeds `SOUL.md` with the Quanta template — but ONLY when the file is missing or still matches the factory template ("You are Hermes Agent…" prefix). A user-customized soul is never touched. Wired into the `create` controller after `injectBundledSkillsForProfile`; failures are logged, never fatal.
- **Local migration**: the machine's default profile `~/.hermes/SOUL.md` was upgraded in place (same guard rule) so the realtime soul inheritance reads Quanta immediately.

## Particle-ring visualizer

- **`OmniVisualizer.vue` (new)**: canvas 2D + RAF particle system — glowing center core (phase-driven palette with smooth EMA color transition), two tilted orbit rings of 110 depth-sorted particles, and a breathing halo. Mic input pulls particles inward with faster twinkle; AI output pushes them outward in a burst. Levels are EMA-smoothed inside the component.
- **Playback analyser tap** (`useOmniRealtime.ts`): a parallel `AnalyserNode` branches off `masterGain` (never in series with `destination`), sampled per-frame into a new `outputLevel` ref with headroom scaling. The audible routing is untouched; the loop is torn down in both close paths.
- The old CSS orb / halo / sheen / morph keyframes (~120 lines) were removed; `orbPhase` feeds the visualizer.

## Q-bounce conversation bubbles

- The live stage now renders a `TransitionGroup` bubble layer: last 3 committed turns + the in-flight live text (user/assistant each at most one). Entrance is a spring overshoot (`cubic-bezier(0.34, 1.56, 0.64, 1)`, also沉淀为 `--ease-spring` in variables.scss); leaving bubbles float up and fade. User bubbles align right with a blue-violet gradient pill; assistant bubbles use glass-morphism.
- The caption no longer duplicates conversation text — it keeps only status/error/tool/camera hints (anchored branch order with `isOutputPlaying` before `handsFreeHint` preserved).

## Files touched (chat chain)

- `packages/client/src/components/hermes/chat/OmniVisualizer.vue` (new)
- `packages/client/src/components/hermes/chat/OmniRealtimeStage.vue` — visualizer integration, bubble layer, caption cleanup
- `packages/client/src/composables/useOmniRealtime.ts` — output analyser tap + `outputLevel`
- `packages/client/src/styles/variables.scss` — `--ease-spring`
- `packages/server/src/services/hermes/profiles/seed-quanta-soul.ts` (new) + `controllers/hermes/profiles.ts` — seeding
- `packages/server/src/services/meeting-asr/python-backend/app/omni_realtime_proxy.py` — Quanta fallback

## Tests

- `tests/server/seed-quanta-soul.test.ts` (new, 6 cases): seed / upgrade factory template / never touch custom soul / default-profile upgrade / template identity.
- `tests/server/omni-realtime-wiring.test.ts`: new describe block — visualizer wiring, outputLevel analyser tap with teardown coverage, Quanta seeding guard (including "小合" eradication in the Python proxy).
- `tests/client/components/omni-visualizer.test.ts` (new, 3 cases): jsdom-safe mount smoke for all phases + clean unmount.
