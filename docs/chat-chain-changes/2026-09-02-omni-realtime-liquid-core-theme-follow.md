---
date: 2026-09-02
pr: pending
feature: Omni-Realtime visual rework — liquid-blob core, particle ring decoupled from audio, theme-aware glass surfaces
impact: The realtime-dialog stage now follows the Hermes Web main theme (--bg-primary / --text-primary / --glass-realtime-*) so light mode is a soft milky glass and dark mode is deep ink glass. The particle ring is fully decoupled from the microphone signal — AI playback no longer makes the starfield twitch (the AEC residual echo that drove every particle's twinkle frequency off the raw peak is now filtered through peak+RMS EMA blending and the particles themselves ignore inputLevel entirely). The center orb is replaced by a 10-vertex catmull-rom blob whose radii are driven by a slow energy signal, producing a liquid-mercury breathing effect that responds to AI speech without jitter. Background mood comes from 3 hand-drawn SVG nebulae / halos under mix-blend-mode. Audio wiring and outputLevel EMA are unchanged; the visualizer's prop contract is unchanged.
---

# Omni-Realtime visual rework

## Root cause of the 鬼畜 jitter

`OmniVisualizer.vue` previously coupled the particle ring to two mic-derived signals:

- `radialPush = smoothOutput * 0.3 - smoothInput * 0.1` — particle radial position per frame
- `twinkle = ... * (1 + smoothInput * 1.2)` — every particle's twinkle frequency

Meanwhile `useOmniRealtime.ts:623` exposed `inputLevel` as a **raw peak** (no EMA). Whenever AI speech produced an AEC-residual echo frame, that peak shot up, the radial push lurched, the twinkle frequency shifted, and the whole starfield twitched in a single frame — visually "鬼畜".

## Fixes

### 1. `useOmniRealtime.ts` — inputLevel smoothing

The mic analyser now blends `peak * 0.4 + rmsSmoothed * 0.6` (the already-smoothed RMS used by barge-in) and runs an EMA (attack 0.35 / release 0.1) before writing to the exposed ref. Single-frame transients (clicks, one loud echo frame) are killed; sustained speech still produces visible punch because RMS rises during vowels.

### 2. `OmniVisualizer.vue` — particle decoupling + liquid blob core

- **Particles**: positions, sizes, and twinkle frequency are driven by `time` + per-particle phase + a tiny constant angularSpeed. `energy` only affects a low-weight baseAlpha so the ring brightens slightly during active speech — it does NOT affect position, size, or twinkle rhythm. The ring looks the same regardless of audio activity.
- **Liquid blob**: 10 vertices evenly spaced around the base radius; each vertex's radius is `baseRadius * (1 + baseWave * 0.18 + audioWave * energy * 0.28)` where `baseWave` is a low-frequency multi-sine (always active so the blob looks alive) and `audioWave` is gated by the slow `energySmooth` so it breathes with AI speech without twitching per syllable. Vertices are joined by catmull-rom → bezier for a smooth blob silhouette. A user-only pulse (`smoothInput * 0.06`) gives the blob a quick "bulge" when the user speaks.
- **Highlight**: small white radial gradient that drifts ±6% around the upper-left of the blob, giving the impression of a 3D liquid bead.

### 3. `OmniRealtimeStage.vue` — theme-aware glass

The stage's CSS previously hardcoded the deep-space blue palette (`#060911`, `rgba(171, 224, 255, 0.14)` etc.). Every panel, button, and bubble now reads from the new `--glass-realtime-*` token family which sits on top of the project's existing `--bg-primary` / `--text-primary-rgb` tokens. Result:

- **Light mode**: pale white background, frosted-white glass panels with subtle black borders, the same neutral grey as the rest of Hermes Web.
- **Dark mode**: deep ink background, frosted-ink glass panels with subtle light-grey borders, identical to the rest of Hermes Web.

User bubble keeps its accent-gradient identity (so the role stays clear), but the gradient now uses `--accent-primary-rgb` / `--accent-info-rgb` so it adjusts to theme.

### 4. `variables.scss` — new tokens

```scss
:root {
  --glass-realtime-bg: rgba(var(--bg-primary-rgb), 0.62);
  --glass-realtime-bg-strong: rgba(var(--bg-primary-rgb), 0.78);
  --glass-realtime-bg-subtle: rgba(var(--bg-primary-rgb), 0.42);
  --glass-realtime-border: rgba(var(--text-primary-rgb), 0.14);
  --glass-realtime-border-strong: rgba(var(--text-primary-rgb), 0.22);
  --glass-realtime-shadow: 0 12px 40px rgba(var(--text-primary-rgb), 0.08);
  --glass-realtime-blur: blur(22px) saturate(160%);
  --glass-realtime-blur-strong: blur(28px) saturate(180%);
}

.dark {
  --glass-realtime-border: rgba(var(--text-primary-rgb), 0.18);
  --glass-realtime-border-strong: rgba(var(--text-primary-rgb), 0.28);
  --glass-realtime-shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
}
```

### 5. Background mood — SVG nebulae + halo

Three hand-drawn SVGs in `public/realtime/`:

- `nebula-a.svg` — pink/violet ellipse nebula (256×256, radial gradient + feGaussianBlur), top-left overlay
- `nebula-b.svg` — blue/cyan ellipse nebula (256×256, same recipe), bottom-right overlay
- `halo-soft.svg` — soft circular halo (240×240, large stdDeviation blur), centered around the visualizer

All three use `mix-blend-mode: soft-light` / `screen` and sit at `opacity: 0.22` so they read as ambient mood in both light and dark themes.

## What stays unchanged

- `<OmniVisualizer :phase :input-level :output-level>` props
- `useOmniRealtime.outputLevel` (already EMA-smoothed)
- All wiring test anchors (`outputAnalyser = playbackCtx.createAnalyser()`, `masterGain.connect(outputAnalyser)`, three `stopOutputLevelLoop()` call sites)
- OmniRealtimeStage's caption / bubble layout / persistence pipeline

## Files

| Path | Change |
|------|--------|
| `packages/client/src/composables/useOmniRealtime.ts` | inputLevel EMA + RMS blend |
| `packages/client/src/components/hermes/chat/OmniVisualizer.vue` | particles decoupled + liquid blob core |
| `packages/client/src/components/hermes/chat/OmniRealtimeStage.vue` | theme tokens + glass surfaces + 3 SVG overlays |
| `packages/client/src/styles/variables.scss` | --glass-realtime-* (light + dark) |
| `packages/client/public/realtime/nebula-a.svg` | new |
| `packages/client/public/realtime/nebula-b.svg` | new |
| `packages/client/public/realtime/halo-soft.svg` | new |
| `tests/client/components/omni-visualizer.test.ts` | +1 high-audio stability test |
| `tests/server/omni-realtime-wiring.test.ts` | +1 inputLevel smoothing + particle decoupling assertions |

## Verification

- `npx vitest run tests/client/components/omni-visualizer.test.ts` → 4 passed
- `npx vitest run tests/server/omni-realtime-wiring.test.ts` → 51 passed
- `npm run build` → built in 6.78s
- `npm run harness:check` → pass