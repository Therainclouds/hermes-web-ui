/**
 * CI gate for systemd 203/EXEC bug.
 *
 * Historical bug: when the device-package tarball was built on a host whose
 * git checkout lacked +x on scripts (Windows with core.filemode=false is the
 * typical trigger), every script in the tarball ended up 100644. The device's
 * `tar -cf - . | tar -xf -` pipeline did not restore +x, so systemd refused
 * ExecStartPre with 203/EXEC the moment the service was restarted.
 *
 * Defense in depth:
 *   1. `tar.create({ onWriteEntry })` in build-device-package.mjs forces +x on
 *      .sh entries at tar-write time — the tarball is always correct, even on
 *      Windows where the filesystem cannot represent Unix execute bits.
 *   2. `assertArchiveScriptModes()` is a post-build assertion that scans the
 *      finished tarball and throws if any script still lacks +x.
 *
 * This test verifies both layers:
 *   - The build always produces a tarball with +x scripts (integration).
 *   - `assertArchiveScriptModes` correctly rejects a hand-crafted tarball
 *     with 0644 scripts (unit test of the assertion itself).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { create as createTar } from 'tar'

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
}

function seedRepo(prefix: string, _options: FixtureOptions = {}) {
  const repoRoot = createTempDir(prefix)
  const outputDir = createTempDir(`${prefix}-out-`)

  mkdirSync(resolvePath(repoRoot, 'dist', 'server'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'dist', 'client'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'release'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'scripts'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'packages'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, '.github'), { recursive: true })

  writeFileSync(
    resolvePath(repoRoot, 'dist', 'server', 'index.js'),
    'console.log("/api/hermes/terminal"); console.log("node-pty failed to load, terminal feature disabled"); console.log("WebSocket ready at /terminal")\n',
    'utf-8',
  )
  writeFileSync(resolvePath(repoRoot, 'dist', 'client', 'index.html'), '<html></html>\n', 'utf-8')

  // Scripts are written WITHOUT chmod — on Windows they stay 0666 on disk.
  // The build's `onWriteEntry` callback must promote them to 0755 in the tar.
  const scripts = [
    'deploy-source-armbian.sh',
    'hermes-web-ui-update-runner.sh',
    'install-device-package.sh',
    'update-source-deploy.sh',
  ]
  for (const name of scripts) {
    writeFileSync(resolvePath(repoRoot, 'scripts', name), '#!/usr/bin/env bash\necho hi\n', 'utf-8')
  }
  writeFileSync(
    resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update.service'),
    '[Service]\nExecStart=/usr/local/sbin/hermes-web-ui-update-runner\n',
    'utf-8',
  )
  writeFileSync(
    resolvePath(repoRoot, 'scripts', 'hermes-web-ui.service'),
    '[Service]\nExecStart=node dist/server/index.js\n',
    'utf-8',
  )

  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'config.py'), 'WEBUI_HOME = "/tmp"\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'usb_monitor.py'), 'print("usb")\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'release', 'device-host-dependencies.json'), JSON.stringify({ schema: 1, aptPackages: ['python3-pyudev'] }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package-lock.json'), '{ "name": "@quanthermes/hermes-web-ui", "lockfileVersion": 3 }\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package.json'), JSON.stringify({
    name: '@quanthermes/hermes-web-ui',
    version: '1.2.3',
    repository: { type: 'git', url: 'https://github.com/example/hermes-web-ui.git' },
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
    sourcePathAllowlist: ['package.json', 'packages', 'scripts', 'tsconfig.json', '.github/device-package-release.json'],
  }, null, 2), 'utf-8')

  return { repoRoot, outputDir }
}

async function tryBuild(options: FixtureOptions) {
  const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
  const { repoRoot, outputDir } = seedRepo(`exec-bits-${options.packageType ?? 'default'}-`, options)
  return buildDevicePackageRelease({
    repoRoot,
    outputDir,
    channel: 'stable',
    releaseRepo: 'example/hermes-web-ui',
    tag: 'v1.2.3',
    packageType: options.packageType,
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('device-package script executable-bit contract', () => {
  it('build produces +x scripts in device-package tarball even when filesystem lacks +x', async () => {
    // Scripts are written without chmod on purpose — on Windows they have no +x.
    // The build's onWriteEntry callback must promote them to 0755 in the archive.
    const result = await tryBuild({ packageType: 'device-package' })
    expect(result.artifactPath).toMatch(/\.tar\.gz$/)
  })

  it('build produces +x scripts in source-deploy tarball even when filesystem lacks +x', async () => {
    const result = await tryBuild({ packageType: 'source-deploy' })
    expect(result.artifactPath).toMatch(/\.tar\.gz$/)
  })

  it('assertArchiveScriptModes rejects a tarball with 0644 scripts', async () => {
    // Build a tarball with broken modes directly (simulating a pre-fix build).
    const { assertArchiveScriptModes } = await import('../../scripts/build-device-package.mjs')
    const scratchDir = createTempDir('broken-tar-')
    const brokenTar = resolvePath(scratchDir, 'broken.tar.gz')
    writeFileSync(resolvePath(scratchDir, 'script.sh'), '#!/bin/bash\necho hi\n', 'utf-8')
    await createTar({
      cwd: scratchDir,
      file: brokenTar,
      gzip: true,
      // Explicitly keep the filesystem mode (0666 on Windows, 0644 after umask)
      // — no onWriteEntry to fix it. This simulates the pre-fix bug.
    }, ['./script.sh'])

    await expect(assertArchiveScriptModes(brokenTar)).rejects.toThrow(/non-executable scripts/)
  })

  it('error message points at the git fix command', async () => {
    const { assertArchiveScriptModes } = await import('../../scripts/build-device-package.mjs')
    const scratchDir = createTempDir('broken-tar-')
    const brokenTar = resolvePath(scratchDir, 'broken.tar.gz')
    writeFileSync(resolvePath(scratchDir, 'script.sh'), '#!/bin/bash\n', 'utf-8')
    await createTar({ cwd: scratchDir, file: brokenTar, gzip: true }, ['./script.sh'])

    await expect(assertArchiveScriptModes(brokenTar)).rejects.toThrow(/git update-index --chmod=\+x/)
  })
})
