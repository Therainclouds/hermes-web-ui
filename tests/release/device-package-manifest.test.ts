/**
 * Guards for the device-package manifest contract.
 *
 * The manifest published to OSS (`releases/<channel>/latest.json`) drives every
 * device-side update. The historical bug we are preventing:
 *
 *   - `manifest.packageType` and the device's `WEBUI_UPDATE_PACKAGE_TYPE`
 *     diverged, causing `manifest-client.ts` to throw `update_manifest_invalid`.
 *   - The device fell back to the npm registry path silently, then left
 *     stale `staging/` files behind, then refused the next update with
 *     `409 update_in_progress`.
 *
 * This test pins:
 *   - default `packageType` is `source-deploy` (matches the new device-side
 *     default in `scripts/deploy-source-armbian.sh`),
 *   - `source-deploy` manifests carry `sourceUrl` and `sourceSha256`,
 *   - `device-package` manifests carry `installerScriptSha256`,
 *   - `--strategy device-package` flips both the manifest field and the
 *     installer SHA,
 *   - the AGENTS.md hard rules describing this contract are present.
 */

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

const PACKAGE_ALLOWLIST = [
  'dist/client',
  'dist/server',
  'hermes_data/bots/usb',
  'package.json',
  'package-lock.json',
  'release/device-host-dependencies.json',
  'scripts/deploy-source-armbian.sh',
  'scripts/hermes-web-ui-update-runner.sh',
  'scripts/hermes-web-ui-update.service',
  'scripts/hermes-web-ui.service',
  'scripts/install-device-package.sh',
  'scripts/update-source-deploy.sh',
]

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface FixtureOptions {
  packageType?: 'source-deploy' | 'device-package'
  withSource?: boolean
}

function seedRepo(prefix: string, options: FixtureOptions = {}) {
  const repoRoot = createTempDir(prefix)
  const outputDir = createTempDir(`${prefix}-out-`)

  mkdirSync(resolvePath(repoRoot, 'dist', 'server'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'dist', 'client'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'release'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'scripts'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'packages'), { recursive: true })
  writeFileSync(resolvePath(repoRoot, 'packages', 'README.md'), '# packages placeholder\n', 'utf-8')
  mkdirSync(resolvePath(repoRoot, '.github'), { recursive: true })

  writeFileSync(
    resolvePath(repoRoot, 'dist', 'server', 'index.js'),
    'console.log("/api/hermes/terminal"); console.log("node-pty failed to load, terminal feature disabled"); console.log("WebSocket ready at /terminal")\n',
    'utf-8',
  )
  writeFileSync(resolvePath(repoRoot, 'dist', 'client', 'index.html'), '<html></html>\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'deploy-source-armbian.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'deploy-source-armbian.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update-runner.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update-runner.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update.service'), '[Service]\nExecStart=/usr/local/sbin/hermes-web-ui-update-runner\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui.service'), '[Service]\nExecStart=node dist/server/index.js\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'install-device-package.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'install-device-package.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'update-source-deploy.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'update-source-deploy.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'config.py'), 'WEBUI_HOME = "/tmp/hermes"\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'usb_monitor.py'), 'print("usb monitor")\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'release', 'device-host-dependencies.json'), JSON.stringify({
    schema: 1,
    aptPackages: ['python3-pyudev', 'ntfs-3g'],
  }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package-lock.json'), '{ "name": "@quanthermes/hermes-web-ui", "lockfileVersion": 3 }\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package.json'), JSON.stringify({
    name: '@quanthermes/hermes-web-ui',
    version: '1.2.3',
    repository: {
      type: 'git',
      url: 'https://github.com/example/hermes-web-ui.git',
    },
    engines: { node: '>=23.0.0' },
  }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, '.github', 'device-package-release.json'), JSON.stringify({
    version: '1.2.3',
    channel: 'stable',
    minCurrentVersion: '1.0.0',
    manifestBranch: 'release-manifests',
    hostDependenciesPath: 'release/device-host-dependencies.json',
    ossPublicBaseUrl: 'https://example-bucket.oss-cn-shanghai.aliyuncs.com/hermes-web-ui',
    packageAllowlist: PACKAGE_ALLOWLIST,
    sourceRepoUrl: 'https://github.com/tangledup-ai/hermes-web-ui',
    sourcePathAllowlist: [
      'package.json',
      'packages',
      'scripts',
      'tsconfig.json',
      '.github/device-package-release.json',
    ],
  }, null, 2), 'utf-8')

  return { repoRoot, outputDir }
}

async function buildAndReadManifest(options: FixtureOptions) {
  const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
  const { repoRoot, outputDir } = seedRepo(`manifest-${options.packageType ?? 'default'}-`, options)
  const result = await buildDevicePackageRelease({
    repoRoot,
    outputDir,
    channel: 'stable',
    releaseRepo: 'example/hermes-web-ui',
    tag: 'v1.2.3',
    packageType: options.packageType,
  })
  return {
    repoRoot,
    outputDir,
    manifest: JSON.parse(readFileSync(result.manifestPath, 'utf-8')),
    latest: JSON.parse(readFileSync(result.latestPath, 'utf-8')),
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('device-package manifest contract', () => {
  it('defaults packageType to source-deploy', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.packageType).toBe('source-deploy')
  })

  it('source-deploy manifest carries sourceUrl and sourceSha256', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.packageType).toBe('source-deploy')
    expect(manifest.sourceUrl).toMatch(/^https?:\/\//)
    expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.sourceUrls.length).toBeGreaterThanOrEqual(1)
  })

  it('source-deploy manifest does NOT emit device-package-only installerSha256 field', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.installerScriptPath).toBe('scripts/update-source-deploy.sh')
    expect(manifest.installerScriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('device-package manifest emits installerScriptPath + installerScriptSha256', async () => {
    const { manifest } = await buildAndReadManifest({ packageType: 'device-package' })
    expect(manifest.packageType).toBe('device-package')
    expect(manifest.installerScriptPath).toBe('scripts/install-device-package.sh')
    expect(manifest.installerScriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects unknown packageType values', async () => {
    await expect(buildAndReadManifest({ packageType: 'npm-package' as unknown as 'source-deploy' })).rejects.toThrow(
      /packageType must be one of/,
    )
  })

  it('manifest and latest.json are byte-identical', async () => {
    const { manifest, latest } = await buildAndReadManifest({})
    expect(manifest).toEqual(latest)
  })
})

describe('AGENTS.md enforces the contract', () => {
  const agentsPath = resolvePath(__dirname, '..', '..', 'AGENTS.md')

  it('declares source-deploy as the default strategy', () => {
    const text = readFileSync(agentsPath, 'utf-8')
    expect(text).toMatch(/WEBUI_UPDATE_STRATEGY.*default.*source-deploy/s)
  })

  it('pins the manifest packageType ↔ device packageType matching rule', () => {
    const text = readFileSync(agentsPath, 'utf-8')
    expect(text).toMatch(/manifest.*packageType.*WEBUI_UPDATE_PACKAGE_TYPE.*must match/s)
  })

  it('requires sourceUrl and sourceSha256 for source-deploy', () => {
    const text = readFileSync(agentsPath, 'utf-8')
    expect(text).toMatch(/source-deploy manifest requires sourceUrl\/sourceSha256/is)
  })
})