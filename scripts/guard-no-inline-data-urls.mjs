#!/usr/bin/env node
// Guard: assert no Worker / AudioWorklet module is loaded via `data:` URL.
//
// Background: B-1 (v0.7.7). Vite 6/Rolldown inlined `pcm-worklet.ts` as a
// `data:` URL, then CSP `script-src` (and AudioWorklet semantics) rejected
// it, silently disabling recording.
//
// We only flag the *dangerous* patterns — places where JS asks the browser
// to *evaluate* a `data:` URL. Static SVG data URLs (Mermaid icons, etc.)
// are not a CSP violation and are intentionally ignored.
//
// Run after `npm run build`. Exits 1 if any chunk tries to spin up a
// Worker / AudioWorklet from a `data:` URL.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const CLIENT_DIR = resolve(process.cwd(), 'dist/client/assets/js')

// Each pattern matches a call site that turns a `data:` string into an
// executed module. The literal-arg form (e.g. `new Worker("data:...")`)
// is what Vite/Rolldown emits when it inlines a TS worker.
const DANGER_PATTERNS = [
  /\bnew\s+Worker\s*\(\s*["']data:/,
  /\bnew\s+SharedWorker\s*\(\s*["']data:/,
  /\baddModule\s*\(\s*["']data:/,
  /\bimportScripts\s*\(\s*["']data:/,
  /\bnew\s+Function\s*\(\s*["']data:/,
  /\beval\s*\(\s*["']data:/,
]

async function main() {
  let entries
  try {
    entries = await readdir(CLIENT_DIR)
  } catch (err) {
    console.error(`[guard] Cannot read ${CLIENT_DIR}:`, err.message)
    console.error('[guard] Did you run `npm run build` first?')
    process.exit(1)
  }

  const offenders = []
  for (const file of entries) {
    if (!file.endsWith('.js')) continue
    const content = await readFile(join(CLIENT_DIR, file), 'utf-8')
    for (const pattern of DANGER_PATTERNS) {
      if (pattern.test(content)) {
        offenders.push({ file, pattern: pattern.source })
        break
      }
    }
  }

  if (offenders.length > 0) {
    console.error('[guard] FAIL: data: URLs used for module execution:')
    for (const o of offenders) {
      console.error(`  ${o.file}  matched /${o.pattern}/`)
    }
    console.error('[guard] See docs/harness/meeting-asr-safety-audit.md (B-1).')
    process.exit(1)
  }

  console.log(`[guard] OK: no data: URLs passed to Worker/AudioWorklet/eval in ${CLIENT_DIR}`)
}

main().catch((err) => {
  console.error('[guard] Unexpected error:', err)
  process.exit(1)
})