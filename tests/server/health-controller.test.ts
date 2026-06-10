import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const UPDATE_PACKAGE = '@quanthermes/hermes-web-ui'
const UPDATE_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_SOURCE_LABEL = 'Company npm registry'

function readRootPackage() {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    name: string
    version: string
  }
}

type LoadHealthControllerOptions = {
  injectedVersion?: string
  bridgeReadiness?: any
  bridgeReadinessError?: Error
  managerError?: Error
  runtimeStateError?: Error
}

const defaultBridgeReadiness = {
  endpoint: 'tcp://127.0.0.1:8123',
  endpointKind: 'tcp',
  status: 'ready',
  reachable: true,
  ready: true,
  running: true,
  attached: false,
  starting: false,
  stopping: false,
  restartScheduled: false,
  restartAttempts: 0,
  pid: 4321,
}

async function loadHealthController(options: LoadHealthControllerOptions = {}) {
  vi.resetModules()

  if (typeof options.injectedVersion === 'string') {
    ;(globalThis as any).__APP_VERSION__ = options.injectedVersion
  } else {
    delete (globalThis as any).__APP_VERSION__
  }

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  const checkReadiness = options.bridgeReadinessError
    ? vi.fn().mockRejectedValue(options.bridgeReadinessError)
    : vi.fn().mockResolvedValue(options.bridgeReadiness || defaultBridgeReadiness)
  const getRuntimeState = options.runtimeStateError
    ? vi.fn(() => { throw options.runtimeStateError })
    : vi.fn(() => ({
        endpoint: options.bridgeReadiness?.endpoint || 'ipc:///tmp/hermes-agent-bridge.sock',
      }))
  const getAgentBridgeManager = options.managerError
    ? vi.fn(() => { throw options.managerError })
    : vi.fn(() => ({ checkReadiness, getRuntimeState }))

  vi.doMock('../../packages/server/src/services/hermes/agent-bridge/manager', () => ({
    getAgentBridgeManager,
  }))

  const health = await import('../../packages/server/src/controllers/health')

  return {
    ...health,
    getAgentBridgeManager,
    checkReadiness,
    getRuntimeState,
  }
}

async function loadHealthControllerWithoutInjectedVersion(options: Omit<LoadHealthControllerOptions, 'injectedVersion'> = {}) {
  return loadHealthController(options)
}

async function loadHealthControllerWithInjectedVersion(version: string) {
  return loadHealthController({ injectedVersion: version })
}

function createMockCtx() {
  return {
    body: null as any,
  }
}

