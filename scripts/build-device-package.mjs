import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createTar, list as listTar } from 'tar'

const DEFAULT_SOURCE_LABEL = 'Quanthermes Device Releases'
const DEFAULT_HEALTHCHECK_URL = 'http://127.0.0.1:6060/health'
const DEFAULT_MANIFEST_BRANCH = 'release-manifests'
const DEFAULT_RELEASE_CONFIG_PATH = '.github/device-package-release.json'
const REQUIRED_PACKAGE_ENTRIES = [
  'dist/',
  'package.json',
  'package-lock.json',
  'scripts/deploy-source-armbian.sh',
  'scripts/install-device-package.sh',
]

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`)
    }
    const key = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    parsed[key] = value
    index += 1
  }
  return parsed
}

function ensureFile(filePath, description) {
  if (!existsSync(filePath)) {
    throw new Error(`${description} is missing: ${filePath}`)
  }
}

function loadReleaseConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return {}
  const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Release config must be a JSON object: ${configPath}`)
  }
  return parsed
}

function sanitizeTag(tag, version) {
  const normalized = (tag || '').trim()
  if (!normalized) return `v${version}`
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

function parseGitHubRepo(packageJson) {
  const fromEnv = (process.env.GITHUB_REPOSITORY || '').trim()
  if (fromEnv) return fromEnv

  const repository = packageJson.repository
  const url = typeof repository === 'string'
    ? repository
    : typeof repository?.url === 'string'
      ? repository.url
      : ''

  const match = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i.exec(url.trim())
  if (!match) {
    throw new Error('Unable to resolve GitHub repository slug from package.json or GITHUB_REPOSITORY.')
  }
  return match[1]
}

function parseCompatibleNodeMajor(packageJson) {
  const range = typeof packageJson?.engines?.node === 'string' ? packageJson.engines.node : ''
  const match = /(\d{1,3})/.exec(range)
  if (!match) {
    throw new Error('Unable to derive compatibleNodeMajor from package.json engines.node.')
  }
  return Number.parseInt(match[1], 10)
}

function computeSha256(filePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

function buildReleaseAssetUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

function buildReleaseNotesUrl(repo, tag) {
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`
}

function normalizeVersion(version) {
  const normalized = (version || '').trim()
  if (!normalized) {
    throw new Error('package.json version is required to build a device package.')
  }
  return normalized
}

function createCleanDir(dirPath) {
  rmSync(dirPath, { recursive: true, force: true })
  mkdirSync(dirPath, { recursive: true })
}

function copyBundleFiles(repoRoot, stageRoot) {
  const filesToCopy = [
    'bin',
    'dist',
    'scripts',
    'package.json',
    'package-lock.json',
  ]

  for (const relativePath of filesToCopy) {
    const sourcePath = resolve(repoRoot, relativePath)
    if (!existsSync(sourcePath)) continue
    const targetPath = resolve(stageRoot, relativePath)
    cpSync(sourcePath, targetPath, { recursive: true })
  }
}

async function assertArchiveStructure(archivePath) {
  const entries = new Set()
  await listTar({
    file: archivePath,
    onentry: (entry) => {
      const normalized = entry.path.replace(/\\/g, '/').replace(/^\.\//, '')
      if (!normalized) return
      if (normalized.endsWith('/')) entries.add(normalized)
      else entries.add(normalized)
    },
  })

  for (const requiredEntry of REQUIRED_PACKAGE_ENTRIES) {
    const normalized = requiredEntry.replace(/\\/g, '/')
    if (entries.has(normalized)) continue
    if (normalized.endsWith('/') && [...entries].some(entry => entry.startsWith(normalized))) continue
    throw new Error(`Device package archive is missing required entry: ${requiredEntry}`)
  }
}

export async function buildDevicePackageRelease(options = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(options.repoRoot || resolve(scriptDir, '..'))
  const outputDir = resolve(options.outputDir || resolve(repoRoot, 'dist', 'device-package-release'))
  const packageJsonPath = resolve(repoRoot, 'package.json')
  ensureFile(packageJsonPath, 'package.json')
  const releaseConfigPath = resolve(repoRoot, options.releaseConfigPath || DEFAULT_RELEASE_CONFIG_PATH)
  const releaseConfig = loadReleaseConfig(releaseConfigPath)

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
  const version = normalizeVersion(options.version || packageJson.version)
  const configuredVersion = typeof releaseConfig.version === 'string' ? normalizeVersion(releaseConfig.version) : ''
  if (configuredVersion && configuredVersion !== version) {
    throw new Error(
      `Release config version ${configuredVersion} does not match package.json version ${version}. Update ${releaseConfigPath} before publishing.`,
    )
  }
  const tag = sanitizeTag(options.tag, version)
  const channel = (options.channel || releaseConfig.channel || 'stable').trim() || 'stable'
  const releaseRepo = (options.releaseRepo || parseGitHubRepo(packageJson)).trim()
  const sourceLabel = (options.sourceLabel || releaseConfig.sourceLabel || DEFAULT_SOURCE_LABEL).trim() || DEFAULT_SOURCE_LABEL
  const healthcheckUrl = (options.healthcheckUrl || releaseConfig.healthcheckUrl || DEFAULT_HEALTHCHECK_URL).trim() || DEFAULT_HEALTHCHECK_URL
  const minCurrentVersion = (options.minCurrentVersion || releaseConfig.minCurrentVersion || '').trim()
  if (!minCurrentVersion) {
    throw new Error(
      `minCurrentVersion is required. Set it in ${releaseConfigPath} or pass --min-current-version explicitly.`,
    )
  }
  const manifestBranch = (options.manifestBranch || releaseConfig.manifestBranch || DEFAULT_MANIFEST_BRANCH).trim() || DEFAULT_MANIFEST_BRANCH
  const compatibleNodeMajor = Number.isInteger(options.compatibleNodeMajor)
    ? options.compatibleNodeMajor
    : Number.isInteger(releaseConfig.compatibleNodeMajor)
      ? releaseConfig.compatibleNodeMajor
      : parseCompatibleNodeMajor(packageJson)

  const releaseDir = resolve(outputDir, 'releases', tag)
  const latestDir = resolve(outputDir, 'releases', channel)
  const stageRoot = resolve(outputDir, '.stage')
  const artifactName = `hermes-web-ui-device-${tag}.tar.gz`
  const artifactPath = resolve(releaseDir, artifactName)
  const shaPath = `${artifactPath}.sha256`
  const manifestPath = resolve(releaseDir, 'manifest.json')
  const latestPath = resolve(latestDir, 'latest.json')
  const metadataPath = resolve(outputDir, 'release-metadata.json')

  createCleanDir(outputDir)
  mkdirSync(releaseDir, { recursive: true })
  mkdirSync(latestDir, { recursive: true })
  mkdirSync(stageRoot, { recursive: true })

  copyBundleFiles(repoRoot, stageRoot)

  await createTar({
    cwd: stageRoot,
    file: artifactPath,
    gzip: true,
    portable: true,
    noMtime: true,
  }, ['.'])

  await assertArchiveStructure(artifactPath)

  const sha256 = computeSha256(artifactPath)
  const size = statSync(artifactPath).size
  const releasedAt = new Date().toISOString()
  const manifest = {
    version,
    channel,
    sourceLabel,
    packageType: 'device-package',
    artifactFormat: 'tar.gz',
    packageUrl: buildReleaseAssetUrl(releaseRepo, tag, artifactName),
    sha256,
    releasedAt,
    compatibleNodeMajor,
    minCurrentVersion,
    notesUrl: buildReleaseNotesUrl(releaseRepo, tag),
    size,
    healthcheckUrl,
  }

  writeFileSync(shaPath, `${sha256}  ${basename(artifactPath)}\n`, 'utf-8')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  writeFileSync(metadataPath, `${JSON.stringify({
    version,
    tag,
    channel,
    releaseRepo,
    manifestBranch,
    artifactName,
    artifactPath,
    shaPath,
    manifestPath,
    latestPath,
    manifestBaseUrl: `https://raw.githubusercontent.com/${releaseRepo}/${manifestBranch}/releases`,
    latestUrl: `https://raw.githubusercontent.com/${releaseRepo}/${manifestBranch}/releases/${encodeURIComponent(channel)}/latest.json`,
  }, null, 2)}\n`, 'utf-8')

  rmSync(stageRoot, { recursive: true, force: true })

  return {
    version,
    tag,
    channel,
    releaseRepo,
    manifestBranch,
    artifactName,
    artifactPath,
    shaPath,
    manifestPath,
    latestPath,
    metadataPath,
    manifest,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await buildDevicePackageRelease({
    repoRoot: args['repo-root'],
    outputDir: args['out-dir'],
    version: args.version,
    tag: args.tag,
    channel: args.channel,
    releaseRepo: args['release-repo'],
    releaseConfigPath: args['release-config'],
    sourceLabel: args['source-label'],
    healthcheckUrl: args['healthcheck-url'],
    minCurrentVersion: args['min-current-version'],
    manifestBranch: args['manifest-branch'],
    compatibleNodeMajor: args['compatible-node-major']
      ? Number.parseInt(args['compatible-node-major'], 10)
      : undefined,
  })

  process.stdout.write(`${JSON.stringify({
    artifactPath: result.artifactPath,
    manifestPath: result.manifestPath,
    latestPath: result.latestPath,
    metadataPath: result.metadataPath,
  }, null, 2)}\n`)
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
