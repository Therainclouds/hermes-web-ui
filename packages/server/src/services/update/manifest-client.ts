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
import type { DevicePackageManifest, ManifestUpdateInfo, UpdateCheckResult, UpdateConfig, UpdatePackageType } from './types'

interface RawManifestPayload {
  version?: unknown
  channel?: unknown
  sourceLabel?: unknown
  packageType?: unknown
  artifactFormat?: unknown
  packageUrl?: unknown
  sha256?: unknown
  releasedAt?: unknown
  compatibleNodeMajor?: unknown
  compatibleNodeRange?: unknown
  minCurrentVersion?: unknown
  notesUrl?: unknown
  size?: unknown
  healthcheckUrl?: unknown
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

async function fetchRawManifest(update: UpdateConfig = config.update): Promise<{ manifestUrl: string; payload: RawManifestPayload }> {
  const manifestUrl = resolveConfiguredManifestUrl(update)
  if (!manifestUrl) {
    throw new UpdateError('update_execution_misconfigured', 'Manifest update source is not configured')
  }

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
    throw new UpdateError(
      'update_manifest_fetch_failed',
      `Failed to fetch update manifest from ${manifestUrl}.`,
      502,
      {
        manifestUrl,
        ...describeUpdateNetworkError(err),
      },
    )
  }

  if (!response.ok) {
    throw new UpdateError(
      'update_manifest_fetch_failed',
      `Failed to load manifest from ${manifestUrl}: HTTP ${response.status}`,
      502,
      {
        manifestUrl,
        status: response.status,
        transport: response.transport,
        attempts: response.attempts,
      },
    )
  }

  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new UpdateError('update_manifest_invalid', `Manifest response is not a JSON object: ${manifestUrl}`)
  }

  const payload = response.data as RawManifestPayload
  return { manifestUrl, payload }
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

  const packageUrl = requireStringField(payload.packageUrl, 'packageUrl', manifestUrl)
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
    sha256,
    releasedAt,
    compatibleNodeRange,
    minCurrentVersion,
    notesUrl: typeof payload.notesUrl === 'string' ? payload.notesUrl.trim() : '',
    size: typeof payload.size === 'number' && Number.isFinite(payload.size) ? payload.size : 0,
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
