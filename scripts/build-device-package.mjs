import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createTar, list as listTar } from 'tar'

const DEFAULT_SOURCE_LABEL = 'Quanthermes Device Releases'
const DEFAULT_HEALTHCHECK_URL = 'http://127.0.0.1:6060/health'
const DEFAULT_MANIFEST_BRANCH = 'release-manifests'
const DEFAULT_RELEASE_CONFIG_PATH = '.github/device-package-release.json'
const DEFAULT_UPDATE_CHANNEL = 'stable'
const DEVICE_PACKAGE_ARTIFACT_FORMAT = 'tar.gz'
const CHANNEL_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

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

function normalizeChannelSegment(channel) {
  const normalized = (channel || DEFAULT_UPDATE_CHANNEL).trim() || DEFAULT_UPDATE_CHANNEL
  if (!CHANNEL_SEGMENT_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid update channel "${channel}". Use only letters, numbers, dot, underscore, and dash.`,
    )
  }
  return normalized
}

function parseCompatibleNodeRange(packageJson) {
  const range = typeof packageJson?.engines?.node === 'string' ? packageJson.engines.node : ''
  const normalized = range.trim()
  if (!normalized) {
    throw new Error('Unable to derive compatibleNodeRange from package.json engines.node.')
  }
  return normalized
}

function buildLegacyMajorRange(major) {
  return `>=${major}.0.0 <${major + 1}.0.0`
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

function normalizeOptionalUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

function dedupeNonEmpty(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function buildOssObjectUrl(baseUrl, ...segments) {
  const normalizedBaseUrl = normalizeOptionalUrl(baseUrl)
  if (!normalizedBaseUrl) return ''
  const normalizedSegments = segments
    .map(segment => String(segment || '').trim().replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map(encodeURIComponent)
  return [normalizedBaseUrl, ...normalizedSegments].join('/')
}

function buildOssObjectPath(ossPath, ...segments) {
  const normalizedOssPath = normalizeOptionalUrl(ossPath)
  if (!normalizedOssPath) return ''
  const normalizedSegments = segments
    .map(segment => String(segment || '').trim().replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
  return [normalizedOssPath, ...normalizedSegments].join('/')
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

function normalizeRelativePackageEntry(entry) {
  const normalized = typeof entry === 'string'
    ? entry.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
    : ''

  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('/')
    || normalized.startsWith('../')
    || normalized.includes('/../')
  ) {
    throw new Error(`Invalid packageAllowlist entry "${entry}". Use repository-relative paths only.`)
  }

  return normalized
}

function resolvePackageAllowlist(packageAllowlist, releaseConfigPath) {
  if (!Array.isArray(packageAllowlist) || packageAllowlist.length === 0) {
    throw new Error(
      `packageAllowlist is required. Set it in ${releaseConfigPath} and include the exact files or directories to bundle.`,
    )
  }

  return [...new Set(packageAllowlist.map(normalizeRelativePackageEntry))]
}

function loadHostDependencies(repoRoot, hostDependenciesPath, releaseConfigPath) {
  const normalizedPath = typeof hostDependenciesPath === 'string'
    ? normalizeRelativePackageEntry(hostDependenciesPath)
    : ''
  if (!normalizedPath) {
    throw new Error(
      `hostDependenciesPath is required. Set it in ${releaseConfigPath} and point it at the managed host dependency manifest.`,
    )
  }

  const manifestPath = resolve(repoRoot, normalizedPath)
  ensureFile(manifestPath, 'Host dependency manifest')

  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Host dependency manifest must be a JSON object: ${normalizedPath}`)
  }

  const schema = Number.parseInt(String(parsed.schema ?? ''), 10)
  if (schema !== 1) {
    throw new Error(`Host dependency manifest schema must be 1: ${normalizedPath}`)
  }

  const aptPackages = dedupeNonEmpty(Array.isArray(parsed.aptPackages) ? parsed.aptPackages : [])
  if (aptPackages.length === 0) {
    throw new Error(`Host dependency manifest aptPackages must contain at least one package: ${normalizedPath}`)
  }

  return {
    relativePath: normalizedPath,
    manifest: {
      schema,
      aptPackages,
    },
  }
}

