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
  isDocker?: boolean
  bridgeReadiness?: any
  bridgeReadinessError?: Error
  managerError?: Error
  runtimeStateError?: Error
  terminalStatus?: {
    enabled: boolean
    ready: boolean
    transport: 'node-pty' | 'disabled'
    reason: 'ready' | 'websocket_not_initialized' | 'node_pty_failed_to_load'
    requiresSuperAdmin: boolean
  }
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

const defaultTerminalStatus = {
  enabled: true,
  ready: true,
  transport: 'node-pty' as const,
  reason: 'ready' as const,
  requiresSuperAdmin: true,
}

async function loadHealthController(options: LoadHealthControllerOptions = {}) {
  vi.resetModules()

  if (typeof options.injectedVersion === 'string') {
    ;(globalThis as any).__APP_VERSION__ = options.injectedVersion
  } else {
    delete (globalThis as any).__APP_VERSION__
  }

  const getVersion = vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n')
  const getVersionCached = vi.fn().mockImplementation(async () => getVersion())
  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion,
    getVersionCached,
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
  vi.doMock('../../packages/server/src/services/runtime-environment', () => ({
    isDockerContainer: () => options.isDocker === true,
  }))

  vi.doMock('../../packages/server/src/services/terminal/runtime-state', () => ({
    getTerminalRuntimeStatus: vi.fn(() => options.terminalStatus || defaultTerminalStatus),
  }))

  const health = await import('../../packages/server/src/controllers/health')

  return {
    ...health,
    getVersion,
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

describe('liveness controller', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns a static ok response without probing Hermes or Agent Bridge', async () => {
    const { livenessCheck, getVersion, getAgentBridgeManager } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    livenessCheck(ctx)

    expect(ctx.body).toEqual({ status: 'ok' })
    expect(getVersion).not.toHaveBeenCalled()
    expect(getAgentBridgeManager).not.toHaveBeenCalled()
  })
})

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
    delete process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS
    delete process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES
    delete process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS
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

  it('surfaces terminal runtime readiness in the health payload', async () => {
    const { healthCheck } = await loadHealthControllerWithInjectedVersion('9.9.9-test')
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.terminal).toEqual(defaultTerminalStatus)
  })

  it('reports terminal startup failures so device installs can fail fast', async () => {
    const { healthCheck } = await loadHealthController({
      injectedVersion: '9.9.9-test',
      terminalStatus: {
        enabled: false,
        ready: false,
        transport: 'disabled',
        reason: 'node_pty_failed_to_load',
        requiresSuperAdmin: true,
      },
    })
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.terminal).toEqual({
      enabled: false,
      ready: false,
      transport: 'disabled',
      reason: 'node_pty_failed_to_load',
      requiresSuperAdmin: true,
    })
  })

  it('does not probe the npm registry when only package/registry env vars are set', async () => {
    // The version probe is manifest-only. Even with package/registry configured,
    // we must not hit the npm registry for version detection.
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // The branded build configures a default manifest base URL, so the manifest
    // check is always active; stub a full Response so no real network is used.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ version: '99.99.99', channel: 'stable' }))),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.10-test')

    await checkLatestVersion()

    expect(fetchMock).not.toHaveBeenCalledWith(
      `https://registry.npmjs.org/${encodeURIComponent(UPDATE_PACKAGE)}`,
      expect.anything(),
    )

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('99.99.99')
    expect(ctx.body.webui_update_available).toBe(true)
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
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '0.6.99',
        channel: 'stable',
        sourceLabel: 'Stable Device Manifest',
        packageType: 'device-package',
      }))),
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

  it('only fetches the manifest for version detection and never probes the npm registry', async () => {
    // Both sources are configured, but the manifest must win; npm must not be touched.
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '0.6.42',
        channel: 'stable',
        sourceLabel: 'Device Manifest',
        packageType: 'device-package',
      }))),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.10-test')
    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://updates.example.com/stable/manifest.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('registry.npmjs.org'),
      expect.anything(),
    )
    expect(ctx.body.webui_latest).toBe('0.6.42')
  })

  it('does not report an update when the local version is equal to or ahead of the manifest version', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'https://updates.example.com/stable/manifest.json'
    process.env.WEBUI_UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL
    process.env.WEBUI_UPDATE_STRATEGY = 'device-package'

    const buildManifestResponse = (version: string) => ({
      ok: true,
      url: 'https://updates.example.com/stable/manifest.json',
      arrayBuffer: vi.fn().mockResolvedValue(
        Buffer.from(JSON.stringify({
          version,
          channel: 'stable',
          sourceLabel: 'Device Manifest',
          packageType: 'device-package',
        })),
      ),
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(buildManifestResponse('0.6.14'))
      .mockResolvedValueOnce(buildManifestResponse('0.6.13'))
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

  it('ignores legacy registry payloads when manifest detection is not configured', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Branded builds always configure a default manifest URL; point it at an
    // unreachable local port and reject fetch so both transports fail fast and
    // offline, proving legacy registry payloads (mocked via `json`) never surface.
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_MANIFEST_URL = 'http://127.0.0.1:9/manifest.json'
    process.env.WEBUI_UPDATE_MANIFEST_BASE_URL = 'http://127.0.0.1:9'
    process.env.WEBUI_UPDATE_MANIFEST_TIMEOUT_MS = '400'
    process.env.WEBUI_UPDATE_DOWNLOAD_RETRIES = '1'
    process.env.WEBUI_UPDATE_DOWNLOAD_RETRY_DELAY_MS = '1'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.18')

    await checkLatestVersion()

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('')
    expect(ctx.body.webui_update_available).toBe(false)
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Update available'))
  })

  it('does not throw when latest-version lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { checkLatestVersion } = await loadHealthControllerWithoutInjectedVersion()

    await expect(checkLatestVersion()).resolves.toBeUndefined()
  })

  it('reports Docker while retaining version checks for upgrade guidance', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://updates.example.com/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ version: '0.6.29', channel: 'stable' }))),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkLatestVersion, healthCheck } = await loadHealthController({
      injectedVersion: '0.6.28',
      isDocker: true,
    })

    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(ctx.body).toEqual(expect.objectContaining({
      is_docker: true,
      webui_latest: '0.6.29',
      webui_update_available: true,
    }))
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

