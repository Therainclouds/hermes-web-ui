import { config } from '../../config'
import {
  DEFAULT_UPDATE_CHANNEL,
  DEVICE_PACKAGE_ARTIFACT_FORMAT,
  normalizeChannelSegment,
  normalizeNodeVersionRange,
} from './device-package-contract'
import { UpdateError } from './errors'
import { describeUpdateNetworkError, fetchUpdateJson } from './network-client'
import { parseSemver } from './version-compare'
import type {
  DevicePackageManifest,
  ManifestUpdateInfo,
  SourcePackageManifest,
  UpdateCheckResult,
  UpdateConfig,
  UpdatePackageType,
} from './types'

interface RawManifestPayload {
  version?: unknown
  channel?: unknown
  sourceLabel?: unknown
  packageType?: unknown
  artifactFormat?: unknown
  packageUrl?: unknown
  packageUrls?: unknown
  sha256?: unknown
  releasedAt?: unknown
  compatibleNodeMajor?: unknown
  compatibleNodeRange?: unknown
  minCurrentVersion?: unknown
  notesUrl?: unknown
  size?: unknown
  healthcheckUrl?: unknown
  sourceUrl?: unknown
  sourceUrls?: unknown
  sourceSha256?: unknown
  sourceRepoUrl?: unknown
  sourceSize?: unknown
}

function toPackageType(value: unknown, fallback: UpdatePackageType): UpdatePackageType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'npm-package') return 'npm-package'
  if (normalized === 'source-deploy') return 'source-deploy'
  if (normalized === 'device-package') return 'device-package'
  return fallback
}

export function buildManifestUrl(baseUrl: string, channel: string): string {
  const normalizedBaseUrl = (baseUrl || '').trim().replace(/\/+$/, '')
  const normalizedChannel = normalizeChannelSegment(channel || DEFAULT_UPDATE_CHANNEL)
  return `${normalizedBaseUrl}/${normalizedChannel}/latest.json`
}

export function resolveConfiguredManifestUrl(update: UpdateConfig = config.update): string {
  if (update.manifestUrl) return update.manifestUrl
  if (update.manifestBaseUrl) return buildManifestUrl(update.manifestBaseUrl, update.channel)
  return ''
}

export function resolveConfiguredManifestUrls(update: UpdateConfig = config.update): string[] {
  const configured = new Set<string>()
  for (const manifestUrl of update.manifestUrls || []) {
    const normalized = (manifestUrl || '').trim()
    if (normalized) configured.add(normalized)
  }
  if (update.manifestUrl) configured.add(update.manifestUrl)
  if (update.manifestBaseUrl) configured.add(buildManifestUrl(update.manifestBaseUrl, update.channel))
  return [...configured]
}

async function fetchRawManifest(update: UpdateConfig = config.update): Promise<{ manifestUrl: string; payload: RawManifestPayload }> {
  const manifestUrls = resolveConfiguredManifestUrls(update)
  if (manifestUrls.length === 0) {
    throw new UpdateError('update_execution_misconfigured', 'Manifest update source is not configured')
  }

  const failures: Array<Record<string, unknown>> = []
  for (const manifestUrl of manifestUrls) {
    let response: Awaited<ReturnType<typeof fetchUpdateJson>>
    try {
      response = await fetchUpdateJson(manifestUrl, {
        timeoutMs: update.manifestTimeoutMs,
        retries: update.downloadRetries,
        retryDelayMs: update.downloadRetryDelayMs,
      })
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new UpdateError('update_manifest_invalid', `Manifest response is not valid JSON: ${manifestUrl}`)
      }
      failures.push({
        manifestUrl,
        ...describeUpdateNetworkError(err),
      })
      continue
    }

    if (!response.ok) {
      failures.push({
        manifestUrl,
        status: response.status,
        transport: response.transport,
        attempts: response.attempts,
      })
      continue
    }

    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
      throw new UpdateError('update_manifest_invalid', `Manifest response is not a JSON object: ${manifestUrl}`)
    }

    const payload = response.data as RawManifestPayload
    return { manifestUrl, payload }
  }

  throw new UpdateError(
    'update_manifest_fetch_failed',
    `Failed to fetch update manifest from ${manifestUrls[0]}.`,
    502,
    {
      manifestUrls,
      failures,
    },
  )
}

