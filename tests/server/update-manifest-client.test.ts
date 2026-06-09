import { afterEach, describe, expect, it, vi } from 'vitest'

describe('update manifest client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('builds a channel manifest URL from the configured base URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/services/update/manifest-client')
    expect(buildManifestUrl('https://updates.example.com/releases/', 'stable')).toBe(
      'https://updates.example.com/releases/stable/manifest.json',
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
      enabled: true,
      strategy: 'device-package',
      packageName: '',
      registry: '',
      sourceLabel: 'Fallback Source',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: 'https://updates.example.com/custom.json',
      manifestBaseUrl: '',
      packageType: 'device-package',
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
      enabled: true,
      strategy: 'device-package',
      packageName: '',
      registry: '',
      sourceLabel: 'Manifest Host',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: '',
      manifestBaseUrl: 'https://updates.example.com/releases',
      packageType: 'device-package',
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
      enabled: true,
      strategy: 'device-package',
      packageName: '',
      registry: '',
      sourceLabel: 'Fallback Source',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: 'https://updates.example.com/custom.json',
      manifestBaseUrl: '',
      packageType: 'device-package',
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
        compatibleNodeMajor: 23,
        minCurrentVersion: '1.2.0',
      }),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      enabled: true,
      strategy: 'device-package',
      packageName: '',
      registry: '',
      sourceLabel: 'Fallback Source',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: 'https://updates.example.com/custom.json',
      manifestBaseUrl: '',
      packageType: 'device-package',
      installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
      stagingDir: '/tmp/staging',
      backupDir: '/tmp/backups',
      healthcheckUrl: 'http://127.0.0.1:8648/health',
    })

    expect(result.packageUrl).toContain('hermes-web-ui-device-v1.2.5.tar.gz')
    expect(result.artifactFormat).toBe('tar.gz')
  })
})
