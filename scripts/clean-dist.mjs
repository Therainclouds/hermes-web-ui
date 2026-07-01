#!/usr/bin/env node
/**
 * Cross-platform dist cleanup helper used by the root `prepare` script.
 *
 * Why: the previous `prepare` script used a shell `[ -d dist ] || npm run build`
 * short-circuit.  When `dist/` already existed (e.g. from a prior build or a
 * previous deploy whose tarball excluded `dist/`), the build step was silently
 * skipped, leaving a stale artifact whose `__APP_VERSION__` no longer matched
 * the source `package.json`.  The systemd service then started with the old
 * bundle and the deploy script's version cutover check would fail.
 *
 * This helper unconditionally removes `dist/` so `npm run build` always
 * produces a fresh artifact.  It uses Node.js built-ins so it behaves
 * identically on Windows (dev), Linux/Armbian (deploy target) and macOS.
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.cwd(), 'dist')
rmSync(target, { recursive: true, force: true })
