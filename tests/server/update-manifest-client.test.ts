import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('update manifest client', () => {
  function createUpdateConfig() {
    return {
      enabled: true,
      strategy: 'device-package' as const,
      includeAgentUpgrade: false,
      packageName: '',
      registry: '',
      sourceLabel: 'Fallback Source',
      distTag: 'latest',
      cliBin: '',
      script: '',
      channel: 'stable',
      manifestUrl: '',
      manifestUrls: [],
      manifestBaseUrl: '',
      packageType: 'device-package' as const,
      installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
      stagingDir: '/tmp/staging',
      backupDir: '/tmp/backups',
      healthcheckUrl: 'http://127.0.0.1:6060/health',
      stateFile: '/tmp/update-state.json',
      logDir: '/tmp/update-logs',
      manifestTimeoutMs: 100,
      packageTimeoutMs: 100,
      downloadRetries: 0,
      downloadRetryDelayMs: 1,
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

  async function withHttpServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      await run(baseUrl)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    }
  }

  it('builds a channel manifest URL from the configured base URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/services/update/manifest-client')
    expect(buildManifestUrl('https://updates.example.com/releases/', 'stable')).toBe(
      'https://updates.example.com/releases/stable/latest.json',
    )
  })

  it('uses an explicit manifest URL when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/custom.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.3',
        channel: 'beta',
        sourceLabel: 'Internal Manifest',
        packageType: 'device-package',
      }))),
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

  it('falls back to the next configured manifest URL when the first source fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://oss.example.com/releases/stable/latest.json',
        arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
          version: '1.2.3',
          channel: 'stable',
          sourceLabel: 'OSS Manifest',
          packageType: 'device-package',
        }))),
      })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/services/update/manifest-client')

    const result = await fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrls: [
        'https://raw.example.com/releases/stable/latest.json',
        'https://oss.example.com/releases/stable/latest.json',
      ],
    })

    expect(result).toEqual({
      version: '1.2.3',
      channel: 'stable',
      sourceLabel: 'OSS Manifest',
      packageType: 'device-package',
      manifestUrl: 'https://oss.example.com/releases/stable/latest.json',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to configured metadata when optional manifest fields are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://updates.example.com/releases/stable/latest.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.4',
      }))),
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
      url: 'https://updates.example.com/custom.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ sourceLabel: 'Broken' }))),
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
      url: 'https://updates.example.com/custom.json',
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({
        version: '1.2.5',
        channel: 'stable',
        sourceLabel: 'Internal Manifest',
        packageType: 'device-package',
        artifactFormat: 'tar.gz',
        packageUrl: 'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
        packageUrls: [
          'https://oss.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
          'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
        ],
        sha256: 'a'.repeat(64),
        releasedAt: '2026-06-09T00:00:00Z',
        compatibleNodeRange: '>=23.0.0',
        minCurrentVersion: '1.2.0',
      }))),
    }))
    const { fetchDevicePackageManifest } = await import('../../packages/server/src/services/update/manifest-client')

    const result = await fetchDevicePackageManifest({
      ...createUpdateConfig(),
      manifestUrl: 'https://updates.example.com/custom.json',
    })

    expect(result.packageUrl).toContain('hermes-web-ui-device-v1.2.5.tar.gz')
    expect(result.packageUrls).toEqual([
      'https://oss.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
      'https://updates.example.com/releases/v1.2.5/hermes-web-ui-device-v1.2.5.tar.gz',
    ])
    expect(result.artifactFormat).toBe('tar.gz')
    expect(result.compatibleNodeRange).toBe('>=23.0.0')
  })

  it('falls back to node-http when fetch fails for manifest requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await withHttpServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        version: '1.2.6',
        channel: 'stable',
        sourceLabel: 'Fallback Manifest',
        packageType: 'device-package',
      }))
    }, async (baseUrl) => {
      const { fetchManifestUpdateInfo } = await import('../../packages/server/src/services/update/manifest-client')

      const result = await fetchManifestUpdateInfo({
        ...createUpdateConfig(),
        manifestUrl: `${baseUrl}/stable/latest.json`,
      })

      expect(result).toEqual({
        version: '1.2.6',
        channel: 'stable',
        sourceLabel: 'Fallback Manifest',
        packageType: 'device-package',
        manifestUrl: `${baseUrl}/stable/latest.json`,
      })
    })
  })

  it('surfaces a structured manifest fetch failure when both transports fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' })))
    const { fetchManifestUpdateInfo } = await import('../../packages/server/src/services/update/manifest-client')

    await expect(fetchManifestUpdateInfo({
      ...createUpdateConfig(),
      manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
    })).rejects.toMatchObject({
      code: 'update_manifest_fetch_failed',
      details: expect.objectContaining({
        manifestUrls: ['http://127.0.0.1:1/stable/latest.json'],
        failures: expect.arrayContaining([
          expect.objectContaining({
            manifestUrl: 'http://127.0.0.1:1/stable/latest.json',
          }),
        ]),
      }),
    })
  })

  it('rejects invalid manifest channels before building the latest.json URL', async () => {
    const { buildManifestUrl } = await import('../../packages/server/src/services/update/manifest-client')

    expect(() => buildManifestUrl('https://updates.example.com/releases/', 'beta/canary')).toThrow(
      /Invalid update channel/,
    )
  })
})