function normalizeBaseManifestInfo(
  payload: RawManifestPayload,
  manifestUrl: string,
  update: UpdateConfig,
): ManifestUpdateInfo {
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (!version) {
    throw new UpdateError('update_manifest_invalid', `Manifest is missing a valid version field: ${manifestUrl}`)
  }
  if (!parseSemver(version)) {
    throw new UpdateError('update_manifest_invalid', `Manifest version is not a valid semver: ${version}`)
  }

  const channel = typeof payload.channel === 'string' && payload.channel.trim()
    ? normalizeChannelSegment(payload.channel.trim())
    : normalizeChannelSegment(update.channel)
  const sourceLabel = typeof payload.sourceLabel === 'string' && payload.sourceLabel.trim()
    ? payload.sourceLabel.trim()
    : update.sourceLabel

  return {
    version,
    channel,
    sourceLabel,
    packageType: toPackageType(payload.packageType, update.packageType),
    manifestUrl,
  }
}

function requireStringField(value: unknown, fieldName: string, manifestUrl: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new UpdateError('update_manifest_invalid', `Manifest field "${fieldName}" is required: ${manifestUrl}`)
  }
  return normalized
}

function normalizeUrlListField(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(entry => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean))]
}

function requirePositiveInteger(value: unknown, fieldName: string, manifestUrl: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UpdateError('update_manifest_invalid', `Manifest field "${fieldName}" must be a positive integer: ${manifestUrl}`)
  }
  return parsed
}

export async function fetchManifestUpdateInfo(update: UpdateConfig = config.update): Promise<ManifestUpdateInfo> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  return normalizeBaseManifestInfo(payload, manifestUrl, update)
}

