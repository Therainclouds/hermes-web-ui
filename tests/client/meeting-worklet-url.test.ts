/**
 * Source-code guard for the AudioWorklet module URL used by MeetingView.
 *
 * Bug B-1 (v0.7.7 incident): Vite inlined the .ts worklet as a `data:` URL,
 * which CSP `script-src` (and AudioWorklet semantics) reject, causing
 * `addModule()` to throw and silently disable recording.
 *
 * The fix was to ship a static .js in `public/` and reference it via a
 * string literal. This test enforces that contract on every PR so a future
 * refactor can't regress it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MEETING_AUDIO = resolve(
  process.cwd(),
  'packages/client/src/composables/useMeetingAudio.ts',
)
const STATIC_WORKLET = resolve(
  process.cwd(),
  'packages/client/public/audio/pcm-worklet.js',
)

describe('MeetingView AudioWorklet URL contract', () => {
  // The addModule call lives in useMeetingAudio since the v0.8 modularization
  // moved the recording lifecycle out of MeetingView.vue (PR-2a).
  const src = readFileSync(MEETING_AUDIO, 'utf-8')

  it('addModule receives a literal /audio/ path', () => {
    expect(src).toMatch(/addModule\(\s*["']\/audio\/pcm-worklet\.js["']\s*\)/)
  })

  it('does NOT use new URL(..., import.meta.url) for the worklet', () => {
    // new URL form would let Vite inline the TS source as data: URL again.
    expect(src).not.toMatch(/new URL\([^)]*pcm-worklet[^)]*import\.meta\.url/)
  })

  it('does NOT pass a data: URL to addModule', () => {
    expect(src).not.toMatch(/addModule\(\s*["']data:/)
  })

  it('static pcm-worklet.js exists under public/', () => {
    const staticSrc = readFileSync(STATIC_WORKLET, 'utf-8')
    // The static copy must register the processor with the name we use.
    expect(staticSrc).toMatch(/registerProcessor\(\s*["']pcm-processor["']/)
  })
})