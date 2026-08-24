import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cache tests for `getVersionCached()` and `prewarmHermesCliVersion()`.
 *
 * The cache lives in module scope. We mock `hermes-process` so the real
 * `getVersion()` runs but uses our fake `execHermesWithBin` — letting us
 * control what the CLI returns and how long it takes.
 */

type HermesCliModule = typeof import('../../packages/server/src/services/hermes/hermes-cli')

interface MockExecResult {
  stdout: string
  stderr: string
}

let execCalls = 0
let execImpl: (cmd: string, args: readonly string[], opts: unknown) => Promise<MockExecResult>

vi.mock('../../packages/server/src/services/hermes/hermes-process', () => ({
  execHermesWithBin: (cmd: string, args: readonly string[], opts: unknown) => {
    execCalls += 1
    return execImpl(cmd, args, opts)
  },
  spawnHermesWithBin: vi.fn(),
}))

async function loadHermesCli(): Promise<HermesCliModule> {
  vi.resetModules()
  return import('../../packages/server/src/services/hermes/hermes-cli') as Promise<HermesCliModule>
}

describe('hermes-cli version cache', () => {
  beforeEach(() => {
    execCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('memoizes the CLI version across concurrent callers with a single subprocess', async () => {
    execImpl = vi.fn().mockResolvedValue({ stdout: 'Hermes Agent v0.11.0\n', stderr: '' })
    const hermesCli = await loadHermesCli()

    const results = await Promise.all(
      Array.from({ length: 10 }, () => hermesCli.getVersionCached()),
    )

    expect(results).toEqual(Array(10).fill('Hermes Agent v0.11.0'))
    expect(execCalls).toBe(1)
  })

  it('returns the cached value without re-spawning until the TTL elapses', async () => {
    execImpl = vi.fn().mockResolvedValue({ stdout: 'Hermes Agent v0.11.0\n', stderr: '' })
    const hermesCli = await loadHermesCli()

    const first = await hermesCli.getVersionCached({ ttlMs: 60_000 })
    const second = await hermesCli.getVersionCached({ ttlMs: 60_000 })
    const third = await hermesCli.getVersionCached({ ttlMs: 60_000 })

    expect([first, second, third]).toEqual([
      'Hermes Agent v0.11.0',
      'Hermes Agent v0.11.0',
      'Hermes Agent v0.11.0',
    ])
    expect(execCalls).toBe(1)
  })

  it('re-spawns the CLI once the TTL has elapsed', async () => {
    let now = 1_000_000
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    execImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Hermes Agent v0.11.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Hermes Agent v0.12.0\n', stderr: '' })

    try {
      const hermesCli = await loadHermesCli()
      expect(await hermesCli.getVersionCached({ ttlMs: 1000 })).toBe('Hermes Agent v0.11.0')
      now += 1500
      expect(await hermesCli.getVersionCached({ ttlMs: 1000 })).toBe('Hermes Agent v0.12.0')
      expect(execCalls).toBe(2)
    } finally {
      dateNowSpy.mockRestore()
    }
  })

  it('does not cache empty results so the next call retries', async () => {
    execImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Hermes Agent v0.11.0\n', stderr: '' })
    const hermesCli = await loadHermesCli()

    expect(await hermesCli.getVersionCached()).toBe('')
    expect(await hermesCli.getVersionCached()).toBe('Hermes Agent v0.11.0')
    expect(execCalls).toBe(2)
  })

  it('prewarmHermesCliVersion is fire-and-forget and populates the cache', async () => {
    execImpl = vi.fn().mockResolvedValue({ stdout: 'Hermes Agent v0.11.0\n', stderr: '' })
    const hermesCli = await loadHermesCli()

    expect(() => hermesCli.prewarmHermesCliVersion()).not.toThrow()

    await new Promise((resolve) => setImmediate(resolve))
    expect(execCalls).toBe(1)

    const cached = await hermesCli.getVersionCached()
    expect(cached).toBe('Hermes Agent v0.11.0')
    expect(execCalls).toBe(1)
  })

  it('uses the default 30s TTL when no ttlMs override is supplied', async () => {
    let now = 1_000_000
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    execImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Hermes Agent v0.11.0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Hermes Agent v0.12.0\n', stderr: '' })

    try {
      const hermesCli = await loadHermesCli()
      expect(await hermesCli.getVersionCached()).toBe('Hermes Agent v0.11.0')
      now += 29_000
      expect(await hermesCli.getVersionCached()).toBe('Hermes Agent v0.11.0')
      now += 2_000
      expect(await hermesCli.getVersionCached()).toBe('Hermes Agent v0.12.0')
      expect(execCalls).toBe(2)
    } finally {
      dateNowSpy.mockRestore()
    }
  })

  it('exec failure surfaces as empty string without throwing', async () => {
    execImpl = vi.fn().mockRejectedValue(new Error('hermes CLI exploded'))
    const hermesCli = await loadHermesCli()

    const result = await hermesCli.getVersionCached()
    expect(result).toBe('')
    expect(execCalls).toBe(1)
  })
})