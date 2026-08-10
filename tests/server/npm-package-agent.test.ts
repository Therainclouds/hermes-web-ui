import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  hermesHome: '',
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
}))

vi.mock('../../packages/server/src/config', () => ({
  getDeployDir: () => '',
  getWebUiHome: () => '',
}))

vi.mock('../../packages/server/src/services/hermes/hermes-path', () => ({
  detectHermesHome: () => mocks.hermesHome,
}))

function venvBinDir(hermesHome: string): string {
  return process.platform === 'win32' ? join(hermesHome, 'hermes-agent-venv', 'Scripts') : join(hermesHome, 'hermes-agent-venv', 'bin')
}

describe('upgradeHermesAgentAfterNpmUpdate', () => {
  const roots: string[] = []

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.execFile.mockReset()
    mocks.execFile.mockImplementation((_exe: string, _args: string[], _opts: unknown, cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '', stderr: '' })
    })
    mocks.hermesHome = ''
  })

  afterEach(() => {
    for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
  })

  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'npm-agent-test-'))
    roots.push(dir)
    return dir
  }

  it('skips silently when no Hermes Agent venv exists', async () => {
    mocks.hermesHome = makeHome()
    const { upgradeHermesAgentAfterNpmUpdate } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    await expect(upgradeHermesAgentAfterNpmUpdate()).resolves.toBeUndefined()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('upgrades hermes-agent inside the resolved venv', async () => {
    const home = makeHome()
    const binDir = venvBinDir(home)
    mkdirSync(binDir, { recursive: true })
    const python = process.platform === 'win32' ? join(binDir, 'python.exe') : join(binDir, 'python3')
    writeFileSync(python, '')
    mocks.hermesHome = home

    const { upgradeHermesAgentAfterNpmUpdate } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    await upgradeHermesAgentAfterNpmUpdate()

    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    const [exe, args, options] = mocks.execFile.mock.calls[0]
    expect(exe).toBe(python)
    expect(args).toEqual(['-m', 'pip', 'install', '--upgrade', 'hermes-agent'])
    expect(options.timeout).toBeGreaterThan(0)
  })

  it('never throws when the pip upgrade fails (best-effort)', async () => {
    const home = makeHome()
    const binDir = venvBinDir(home)
    mkdirSync(binDir, { recursive: true })
    writeFileSync(process.platform === 'win32' ? join(binDir, 'python.exe') : join(binDir, 'python3'), '')
    mocks.hermesHome = home
    mocks.execFile.mockImplementation((_exe: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('pip install failed: index unreachable'))
    })

    const { upgradeHermesAgentAfterNpmUpdate } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    await expect(upgradeHermesAgentAfterNpmUpdate()).resolves.toBeUndefined()
  })

  it('resolveHermesAgentVenvPython returns the interpreter when present', async () => {
    const home = makeHome()
    const binDir = venvBinDir(home)
    mkdirSync(binDir, { recursive: true })
    writeFileSync(process.platform === 'win32' ? join(binDir, 'python.exe') : join(binDir, 'python3'), '')
    mocks.hermesHome = home

    const { resolveHermesAgentVenvPython } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    const resolved = resolveHermesAgentVenvPython(home)
    expect(resolved).toBeTruthy()
    expect(existsSync(resolved as string)).toBe(true)
  })
})
