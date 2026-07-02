import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateError } from '../../packages/server/src/services/update/errors'
import {
  assertDevicePackageCompatibility,
  buildDevicePackageInstallCommand,
  buildDevicePackageInstallEnv,
  downloadAndVerifyDevicePackage,
} from '../../packages/server/src/services/update/strategies/device-package'
import type { DevicePackageManifest, UpdateConfig } from '../../packages/server/src/services/update/types'

function createUpdateConfig(overrides: Partial<UpdateConfig> = {}): UpdateConfig {
  return {
    enabled: true,
    strategy: 'device-package',
    includeAgentUpgrade: false,
    packageName: '',
    registry: '',
    sourceLabel: 'Device Manifest',
    distTag: 'latest',
    cliBin: '',
    script: '',
    channel: 'stable',
    manifestUrl: 'https://updates.example.com/stable/manifest.json',
    manifestUrls: [],
    manifestBaseUrl: '',
    packageType: 'device-package',
    installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
    stagingDir: join(tmpdir(), 'hermes-web-ui-tests', 'staging'),
    backupDir: join(tmpdir(), 'hermes-web-ui-tests', 'backups'),
    healthcheckUrl: 'http://127.0.0.1:6060/health',
    stateFile: join(tmpdir(), 'hermes-web-ui-tests', 'update-state.json'),
    logDir: join(tmpdir(), 'hermes-web-ui-tests', 'logs'),
    manifestTimeoutMs: 100,
    packageTimeoutMs: 100,
    downloadRetries: 0,
    downloadRetryDelayMs: 1,
    healthcheckTimeoutMs: 2_000,
    healthcheckIntervalMs: 2_000,
    healthcheckRetries: 15,
    healthcheckInitialDelayMs: 5_000,
    ...overrides,
  }
}

function createManifest(overrides: Partial<DevicePackageManifest> = {}): DevicePackageManifest {
  return {
    version: '0.6.13',
    channel: 'stable',
    sourceLabel: 'Device Manifest',
    packageType: 'device-package',
    manifestUrl: 'https://updates.example.com/stable/manifest.json',
    artifactFormat: 'tar.gz',
    packageUrl: 'https://updates.example.com/releases/v0.6.13/hermes-web-ui-device-v0.6.13.tar.gz',
    packageUrls: undefined,
    sha256: 'a'.repeat(64),
    releasedAt: '2026-06-09T00:00:00Z',
    compatibleNodeRange: `>=${process.versions.node}`,
    minCurrentVersion: '0.6.10',
    notesUrl: '',
    size: 0,
    healthcheckUrl: 'http://127.0.0.1:6060/health',
    ...overrides,
  }
}

describe('device package strategy', () => {
  let tempRoot = ''

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = ''
    }
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

  it('rejects when the current version is below minCurrentVersion', () => {
    const manifest = createManifest({ minCurrentVersion: '0.6.12' })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.10')).toThrow(UpdateError)
    expect(() => assertDevicePackageCompatibility(manifest, '0.6.10')).toThrow(/minimum supported update version/)
  })

  it('rejects when the Node.js version is incompatible with the declared range', () => {
    const manifest = createManifest({ compatibleNodeRange: '>999.0.0' })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).toThrow(UpdateError)
    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).toThrow(/requires Node\.js/)
  })

  it('allows runtimes that satisfy the declared Node.js range', () => {
    const currentMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10)
    const manifest = createManifest({ compatibleNodeRange: `>=${currentMajor}.0.0` })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).not.toThrow()
  })

  it('downloads the package and validates the checksum', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package bytes')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => packageBuffer,
    }))

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({ sha256 }),
    )

    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('fails when the downloaded checksum does not match the manifest', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('wrong content'),
    }))

    await expect(downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({ sha256: 'f'.repeat(64) }),
    )).rejects.toMatchObject({
      code: 'update_sha256_mismatch',
    })
  })

  it('falls back to node-http when fetch fails during package download', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package via fallback')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await withHttpServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(packageBuffer)
    }, async (baseUrl) => {
      const result = await downloadAndVerifyDevicePackage(
        createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
        createManifest({
          packageUrl: `${baseUrl}/device-package.tar.gz`,
          sha256,
        }),
      )

      expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
    })
  })

  it('tries the next package source when the primary URL fails', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package via fallback source list')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => packageBuffer,
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({
        packageUrl: 'https://oss.example.com/device-package.tar.gz',
        packageUrls: [
          'https://oss.example.com/device-package.tar.gz',
          'https://github.com/example/device-package.tar.gz',
        ],
        sha256,
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('returns a structured package fetch failure when both transports fail', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' })))

    await expect(downloadAndVerifyDevicePackage(
      createUpdateConfig({ stagingDir: join(tempRoot, 'staging') }),
      createManifest({ packageUrl: 'http://127.0.0.1:1/device-package.tar.gz' }),
    )).rejects.toMatchObject({
      code: 'update_package_fetch_failed',
      details: expect.objectContaining({
        packageUrl: 'http://127.0.0.1:1/device-package.tar.gz',
        packageUrls: ['http://127.0.0.1:1/device-package.tar.gz'],
        failures: expect.arrayContaining([
          expect.objectContaining({
            packageUrl: 'http://127.0.0.1:1/device-package.tar.gz',
          }),
        ]),
      }),
    })
  })

  it('retries transient package download failures before succeeding', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-web-ui-device-package-'))
    const packageBuffer = Buffer.from('device package after retries')
    const sha256 = createHash('sha256').update(packageBuffer).digest('hex')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValue({
        ok: true,
        arrayBuffer: async () => packageBuffer,
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAndVerifyDevicePackage(
      createUpdateConfig({
        stagingDir: join(tempRoot, 'staging'),
        downloadRetries: 2,
        downloadRetryDelayMs: 1,
      }),
      createManifest({ sha256 }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(readFileSync(result.artifactPath)).toEqual(packageBuffer)
  })

  it('builds installer command through a discovered bash executable on Linux', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    expect(buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => '/bin/bash',
    )).toEqual({
      command: '/bin/bash',
      args: [update.installerScript, '--package', artifactPath, '--version', manifest.version],
    })
  })

  it('builds installer command through a discovered bash executable on Windows', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    expect(buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => 'C:\\Program Files\\Git\\bin\\bash.exe',
    )).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: [update.installerScript, '--package', artifactPath, '--version', manifest.version],
    })
  })

  it('fails with UpdateError when bash is unavailable', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    expect(() => buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => undefined,
    )).toThrow(UpdateError)
    expect(() => buildDevicePackageInstallCommand(
      update.installerScript,
      manifest,
      artifactPath,
      () => undefined,
    )).toThrow(/requires bash, but no bash executable was found in PATH/)
  })

  it('builds installer env for the device package workflow', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    expect(buildDevicePackageInstallEnv(
      update,
      { PATH: process.env.PATH || '' },
      manifest,
      artifactPath,
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/home/hermesui/.hermes-web-ui',
        uploadDir: '/home/hermesui/.hermes-web-ui/upload',
        hermesHome: '/opt/hermes-web-ui/hermes_data',
      },
      'task-123',
    )).toEqual(expect.objectContaining({
      APP_USER: 'hermesui',
      DEPLOY_DIR: '/opt/hermes-web-ui',
      HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: artifactPath,
      HERMES_WEB_UI_UPDATE_EXPECTED_SHA256: manifest.sha256,
      HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: 'false',
    }))
  })
})
