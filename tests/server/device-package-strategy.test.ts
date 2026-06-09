import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
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
    packageName: '',
    registry: '',
    sourceLabel: 'Device Manifest',
    distTag: 'latest',
    cliBin: '',
    script: '',
    channel: 'stable',
    manifestUrl: 'https://updates.example.com/stable/manifest.json',
    manifestBaseUrl: '',
    packageType: 'device-package',
    installerScript: '/opt/hermes-web-ui/scripts/install-device-package.sh',
    stagingDir: join(tmpdir(), 'hermes-web-ui-tests', 'staging'),
    backupDir: join(tmpdir(), 'hermes-web-ui-tests', 'backups'),
    healthcheckUrl: 'http://127.0.0.1:8648/health',
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
    sha256: 'a'.repeat(64),
    releasedAt: '2026-06-09T00:00:00Z',
    compatibleNodeMajor: Number.parseInt(process.versions.node.split('.')[0] || '0', 10),
    minCurrentVersion: '0.6.10',
    notesUrl: '',
    size: 0,
    healthcheckUrl: 'http://127.0.0.1:8648/health',
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

  it('rejects when the current version is below minCurrentVersion', () => {
    const manifest = createManifest({ minCurrentVersion: '0.6.12' })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.10')).toThrow(UpdateError)
    expect(() => assertDevicePackageCompatibility(manifest, '0.6.10')).toThrow(/minimum supported update version/)
  })

  it('rejects when the Node.js major version is incompatible', () => {
    const manifest = createManifest({ compatibleNodeMajor: 999 })

    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).toThrow(UpdateError)
    expect(() => assertDevicePackageCompatibility(manifest, '0.6.13')).toThrow(/requires Node\.js major/)
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

  it('builds installer command directly on non-Windows runtimes', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')

    expect(buildDevicePackageInstallCommand(update.installerScript, manifest, artifactPath)).toEqual({
      command: update.installerScript,
      args: ['--package', artifactPath, '--version', manifest.version],
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

  it('fails with UpdateError when bash is unavailable on Windows', () => {
    const manifest = createManifest()
    const update = createUpdateConfig()
    const artifactPath = '/tmp/hermes-web-ui-device-v0.6.13.tar.gz'

    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

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
    )).toThrow(/requires bash on Windows/)
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
      DEPLOY_DIR: '/opt/hermes-web-ui',
      HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: artifactPath,
      HERMES_WEB_UI_UPDATE_EXPECTED_SHA256: manifest.sha256,
    }))
  })
})
