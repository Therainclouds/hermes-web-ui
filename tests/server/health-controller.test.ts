import { afterEach, describe, expect, it, vi } from 'vitest'
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

async function loadHealthControllerWithoutInjectedVersion() {
  vi.resetModules()
  delete (globalThis as any).__APP_VERSION__

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithInjectedVersion(version: string) {
  vi.resetModules()
  ;(globalThis as any).__APP_VERSION__ = version

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
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
    expect(ctx.body.webui_update_enabled).toBe(false)
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
})
