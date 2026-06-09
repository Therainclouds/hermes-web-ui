import { config } from '../../config'
import type { ManifestUpdateInfo, UpdateCheckResult, UpdateConfig, UpdatePackageType } from './types'

interface RawManifestPayload {
  version?: unknown
  channel?: unknown
  sourceLabel?: unknown
  packageType?: unknown
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
  const normalizedChannel = (channel || 'stable').trim() || 'stable'
  return `${normalizedBaseUrl}/${encodeURIComponent(normalizedChannel)}/manifest.json`
}

export function resolveConfiguredManifestUrl(update: UpdateConfig = config.update): string {
  if (update.manifestUrl) return update.manifestUrl
  if (update.manifestBaseUrl) return buildManifestUrl(update.manifestBaseUrl, update.channel)
  return ''
}

export async function fetchManifestUpdateInfo(update: UpdateConfig = config.update): Promise<ManifestUpdateInfo> {
  const manifestUrl = resolveConfiguredManifestUrl(update)
  if (!manifestUrl) {
    throw new Error('Manifest update source is not configured')
  }

  const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    throw new Error(`Failed to load manifest: HTTP ${res.status}`)
  }

  const payload = await res.json() as RawManifestPayload
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (!version) {
    throw new Error(`Manifest is missing a valid version field: ${manifestUrl}`)
  }

  const channel = typeof payload.channel === 'string' && payload.channel.trim()
    ? payload.channel.trim()
    : update.channel
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
