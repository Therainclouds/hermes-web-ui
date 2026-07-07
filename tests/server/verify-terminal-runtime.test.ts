import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTerminalRuntimeBundle } from '../../scripts/verify-terminal-runtime.mjs'

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('verify-terminal-runtime', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('accepts a bundle that contains the terminal runtime markers', () => {
    const root = createTempDir('terminal-runtime-ok-')
    const filePath = resolve(root, 'index.js')
    writeFileSync(
      filePath,
      'console.log("/api/hermes/terminal"); console.log("node-pty failed to load, terminal feature disabled"); console.log("WebSocket ready at /terminal");\n',
      'utf-8',
    )

    expect(() => assertTerminalRuntimeBundle(filePath, 'fixture')).not.toThrow()
  })

  it('fails fast when a built bundle is missing terminal runtime markers', () => {
    const root = createTempDir('terminal-runtime-missing-')
    const filePath = resolve(root, 'index.js')
    writeFileSync(filePath, 'console.log("server only");\n', 'utf-8')

    expect(() => assertTerminalRuntimeBundle(filePath, 'fixture')).toThrow(/Missing markers/)
  })
})
