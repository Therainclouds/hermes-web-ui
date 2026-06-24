import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }
let hermesHome = ''

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  process.env = { ...originalEnv }
  if (hermesHome && existsSync(hermesHome)) {
    rmSync(hermesHome, { recursive: true, force: true })
  }
  hermesHome = ''
})

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'reaper-test-'))
  mkdirSync(join(root, 'profiles', 'alpha'), { recursive: true })
  mkdirSync(join(root, 'profiles', 'beta'), { recursive: true })
  hermesHome = root
  return root
}

function writePidFile(profile: string, pid: number): string {
  const path = join(hermesHome, 'profiles', profile, 'gateway.pid')
  writeFileSync(path, JSON.stringify({ pid }))
  return path
}

describe('gateway-reaper env/platform gating', () => {
  it('runs on linux by default', async () => {
    vi.resetModules()
    const { shouldRunGatewayReaper } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )
    expect(shouldRunGatewayReaper('linux', {})).toBe(true)
  })

  it('runs on darwin by default', async () => {
    vi.resetModules()
    const { shouldRunGatewayReaper } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )
    expect(shouldRunGatewayReaper('darwin', {})).toBe(true)
  })

  it('runs on win32 by default', async () => {
    vi.resetModules()
    const { shouldRunGatewayReaper } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )
    expect(shouldRunGatewayReaper('win32', {})).toBe(true)
  })

  it('refuses unsupported platforms', async () => {
    vi.resetModules()
    const { shouldRunGatewayReaper } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )
    // Cast to any to verify the negative path
    expect(shouldRunGatewayReaper('aix' as any, {})).toBe(false)
  })

  it('respects HERMES_WEB_UI_DISABLE_GATEWAY_REAPER', async () => {
    vi.resetModules()
    const { shouldRunGatewayReaper } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )
    expect(shouldRunGatewayReaper('linux', { HERMES_WEB_UI_DISABLE_GATEWAY_REAPER: '1' })).toBe(false)
    expect(shouldRunGatewayReaper('linux', { HERMES_WEB_UI_DISABLE_GATEWAY_REAPER: 'true' })).toBe(false)
  })

  it('reads interval from env, defaulting to 30s', async () => {
    vi.resetModules()
    const { readGatewayReaperIntervalMs } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )
    expect(readGatewayReaperIntervalMs({})).toBe(30_000)
    expect(readGatewayReaperIntervalMs({ HERMES_WEB_UI_GATEWAY_REAPER_INTERVAL_MS: '15000' })).toBe(15_000)
    expect(readGatewayReaperIntervalMs({ HERMES_WEB_UI_GATEWAY_REAPER_INTERVAL_MS: '500' })).toBe(30_000) // too small
    expect(readGatewayReaperIntervalMs({ HERMES_WEB_UI_GATEWAY_REAPER_INTERVAL_MS: 'bogus' })).toBe(30_000)
  })
})

describe('reapGatewayOrphans', () => {
  it('removes stale PID files (dead process) and reports them', async () => {
    makeHome()
    const pidPath = writePidFile('alpha', 999_999_999) // almost certainly dead
    // Also write lock + state files referencing the same dead pid
    writeFileSync(join(hermesHome, 'profiles', 'alpha', 'gateway.lock'),
      JSON.stringify({ pid: 999_999_999, locked_at: 'x' }))
    writeFileSync(join(hermesHome, 'profiles', 'alpha', 'gateway_state.json'),
      JSON.stringify({ pid: 999_999_999, gateway_state: 'running' }))

    vi.resetModules()
    const { reapGatewayOrphans } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )

    // isAlive returns false for this pid
    const isAlive = (pid: number) => pid !== 999_999_999
    const result = await reapGatewayOrphans({
      hermesHome, platform: 'linux', env: {}, isAlive,
    })

    expect(result.scannedProfiles).toBe(2) // alpha + beta
    expect(result.stalePids).toContain(999_999_999)
    expect(result.cleanedFiles.length).toBeGreaterThanOrEqual(1)
    expect(result.cleanedFiles).toContain(pidPath)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('skips live PIDs that are tracked by the managed runner', async () => {
    makeHome()
    // A live pid that we are managing
    writePidFile('alpha', 1234)
    // isAlive returns true for it; managedPids includes it
    vi.resetModules()
    const { reapGatewayOrphans } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )

    const result = await reapGatewayOrphans({
      hermesHome, platform: 'linux', env: {},
      isAlive: () => true,
      managedPids: [1234],
    })
    // Should be silently skipped — not in stalePids, not in liveOrphans,
    // no files cleaned.
    expect(result.stalePids).toEqual([])
    expect(result.liveOrphans).toEqual([])
    expect(result.cleanedFiles).toEqual([])
    expect(existsSync(join(hermesHome, 'profiles', 'alpha', 'gateway.pid'))).toBe(true)
  })

  it('reports live-but-untracked PIDs in liveOrphans but does NOT kill them', async () => {
    makeHome()
    writePidFile('alpha', 4242)
    vi.resetModules()
    const { reapGatewayOrphans } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )

    const result = await reapGatewayOrphans({
      hermesHome, platform: 'linux', env: {},
      isAlive: () => true,
      managedPids: [], // not tracked
    })

    expect(result.liveOrphans).toContain(4242)
    // Crucially: file is NOT touched
    expect(existsSync(join(hermesHome, 'profiles', 'alpha', 'gateway.pid'))).toBe(true)
  })

  it('is a no-op when HERMES_WEBUI_STATE_DIR / hermesHome is missing', async () => {
    hermesHome = '' // simulate unset
    vi.resetModules()
    const { reapGatewayOrphans } = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )

    const result = await reapGatewayOrphans({
      hermesHome: '/nonexistent/path/that/should/not/exist',
      platform: 'linux', env: {}, isAlive: () => true,
    })
    expect(result.attempted).toBe(true)
    expect(result.scannedProfiles).toBe(0)
    expect(result.cleanedFiles).toEqual([])
  })
})

describe('startPeriodicGatewayReaper / stopPeriodicGatewayReaper', () => {
  it('starts and stops a periodic sweep', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const autostart = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )

    autostart.startPeriodicGatewayReaper(1000)
    // Idempotent: second call is a no-op
    autostart.startPeriodicGatewayReaper(1000)
    autostart.stopPeriodicGatewayReaper()
    autostart.stopPeriodicGatewayReaper()
    // No assertion on a specific number; the contract is "doesn't throw"
  })

  it('refuses to start when env-disabled', async () => {
    process.env.HERMES_WEB_UI_DISABLE_GATEWAY_REAPER = '1'
    vi.useFakeTimers()
    vi.resetModules()
    const autostart = await import(
      '../../packages/server/src/services/hermes/gateway-autostart'
    )

    // Should silently disable
    autostart.startPeriodicGatewayReaper(1000)
    // No timer scheduled — advancing time should not throw
    await vi.advanceTimersByTimeAsync(5000)
  })
})
