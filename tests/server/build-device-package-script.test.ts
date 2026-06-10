import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { list as listTar } from 'tar'

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function listArchiveEntries(filePath: string): Promise<string[]> {
  const entries: string[] = []
  await listTar({
    file: filePath,
    onentry: (entry) => {
      entries.push(entry.path.replace(/\\/g, '/').replace(/^\.\//, ''))
    },
  })
  return entries
}

describe('build-device-package script', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('builds a device package archive, manifest, sha256 file, and latest.json', async () => {
    const repoRoot = createTempDir('device-package-repo-')
    const outputDir = createTempDir('device-package-out-')

    mkdirSync(resolve(repoRoot, 'dist', 'server'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'dist', 'client'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'scripts'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'bin'), { recursive: true })

    writeFileSync(resolve(repoRoot, 'dist', 'server', 'index.js'), 'console.log("server")\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'dist', 'client', 'index.html'), '<html></html>\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'scripts', 'deploy-source-armbian.sh'), '#!/usr/bin/env bash\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'scripts', 'install-device-package.sh'), '#!/usr/bin/env bash\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'bin', 'hermes-web-ui.mjs'), 'console.log("cli")\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'package-lock.json'), '{ "name": "@quanthermes/hermes-web-ui", "lockfileVersion": 3 }\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({
      name: '@quanthermes/hermes-web-ui',
      version: '1.2.3',
      repository: {
        type: 'git',
        url: 'https://github.com/example/hermes-web-ui.git',
      },
      engines: {
        node: '>=23.0.0',
      },
    }, null, 2), 'utf-8')
    mkdirSync(resolve(repoRoot, '.github'), { recursive: true })
    writeFileSync(resolve(repoRoot, '.github', 'device-package-release.json'), JSON.stringify({
      version: '1.2.3',
      channel: 'stable',
      minCurrentVersion: '1.0.0',
      manifestBranch: 'release-manifests',
    }, null, 2), 'utf-8')

    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
    const result = await buildDevicePackageRelease({
      repoRoot,
      outputDir,
      channel: 'stable',
      releaseRepo: 'example/hermes-web-ui',
      tag: 'v1.2.3',
    })

    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'))
    const latest = JSON.parse(readFileSync(result.latestPath, 'utf-8'))
    const metadata = JSON.parse(readFileSync(result.metadataPath, 'utf-8'))
    const shaText = readFileSync(result.shaPath, 'utf-8')
    const entries = await listArchiveEntries(result.artifactPath)

    expect(manifest).toEqual(latest)
    expect(manifest.packageUrl).toBe(
      'https://github.com/example/hermes-web-ui/releases/download/v1.2.3/hermes-web-ui-device-v1.2.3.tar.gz',
    )
    expect(manifest.compatibleNodeMajor).toBe(23)
    expect(manifest.minCurrentVersion).toBe('1.0.0')
    expect(metadata.latestUrl).toBe(
      'https://raw.githubusercontent.com/example/hermes-web-ui/release-manifests/releases/stable/latest.json',
    )
    expect(shaText).toContain('hermes-web-ui-device-v1.2.3.tar.gz')
    expect(entries).toEqual(expect.arrayContaining([
      'dist/server/index.js',
      'dist/client/index.html',
      'package.json',
      'package-lock.json',
      'scripts/deploy-source-armbian.sh',
      'scripts/install-device-package.sh',
    ]))
  })

  it('fails when minCurrentVersion is not provided by config or CLI', async () => {
    const repoRoot = createTempDir('device-package-repo-missing-floor-')
    const outputDir = createTempDir('device-package-out-missing-floor-')

    mkdirSync(resolve(repoRoot, 'dist', 'server'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'scripts'), { recursive: true })
    mkdirSync(resolve(repoRoot, '.github'), { recursive: true })

    writeFileSync(resolve(repoRoot, 'dist', 'server', 'index.js'), 'console.log("server")\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'scripts', 'deploy-source-armbian.sh'), '#!/usr/bin/env bash\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'scripts', 'install-device-package.sh'), '#!/usr/bin/env bash\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'package-lock.json'), '{ "name": "@quanthermes/hermes-web-ui", "lockfileVersion": 3 }\n', 'utf-8')
    writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({
      name: '@quanthermes/hermes-web-ui',
      version: '1.2.3',
      repository: {
        type: 'git',
        url: 'https://github.com/example/hermes-web-ui.git',
      },
      engines: {
        node: '>=23.0.0',
      },
    }, null, 2), 'utf-8')
    writeFileSync(resolve(repoRoot, '.github', 'device-package-release.json'), JSON.stringify({
      version: '1.2.3',
      channel: 'stable',
    }, null, 2), 'utf-8')

    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')

    await expect(buildDevicePackageRelease({
      repoRoot,
      outputDir,
      releaseRepo: 'example/hermes-web-ui',
      tag: 'v1.2.3',
    })).rejects.toThrow(/minCurrentVersion is required/)
  })
})
