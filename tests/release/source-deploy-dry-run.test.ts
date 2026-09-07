/**
 * CI dry-run smoke for the phase (a) source-deploy update path.
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Testing Strategy,
 * § Build Side). Wired into device-package-release.yml as a required check
 * before candidate publication. The orchestrator runs with WEBUI_DRY_RUN=1
 * (skips only `systemctl restart`); every other step — journal, atomic
 * swap, manifest self-check, identity stamp — really executes.
 *
 * The identity chain proven here:
 *   build computes manifest.identity.distSha256 over the staged dist
 *   → device tarball ships it
 *   → orchestrator re-derives the same value after the swap
 *   → state/identity.json must equal the manifest claim
 * (the v0.7.0-customer "wrong version after upgrade" incident class).
 */
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'
import { execFileSync } from 'child_process'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { readlinkSafe, symlinksSupported } from '../server/update-orchestrator/helpers'

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
  'scripts/update-orchestrator.sh',
  'scripts/recover-interrupted-update.sh',
  'scripts/journal-validator.sh',
]

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function seedRepo(prefix: string) {
  const repoRoot = createTempDir(prefix)
  const outputDir = createTempDir(`${prefix}-out-`)

  mkdirSync(resolvePath(repoRoot, 'dist', 'server'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'dist', 'client'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'release'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'scripts'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'packages'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'docs'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, '.github'), { recursive: true })
  writeFileSync(resolvePath(repoRoot, 'packages', 'README.md'), '# packages placeholder\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'docs', 'openapi.json'), '{ "openapi": "3.0.0" }\n', 'utf-8')

  writeFileSync(
    resolvePath(repoRoot, 'dist', 'server', 'index.js'),
    'console.log("/api/hermes/terminal"); console.log("node-pty failed to load, terminal feature disabled"); console.log("WebSocket ready at /terminal")\n',
    'utf-8',
  )
  writeFileSync(resolvePath(repoRoot, 'dist', 'client', 'index.html'), '<html></html>\n', 'utf-8')
  for (const script of [
    'deploy-source-armbian.sh',
    'hermes-web-ui-update-runner.sh',
    'install-device-package.sh',
    'update-source-deploy.sh',
    'update-orchestrator.sh',
    'recover-interrupted-update.sh',
    'journal-validator.sh',
  ]) {
    writeFileSync(resolvePath(repoRoot, 'scripts', script), '#!/usr/bin/env bash\n', 'utf-8')
    chmodSync(resolvePath(repoRoot, 'scripts', script), 0o755)
  }
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update.service'), '[Service]\nExecStart=/usr/local/sbin/hermes-web-ui-update-runner\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui.service'), '[Service]\nExecStart=node dist/server/index.js\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'config.py'), 'WEBUI_HOME = "/tmp/hermes"\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'release', 'device-host-dependencies.json'), JSON.stringify({
    schema: 1,
    aptPackages: ['python3-pyudev', 'ntfs-3g'],
  }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package-lock.json'), '{ "name": "@quanthermes/hermes-web-ui", "lockfileVersion": 3 }\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package.json'), JSON.stringify({
    name: '@quanthermes/hermes-web-ui',
    version: '1.2.3',
    repository: { type: 'git', url: 'https://github.com/example/hermes-web-ui.git' },
    engines: { node: '>=23.0.0' },
  }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.app.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.node.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'vite.config.ts'), 'export default {}\n', 'utf-8')
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
      'docs',
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.node.json',
      'vite.config.ts',
      '.github/device-package-release.json',
    ],
  }, null, 2), 'utf-8')

  return { repoRoot, outputDir }
}