describe('health controller environment field', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('exposes the last environment check in the health payload', async () => {
    const driftEntry = {
      gate: 'requiredNodeRange',
      expected: '>=20.0.0',
      actual: 'v18.20.0',
    }
    const fakeEnvironmentCheck = {
      status: 'drift_detected',
      capturedAt: '2026-08-25T10:00:00Z',
      manifestVersion: '0.7.20',
      actualVersion: '0.7.19',
      nodeVersion: 'v18.20.0',
      agentVersion: '0.11.0',
      drift: [driftEntry],
      reconcileSupported: true,
      checkedAt: '2026-08-25T10:30:00Z',
    }

    vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
      getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
      getVersionCached: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
    }))
    vi.doMock('../../packages/server/src/services/update/reconcile', () => ({
      getLastEnvironmentCheck: () => fakeEnvironmentCheck,
    }))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.resetModules()

    const healthModule = await import('../../packages/server/src/controllers/health')
    const ctx = createMockCtx()
    await healthModule.healthCheck(ctx)

    expect(ctx.body.environment).toEqual(fakeEnvironmentCheck)
  })

  it('exposes the unavailable status when no env-state.json has been captured yet', async () => {
    const fakeEnvironmentCheck = {
      status: 'unavailable',
      capturedAt: null,
      manifestVersion: null,
      actualVersion: null,
      nodeVersion: null,
      agentVersion: null,
      drift: [],
      reconcileSupported: false,
      checkedAt: '',
    }

    vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
      getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
      getVersionCached: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
    }))
    vi.doMock('../../packages/server/src/services/update/reconcile', () => ({
      getLastEnvironmentCheck: () => fakeEnvironmentCheck,
    }))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.resetModules()

    const healthModule = await import('../../packages/server/src/controllers/health')
    const ctx = createMockCtx()
    await healthModule.healthCheck(ctx)

    expect(ctx.body.environment.status).toBe('unavailable')
    expect(ctx.body.environment.drift).toEqual([])
    expect(ctx.body.environment.reconcileSupported).toBe(false)
  })

})