export async function fetchDevicePackageManifest(update: UpdateConfig = config.update): Promise<DevicePackageManifest> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  const info = normalizeBaseManifestInfo(payload, manifestUrl, update)
  if (info.packageType !== 'device-package') {
    throw new UpdateError('update_manifest_invalid', `Manifest packageType must be "device-package": ${manifestUrl}`)
  }

  const artifactFormat = requireStringField(payload.artifactFormat, 'artifactFormat', manifestUrl)
  if (artifactFormat !== DEVICE_PACKAGE_ARTIFACT_FORMAT) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Manifest artifactFormat must be "${DEVICE_PACKAGE_ARTIFACT_FORMAT}": ${manifestUrl}`,
    )
  }

  const packageUrls = normalizeUrlListField(payload.packageUrls)
  const packageUrl = packageUrls[0] || requireStringField(payload.packageUrl, 'packageUrl', manifestUrl)
  const sha256 = requireStringField(payload.sha256, 'sha256', manifestUrl).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new UpdateError('update_manifest_invalid', `Manifest sha256 must be a 64 character hex string: ${manifestUrl}`)
  }

  const releasedAt = requireStringField(payload.releasedAt, 'releasedAt', manifestUrl)
  const minCurrentVersion = requireStringField(payload.minCurrentVersion, 'minCurrentVersion', manifestUrl)
  if (!parseSemver(minCurrentVersion)) {
    throw new UpdateError('update_manifest_invalid', `Manifest minCurrentVersion is not a valid semver: ${minCurrentVersion}`)
  }
  const compatibleNodeRange = typeof payload.compatibleNodeRange === 'string' && payload.compatibleNodeRange.trim()
    ? normalizeNodeVersionRange(payload.compatibleNodeRange)
    : normalizeLegacyNodeRange(payload.compatibleNodeMajor, manifestUrl)

  return {
    ...info,
    artifactFormat: DEVICE_PACKAGE_ARTIFACT_FORMAT,
    packageUrl,
    packageUrls: packageUrls.length > 0 ? packageUrls : undefined,
    sha256,
    releasedAt,
    compatibleNodeRange,
    minCurrentVersion,
    notesUrl: typeof payload.notesUrl === 'string' ? payload.notesUrl.trim() : '',
    size: typeof payload.size === 'number' && Number.isFinite(payload.size) ? payload.size : 0,
    healthcheckUrl: typeof payload.healthcheckUrl === 'string' && payload.healthcheckUrl.trim()
      ? payload.healthcheckUrl.trim()
      : update.healthcheckUrl,
    installerScriptPath: typeof payload.installerScriptPath === 'string' && payload.installerScriptPath.trim()
      ? normalizeInstallerScriptPath(payload.installerScriptPath)
      : undefined,
    installerScriptSha256: typeof payload.installerScriptSha256 === 'string' && payload.installerScriptSha256.trim()
      ? payload.installerScriptSha256.trim().toLowerCase()
      : undefined,
  }
}

function normalizeInstallerScriptPath(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\0')) return undefined
  return trimmed
}

export async function fetchSourcePackageManifest(update: UpdateConfig = config.update): Promise<SourcePackageManifest> {
  const { manifestUrl, payload } = await fetchRawManifest(update)
  const info = normalizeBaseManifestInfo(payload, manifestUrl, update)
  if (info.packageType !== 'source-deploy') {
    throw new UpdateError('update_manifest_invalid', `Manifest packageType must be "source-deploy": ${manifestUrl}`)
  }

  const artifactFormat = requireStringField(payload.artifactFormat, 'artifactFormat', manifestUrl)
  if (artifactFormat !== DEVICE_PACKAGE_ARTIFACT_FORMAT) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Manifest artifactFormat must be "${DEVICE_PACKAGE_ARTIFACT_FORMAT}": ${manifestUrl}`,
    )
  }

  const sourceUrls = normalizeUrlListField(payload.sourceUrls)
  const sourceUrl = sourceUrls[0] || requireStringField(payload.sourceUrl, 'sourceUrl', manifestUrl)
  const sourceSha256 = requireStringField(payload.sourceSha256, 'sourceSha256', manifestUrl).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new UpdateError('update_manifest_invalid', `Manifest sourceSha256 must be a 64 character hex string: ${manifestUrl}`)
  }

  const releasedAt = requireStringField(payload.releasedAt, 'releasedAt', manifestUrl)
  const minCurrentVersion = requireStringField(payload.minCurrentVersion, 'minCurrentVersion', manifestUrl)
  if (!parseSemver(minCurrentVersion)) {
    throw new UpdateError('update_manifest_invalid', `Manifest minCurrentVersion is not a valid semver: ${minCurrentVersion}`)
  }
  const sourceRepoUrl = typeof payload.sourceRepoUrl === 'string' ? payload.sourceRepoUrl.trim() : ''
  const sourceSize = typeof payload.sourceSize === 'number' && Number.isFinite(payload.sourceSize) ? payload.sourceSize : 0

  return {
    ...info,
    artifactFormat: DEVICE_PACKAGE_ARTIFACT_FORMAT,
    sourceUrl,
    sourceUrls: sourceUrls.length > 0 ? sourceUrls : undefined,
    sourceSha256,
    releasedAt,
    minCurrentVersion,
    notesUrl: typeof payload.notesUrl === 'string' ? payload.notesUrl.trim() : '',
    sourceRepoUrl: sourceRepoUrl || undefined,
    sourceSize,
    healthcheckUrl: typeof payload.healthcheckUrl === 'string' && payload.healthcheckUrl.trim()
      ? payload.healthcheckUrl.trim()
      : update.healthcheckUrl,
  }
}

function normalizeLegacyNodeRange(compatibleNodeMajor: unknown, manifestUrl: string): string {
  const major = requirePositiveInteger(compatibleNodeMajor, 'compatibleNodeMajor', manifestUrl)
  return `>=${major}.0.0 <${major + 1}.0.0`
}

export async function resolveManifestCheckResult(update: UpdateConfig = config.update): Promise<UpdateCheckResult> {
  const manifest = await fetchManifestUpdateInfo(update)
  return {
    latestVersion: manifest.version,
    sourceLabel: manifest.sourceLabel || update.sourceLabel,
    channel: manifest.channel || update.channel,
    packageType: manifest.packageType || update.packageType,
    strategy: update.strategy,
    detectionSource: 'manifest',
  }
}
