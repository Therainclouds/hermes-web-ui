import { afterEach, describe, expect, it, vi } from 'vitest'

describe('update manifest client', () => {
  function createUpdateConfig() {
    return {
      enabled: true,
      strategy: 'device-package' as const,
      packageName: '',
      registry: '',
      sourceLabel: 'Fallback Source',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: '',
      manifestBaseUrl: '',
      packageType: 'device-package' as const,
      installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
      stagingDir: '/tmp/staging',
      backupDir: '/tmp/backups',
      healthcheckUrl: 'http://127.0.0.1:8648/health',
      stateFile: '/tmp/update-state.json',
      logDir: '/tmp/update-logs',
      healthcheckTimeoutMs: 2_000,
      healthcheckIntervalMs: 2_000,
      healthcheckRetries: 15,
      healthcheckInitialDelayMs: 5_000,
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('builds a channel manifest URL from the configured base URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/services/update/manifest-client')
    expect(buildManifestUrl('https://updates.example.com/releases/', 'stable')).toBe(
      'https://updates.example.com/releases/stable/latest.json',
    )
  })

  it('uses an explicit manifest URL when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        version: '1.2.3',
        channel: 'beta',
        sourceLabel: 'Internal Manifest',
        packageType: 'device-package',
      }),
    }))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/services/update/manifest-client')

    const result = await fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })

    expect(result).toEqual({
      version: '1.2.3',
      channel: 'beta',
      sourceLabel: 'Internal Manifest',
      packageType: 'device-package',
      manifestUrl: 'https://updates.example.com/custom.json',
    })
  })

  it('falls back to configured metadata when optional manifest fields are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        version: '1.2.4',
      }),
    }))
    const { resolveManifestCheckResult } = await import('../../packages/server/src/services/update/manifest-client')

    const result = await resolveManifestCheckResult({
      ...createUpdateConfig(),
      sourceLabel: 'Manifest Host',
      manifestBaseUrl: 'https://updates.example.com/releases',
    })

    expect(result).toEqual({
      latestVersion: '1.2.4',
      sourceLabel: 'Manifest Host',
      channel: 'stable',
      packageType: 'device-package',
      strategy: 'device-package',
      detectionSource: 'manifest',
    })
  })

  it('throws when the manifest omits a version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sourceLabel: 'Broken' }),
    }))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/services/update/manifest-client')

    await expect(fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })).rejects.toThrow(/version field/)
  })

  it('validates required execution fields for device package manifests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        version: '1.2.5',
        channel: 'stable',
        sourceLabel: 'Internal Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
        sha256: 'a'.repeat(64),
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
      }),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })

    expect(result.packageUrl).toContain('hermes-web-ui-device-v1.2.5.tar.gz')
    expect(result.artifactFormat).toBe('tar.gz')
    expect(result.compatibleNodeRange).toBe('>=23.0.0')
  })

  it('rejects invalid manifest channels before building the latest.json URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/services/update/manifest-client')

    expect(() => buildManifestUrl('https://updates.example.com/releases/', 'beta/canary')).toThrow(
      /Invalid update channel/,
    )
  })
})