describe('health controller version metadata', () => {
  const originalUpdateEnabled = process.env.WEBUI_UPDATE_ENABLED
  const originalUpdatePackage = process.env.WEBUI_UPDATE_PACKAGE
  const originalUpdateRegistry = process.env.WEBUI_UPDATE_REGISTRY
  const originalUpdateCliBin = process.env.WEBUI_UPDATE_CLI_BIN
  const originalUpdateSourceLabel = process.env.WEBUI_UPDATE_SOURCE_LABEL
  const originalUpdateManifestUrl = process.env.WEBUI_UPDATE_MANIFEST_URL
  const originalUpdateManifestBaseUrl = process.env.WEBUI_UPDATE_MANIFEST_BASE_URL
  const originalUpdateChannel = process.env.WEBUI_UPDATE_CHANNEL
  const originalUpdateStrategy = process.env.WEBUI_UPDATE_STRATEGY
  const originalUpdatePackageType = process.env.WEBUI_UPDATE_PACKAGE_TYPE
  const originalUpdateInstallerScript = process.env.WEBUI_UPDATE_INSTALLER_SCRIPT

  beforeEach(() => {
    delete process.env.WEBUI_UPDATE_INSTALLER_SCRIPT
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = 'test'
    if (originalUpdateEnabled === undefined) delete process.env.WEBUI_UPDATE_ENABLED
    else process.env.WEBUI_UPDATE_ENABLED = originalUpdateEnabled
    if (originalUpdatePackage === undefined) delete process.env.WEBUI_UPDATE_PACKAGE
    else process.env.WEBUI_UPDATE_PACKAGE = originalUpdatePackage
    if (originalUpdateRegistry === undefined) delete process.env.WEBUI_UPDATE_REGISTRY
    else process.env.WEBUI_UPDATE_REGISTRY = originalUpdateRegistry
    if (originalUpdateCliBin === undefined) delete process.env.WEBUI_UPDATE_CLI_BIN
    else process.env.WEBUI_UPDATE_CLI_BIN = originalUpdateCliBin
    if (originalUpdateSourceLabel === undefined) delete process.env.WEBUI_UPDATE_SOURCE_LABEL
    else process.env.WEBUI_UPDATE_SOURCE_LABEL = originalUpdateSourceLabel
    if (originalUpdateManifestUrl === undefined) delete process.env.WEBUI_UPDATE_MANIFEST_URL
    else process.env.WEBUI_UPDATE_MANIFEST_URL = originalUpdateManifestUrl
    if (originalUpdateManifestBaseUrl === undefined) delete process.env.WEBUI_UPDATE_MANIFEST_BASE_URL
    else process.env.WEBUI_UPDATE_MANIFEST_BASE_URL = originalUpdateManifestBaseUrl
    if (originalUpdateChannel === undefined) delete process.env.WEBUI_UPDATE_CHANNEL
    else process.env.WEBUI_UPDATE_CHANNEL = originalUpdateChannel
    if (originalUpdateStrategy === undefined) delete process.env.WEBUI_UPDATE_STRATEGY
    else process.env.WEBUI_UPDATE_STRATEGY = originalUpdateStrategy
    if (originalUpdatePackageType === undefined) delete process.env.WEBUI_UPDATE_PACKAGE_TYPE
    else process.env.WEBUI_UPDATE_PACKAGE_TYPE = originalUpdatePackageType
    if (originalUpdateInstallerScript === undefined) delete process.env.WEBUI_UPDATE_INSTALLER_SCRIPT
    else process.env.WEBUI_UPDATE_INSTALLER_SCRIPT = originalUpdateInstallerScript
  })

  it('reads the root package version in ts-node/dev mode instead of falling back to 0.0.0', async () => {
    const pkg = readRootPackage()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe(pkg.version)
    expect(ctx.body.webui_version).not.toBe('0.0.0')
  })

  it('uses the injected build version when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedVersion('9.9.9-test')
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe('9.9.9-test')
  })

  it('checks npm latest using the configured package name', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '99.99.99' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.10-test')

    await checkLatestVersion()

    expect(fetchMock).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${encodeURIComponent(UPDATE_PACKAGE)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('99.99.99')
    expect(ctx.body.webui_update_enabled).toBe(true)
    expect(ctx.body.webui_update_available).toBe(true)
    expect(ctx.body.webui_update_source_label).toBe(UPDATE_SOURCE_LABEL)
    expect(ctx.body.webui_update_channel).toBe('stable')
    expect(ctx.body.webui_update_strategy).toBe('npm-package')
    expect(ctx.body.webui_update_package_type).toBe('device-package')
  })

  it('prefers manifest detection when a manifest URL is configured', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_SOURCE_LABEL = 'Device Manifest'
    process.env.WEBUI_UPDATE_CHANNEL = 'stable'
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'
    process.env.WEBUI_UPDATE_PACKAGE_TYPE = 'device-package'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        version: '0.6.99',
        channel: 'stable',
        sourceLabel: 'Stable Device Manifest',
        packageType: 'device-package',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.10-test')
    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://updates.example.com/stable/manifest.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(ctx.body.webui_latest).toBe('0.6.99')
    expect(ctx.body.webui_update_enabled).toBe(true)
    expect(ctx.body.webui_update_available).toBe(true)
    expect(ctx.body.webui_update_source_label).toBe('Stable Device Manifest')
    expect(ctx.body.webui_update_channel).toBe('stable')
    expect(ctx.body.webui_update_strategy).toBe('device-package')
    expect(ctx.body.webui_update_package_type).toBe('device-package')
  })

  it('falls back to the registry when manifest detection fails', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('manifest down'))
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ version: '0.6.88' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.10-test')
    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('0.6.88')
    expect(ctx.body.webui_update_source_label).toBe(UPDATE_SOURCE_LABEL)
    expect(ctx.body.webui_update_strategy).toBe('npm-package')
  })

  it('does not report an update when the local version is equal to or ahead of the registry version', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ version: '0.6.14' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ version: '0.6.13' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.14')

    await checkLatestVersion()

    const equalCtx = createMockCtx()
    await healthCheck(equalCtx)
    expect(equalCtx.body.webui_latest).toBe('0.6.14')
    expect(equalCtx.body.webui_update_available).toBe(false)

    await checkLatestVersion()

    const aheadCtx = createMockCtx()
    await healthCheck(aheadCtx)
    expect(aheadCtx.body.webui_latest).toBe('0.6.13')
    expect(aheadCtx.body.webui_update_available).toBe(false)
  })

  it('does not throw when latest-version lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { checkLatestVersion } = await loadHealthControllerWithoutInjectedVersion()

    await expect(checkLatestVersion()).resolves.toBeUndefined()
  })

  it('includes sanitized agent bridge readiness fields without leaking the endpoint path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, getAgentBridgeManager, checkReadiness } = await loadHealthControllerWithoutInjectedVersion({
      bridgeReadiness: {
        endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
        endpointKind: 'ipc',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: true,
        restartAttempts: 3,
        pid: 9876,
        error: 'connect ENOENT /tmp/hermes-agent-bridge.sock',
      },
    })
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(getAgentBridgeManager).toHaveBeenCalledTimes(1)
    expect(checkReadiness).toHaveBeenCalledWith({ timeoutMs: 75, connectRetryMs: 0 })
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unreachable',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restart_scheduled: true,
      restart_attempts: 3,
      endpoint_kind: 'ipc',
      pid: 9876,
      error: 'connect ENOENT [redacted endpoint]',
    })
    expect(ctx.body.agent_bridge).not.toHaveProperty('endpoint')
    expect(JSON.stringify(ctx.body.agent_bridge)).not.toContain('/tmp/hermes-agent-bridge.sock')
  })

  it('handles agent bridge readiness probe errors without failing the health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, checkReadiness, getRuntimeState } = await loadHealthControllerWithoutInjectedVersion({
      bridgeReadinessError: new Error('bridge manager unavailable at ipc:///tmp/hermes-agent-bridge.sock (ENOENT /tmp/hermes-agent-bridge.sock)'),
    })
    const ctx = createMockCtx()

    await expect(healthCheck(ctx)).resolves.toBeUndefined()

    expect(checkReadiness).toHaveBeenCalledWith({ timeoutMs: 75, connectRetryMs: 0 })
    expect(getRuntimeState).toHaveBeenCalledTimes(1)
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.gateway).toBe('running')
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unknown',
      reachable: false,
      error: 'bridge manager unavailable at [redacted endpoint] (ENOENT [redacted endpoint])',
    })
    expect(JSON.stringify(ctx.body.agent_bridge)).not.toContain('/tmp/hermes-agent-bridge.sock')
    expect(JSON.stringify(ctx.body.agent_bridge)).not.toContain('ipc:///tmp/hermes-agent-bridge.sock')
  })

  it('handles manager construction errors without failing the base health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, getAgentBridgeManager, checkReadiness } = await loadHealthControllerWithoutInjectedVersion({
      managerError: new Error('bad bridge config /tmp/hermes-agent-bridge.sock'),
    })
    const ctx = createMockCtx()

    await expect(healthCheck(ctx)).resolves.toBeUndefined()

    expect(getAgentBridgeManager).toHaveBeenCalledTimes(1)
    expect(checkReadiness).not.toHaveBeenCalled()
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unknown',
      reachable: false,
      error: 'bad bridge config [redacted endpoint]',
    })
  })

  it('handles runtime-state errors without failing the base health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, getRuntimeState, checkReadiness } = await loadHealthControllerWithoutInjectedVersion({
      runtimeStateError: new Error('runtime state unavailable'),
    })
    const ctx = createMockCtx()

    await expect(healthCheck(ctx)).resolves.toBeUndefined()

    expect(getRuntimeState).toHaveBeenCalledTimes(1)
    expect(checkReadiness).not.toHaveBeenCalled()
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unknown',
      reachable: false,
      error: 'runtime state unavailable',
    })
  })

})