function runBash(script: string, env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

afterAll(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('source-deploy dry-run (build → orchestrator → identity chain)', () => {
  // The swap semantics require real symlinks; Windows MSYS without symlink
  // privilege degrades `ln -s` to copies, so this suite runs on CI (ubuntu).
  it.skipIf(!symlinksSupported())('builds a release, swaps it with the orchestrator, and stamps matching identity', async () => {
    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
    const { repoRoot, outputDir } = seedRepo('dry-run-')
    const result = await buildDevicePackageRelease({
      repoRoot,
      outputDir,
      channel: 'stable',
      releaseRepo: 'example/hermes-web-ui',
      tag: 'v1.2.3',
      packageType: 'source-deploy',
    })
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'))

    // Build-side contract (phase a).
    expect(manifest.installerScriptPath).toBe('scripts/update-orchestrator.sh')
    expect(manifest.identity.versionString).toBe('1.2.3')
    expect(manifest.identity.distSha256).toMatch(/^[0-9a-f]{64}$/)

    // Legacy deploy tree on the device (pre-phase-a layout, version 1.0.0).
    const home = createTempDir('dry-run-device-')
    const deployDir = join(home, 'deploy')
    mkdirSync(join(deployDir, 'dist', 'server'), { recursive: true })
    writeFileSync(join(deployDir, 'package.json'), JSON.stringify({ name: '@quanthermes/hermes-web-ui', version: '1.0.0' }))
    writeFileSync(join(deployDir, 'dist', 'server', 'index.js'), 'old-tree\n')

    // Dry-run the orchestrator against the built device tarball.
    const res = runBash(resolvePath(__dirname, '..', '..', 'scripts', 'update-orchestrator.sh'), {
      HERMES_WEB_UI_HOME: home,
      DEPLOY_DIR: deployDir,
      HERMES_WEB_UI_UPDATE_VERSION: '1.2.3',
      HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: result.artifactPath,
      HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256: manifest.sha256,
      HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256: manifest.installerScriptSha256,
      HERMES_WEB_UI_UPDATE_MANIFEST_SHA256: createHash('sha256').update(readFileSync(result.manifestPath)).digest('hex'),
      WEBUI_DRY_RUN: '1',
      WEBUI_UPDATE_SKIP_HEALTHCHECK: '1',
    })
    expect(res.status, `orchestrator failed: ${res.stderr}`).toBe(0)
    expect(res.stderr).toBe('')

    // Journal ends at succeeded.
    const historyDir = join(home, 'updates', 'history')
    const journalFile = execFileSync('bash', ['-c', `ls '${historyDir}' | head -1`]).toString().trim()
    const lines = readFileSync(join(historyDir, journalFile), 'utf8').trim().split('\n')
    const stages = lines.slice(1).map((line) => JSON.parse(line).stage)
    expect(stages[stages.length - 1]).toBe('succeeded')
    expect(stages).toContain('manifest_self_check')

    // Identity chain: device-side stamp equals the build-side claim.
    const identity = JSON.parse(readFileSync(join(home, 'state', 'identity.json'), 'utf-8'))
    expect(identity.version).toBe(manifest.identity.versionString)
    expect(identity.distSha256).toBe(manifest.identity.distSha256)
    expect(identity.agentManifestSha).toBe('0.0.0-noop')

    // Installer SHA pins the orchestrator that actually shipped.
    const shippedSha = createHash('sha256').update(readFileSync(join(deployDir, 'scripts', 'update-orchestrator.sh'))).digest('hex')
    expect(shippedSha).toBe(manifest.installerScriptSha256)

    // Deploy is a symlink at the new staging tree; lastgood is the old tree.
    expect(existsSync(deployDir)).toBe(true)
    const target = readlinkSafe(deployDir)
    expect(target).toContain(join('updates', 'cache', 'staging-'))
    expect(JSON.parse(readFileSync(join(deployDir, 'package.json'), 'utf-8')).version).toBe('1.2.3')
    // lastgood lives NEXT TO the deploy link (atomic-swap.sh contract —
    // revert_to_lastgood reads dirname(deploy)/lastgood).
    const lastgood = readlinkSafe(join(home, 'lastgood'))
    expect(JSON.parse(readFileSync(join(lastgood, 'package.json'), 'utf-8')).version).toBe('1.0.0')
  })

  it('build refuses a manifest whose staged dist version mismatches (self-check)', async () => {
    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
    const { repoRoot, outputDir } = seedRepo('dry-run-mismatch-')
    // Align release config with the requested (wrong) version so the config
    // consistency check passes and the dist-identity self-check fires.
    const configPath = resolvePath(repoRoot, '.github', 'device-package-release.json')
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf-8')), version: '9.9.9' }), 'utf-8')
    await expect(buildDevicePackageRelease({
      repoRoot,
      outputDir,
      channel: 'stable',
      releaseRepo: 'example/hermes-web-ui',
      tag: 'v9.9.9',
      version: '9.9.9',
      packageType: 'source-deploy',
    })).rejects.toThrow(/manifest self-check/)
  })
})