function buildPackageEntries(repoRoot, packageAllowlist) {
  return packageAllowlist.map((entryPath) => {
    const sourcePath = resolve(repoRoot, entryPath)
    const repoRelative = relative(repoRoot, sourcePath).replace(/\\/g, '/')
    if (
      !repoRelative
      || repoRelative === '..'
      || repoRelative.startsWith('../')
    ) {
      throw new Error(`packageAllowlist entry escapes the repository root: ${entryPath}`)
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`packageAllowlist entry is missing from the repository: ${entryPath}`)
    }

    return {
      path: entryPath,
      sourcePath,
      isDirectory: statSync(sourcePath).isDirectory(),
    }
  })
}

function copyPackageEntries(stageRoot, packageEntries) {
  for (const entry of packageEntries) {
    const targetPath = resolve(stageRoot, entry.path)
    mkdirSync(dirname(targetPath), { recursive: true })
    cpSync(entry.sourcePath, targetPath, { recursive: true })
  }
}

function normalizeArchiveEntry(entryPath) {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function matchesPackageEntry(archiveEntry, packageEntry) {
  if (archiveEntry === packageEntry.path) return true
  return packageEntry.isDirectory && archiveEntry.startsWith(`${packageEntry.path}/`)
}

function isAllowlistedAncestorEntry(archiveEntry, packageEntries) {
  return packageEntries.some(packageEntry => packageEntry.path.startsWith(`${archiveEntry}/`))
}

async function assertArchiveMatchesAllowlist(archivePath, packageEntries) {
  const entries = new Set()
  await listTar({
    file: archivePath,
    onentry: (entry) => {
      const normalized = normalizeArchiveEntry(entry.path)
      if (!normalized) return
      entries.add(normalized)
    },
  })

  for (const packageEntry of packageEntries) {
    const hasMatch = [...entries].some(entry => matchesPackageEntry(entry, packageEntry))
    if (!hasMatch) {
      throw new Error(`Device package archive is missing allowlisted entry: ${packageEntry.path}`)
    }
  }

  for (const entry of entries) {
    const allowed = packageEntries.some(packageEntry => matchesPackageEntry(entry, packageEntry))
      || isAllowlistedAncestorEntry(entry, packageEntries)
    if (!allowed) {
      throw new Error(`Device package archive contains a non-allowlisted entry: ${entry}`)
    }
  }
}

/**
 * Build a release-ready device package from the repository's allowlisted runtime assets.
 *
 * Why: the device installer must consume a minimal, deterministic bundle that excludes
 * unrelated source files and release tooling by default.
 * How: read the release contract, copy only allowlisted paths into a staging tree, tar
 * that tree, then verify the resulting archive still matches the allowlist exactly.
 * What: returns release metadata for the artifact, manifest, and latest channel pointer.
 */
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
  const channel = normalizeChannelSegment(options.channel || releaseConfig.channel || DEFAULT_UPDATE_CHANNEL)
  const releaseRepo = (options.releaseRepo || parseGitHubRepo(packageJson)).trim()
  const sourceLabel = (options.sourceLabel || releaseConfig.sourceLabel || DEFAULT_SOURCE_LABEL).trim() || DEFAULT_SOURCE_LABEL
  const healthcheckUrl = (options.healthcheckUrl || releaseConfig.healthcheckUrl || DEFAULT_HEALTHCHECK_URL).trim() || DEFAULT_HEALTHCHECK_URL
  const minCurrentVersion = (options.minCurrentVersion || releaseConfig.minCurrentVersion || '').trim()
  if (!minCurrentVersion) {
    throw new Error(
      `minCurrentVersion is required. Set it in ${releaseConfigPath} or pass --min-current-version explicitly.`,
    )
  }
  const hostDependencies = loadHostDependencies(
    repoRoot,
    options.hostDependenciesPath || releaseConfig.hostDependenciesPath,
    releaseConfigPath,
  )
  const packageAllowlist = resolvePackageAllowlist(
    options.packageAllowlist ?? releaseConfig.packageAllowlist,
    releaseConfigPath,
  )
  if (!packageAllowlist.includes(hostDependencies.relativePath)) {
    throw new Error(
      `packageAllowlist must include hostDependenciesPath (${hostDependencies.relativePath}) so runtime updates can reconcile host dependencies.`,
    )
  }
  const packageEntries = buildPackageEntries(repoRoot, packageAllowlist)
  const ossPath = normalizeOptionalUrl(options.ossPath || releaseConfig.ossPath)
  const ossPublicBaseUrl = normalizeOptionalUrl(options.ossPublicBaseUrl || releaseConfig.ossPublicBaseUrl)
  const manifestBranch = (options.manifestBranch || releaseConfig.manifestBranch || DEFAULT_MANIFEST_BRANCH).trim() || DEFAULT_MANIFEST_BRANCH
  const compatibleNodeRange = (
    options.compatibleNodeRange
    || releaseConfig.compatibleNodeRange
    || (Number.isInteger(releaseConfig.compatibleNodeMajor)
      ? buildLegacyMajorRange(releaseConfig.compatibleNodeMajor)
      : '')
    || parseCompatibleNodeRange(packageJson)
  ).trim()

  const releaseDir = resolve(outputDir, 'releases', tag)
  const latestDir = resolve(outputDir, 'releases', channel)
  const stageRoot = mkdtempSync(resolve(tmpdir(), 'hermes-web-ui-device-package-'))
  const artifactName = `hermes-web-ui-device-${tag}.tar.gz`
  const artifactPath = resolve(releaseDir, artifactName)
  const shaPath = `${artifactPath}.sha256`
  const manifestPath = resolve(releaseDir, 'manifest.json')
  const latestPath = resolve(latestDir, 'latest.json')
  const metadataPath = resolve(outputDir, 'release-metadata.json')

  try {
    createCleanDir(outputDir)
    mkdirSync(releaseDir, { recursive: true })
    mkdirSync(latestDir, { recursive: true })

    copyPackageEntries(stageRoot, packageEntries)

    await createTar({
      cwd: stageRoot,
      file: artifactPath,
      gzip: true,
      portable: true,
      noMtime: true,
    }, ['.'])

    await assertArchiveMatchesAllowlist(artifactPath, packageEntries)

    const sha256 = computeSha256(artifactPath)
    const size = statSync(artifactPath).size
    const releasedAt = new Date().toISOString()
    const ossPackageUrl = buildOssObjectUrl(ossPublicBaseUrl, 'releases', tag, artifactName)
    const githubPackageUrl = buildReleaseAssetUrl(releaseRepo, tag, artifactName)
    const packageUrls = dedupeNonEmpty(ossPackageUrl ? [ossPackageUrl] : [githubPackageUrl])
    const packageUrl = packageUrls[0] || githubPackageUrl
    const ossManifestUrl = buildOssObjectUrl(ossPublicBaseUrl, 'releases', tag, 'manifest.json')
    const ossLatestUrl = buildOssObjectUrl(ossPublicBaseUrl, 'releases', channel, 'latest.json')
    const ossShaUrl = buildOssObjectUrl(ossPublicBaseUrl, 'releases', tag, `${artifactName}.sha256`)
    const manifest = {
      version,
      channel,
      sourceLabel,
      packageType: 'device-package',
      artifactFormat: DEVICE_PACKAGE_ARTIFACT_FORMAT,
      packageUrl,
      packageUrls,
      sha256,
      releasedAt,
      compatibleNodeRange,
      minCurrentVersion,
      notesUrl: buildReleaseNotesUrl(releaseRepo, tag),
      size,
      healthcheckUrl,
      hostDependenciesPath: hostDependencies.relativePath,
      hostDependencies: hostDependencies.manifest,
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
      packageAllowlist: packageEntries.map(entry => entry.path),
      hostDependenciesPath: hostDependencies.relativePath,
      hostDependencies: hostDependencies.manifest,
      artifactName,
      artifactPath,
      shaPath,
      manifestPath,
      latestPath,
      ossPath,
      ossPublicBaseUrl,
      ossArtifactPath: buildOssObjectPath(ossPath, 'releases', tag, artifactName),
      ossShaPath: buildOssObjectPath(ossPath, 'releases', tag, `${artifactName}.sha256`),
      ossManifestPath: buildOssObjectPath(ossPath, 'releases', tag, 'manifest.json'),
      ossLatestPath: buildOssObjectPath(ossPath, 'releases', channel, 'latest.json'),
      ossArtifactUrl: ossPackageUrl,
      ossShaUrl,
      ossManifestUrl,
      ossLatestUrl,
      manifestBaseUrl: `https://raw.githubusercontent.com/${releaseRepo}/${manifestBranch}/releases`,
      latestUrl: `https://raw.githubusercontent.com/${releaseRepo}/${manifestBranch}/releases/${channel}/latest.json`,
    }, null, 2)}\n`, 'utf-8')

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
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
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
    compatibleNodeRange: args['compatible-node-range'],
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
