import { join, resolve } from 'path'
import { homedir } from 'os'
import type { UpdatePackageType, UpdateStrategy } from './services/update/types'

/**
 * Web UI environment variables.
 *
 * Server/listen:
 * - PORT: Web UI listen port. Default: 8648.
 * - BIND_HOST: Web UI bind host. Default: 0.0.0.0.
 * - CORS_ORIGINS: Comma/space-separated cross-origin allowlist. Default: same host only.
 *
 * Web UI storage:
 * - HERMES_WEB_UI_HOME: Web UI data home for auth token, credentials, logs, DB, and default uploads.
 * - HERMES_WEBUI_STATE_DIR: Compatibility alias for HERMES_WEB_UI_HOME.
 *   Default: join(homedir(), '.hermes-web-ui').
 * - UPLOAD_DIR: Upload directory override. Default: join(HERMES_WEB_UI_HOME, 'upload').
 * - dataDir: Development-only internal Web UI runtime data directory.
 *
 * Auth:
 * - AUTH_TOKEN: Explicit bearer token. If unset, Web UI stores an auto-generated token under HERMES_WEB_UI_HOME.
 *
 * Runtime behavior:
 * - PROFILE: Initial Hermes profile name. Default: default.
 * - GATEWAY_HOST: Default gateway host written into profile config. Default: 127.0.0.1.
 * - HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: Whether Web UI shutdown also stops gateways.
 * - HERMES_LAN_DISCOVERY_ENABLED: Set false/0/off to disable UDP LAN discovery responder.
 * - HERMES_LAN_DISCOVERY_HTTP_PORTS: HTTP ports to probe during UDP discovery scans. Default: 8648,8748 plus current PORT.
 * - WORKSPACE_BASE: Base directory for workspace browsing. Default: /opt/data/workspace.
 *
 * Limits/logging:
 * - MAX_DOWNLOAD_SIZE: Max file download size. Default: 200MB.
 * - MAX_EDIT_SIZE: Max editable file size. Default: 10MB.
 * - LOG_LEVEL: Server log level. Default: info.
 * - BRIDGE_LOG_LEVEL: Bridge log level. Default: LOG_LEVEL or info.
 */

export function getListenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.BIND_HOST?.trim()
  return host || '0.0.0.0'
}

export function getWebUiHome(env: Record<string, string | undefined> = process.env): string {
  const configuredHome = env.HERMES_WEB_UI_HOME?.trim() || env.HERMES_WEBUI_STATE_DIR?.trim()
  return configuredHome ? resolve(configuredHome) : join(homedir(), '.hermes-web-ui')
}

export function getUploadDir(env: Record<string, string | undefined> = process.env): string {
  const configuredDir = env.UPLOAD_DIR?.trim()
  return configuredDir ? resolve(configuredDir) : join(getWebUiHome(env), 'upload')
}

export function getHermesHome(env: Record<string, string | undefined> = process.env): string {
  const configuredHome = env.HERMES_HOME?.trim() || env.HERMES_HOME_DIR?.trim()
  return configuredHome ? resolve(configuredHome) : ''
}

export function getDeployDir(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const configuredDir = env.DEPLOY_DIR?.trim()
  return resolve(configuredDir || cwd)
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function normalizeUrl(value: string | undefined): string {
  return (value || '').trim().replace(/\/+$/, '')
}

function normalizeOptionalUrl(value: string | undefined): string {
  return (value || '').trim()
}

function normalizePackageName(value: string | undefined): string {
  return (value || '').trim()
}

function normalizeUpdateStrategy(value: string | undefined): UpdateStrategy {
  const normalized = (value || '').trim().toLowerCase()
  if (normalized === 'device-package') return 'device-package'
  return normalized === 'source-deploy' ? 'source-deploy' : 'npm-package'
}

function normalizeUpdatePackageType(value: string | undefined): UpdatePackageType {
  const normalized = (value || '').trim().toLowerCase()
  if (normalized === 'npm-package') return 'npm-package'
  if (normalized === 'source-deploy') return 'source-deploy'
  return 'device-package'
}

function getDefaultUpdateCliBin(packageName: string): string {
  const packageBasename = packageName.split('/').filter(Boolean).pop() || packageName
  return `${packageBasename}.mjs`
}

function getDefaultUpdateSourceLabel(packageName: string, registry: string): string {
  if (!packageName || !registry) return ''
  try {
    const host = new URL(registry).host
    return `${packageName} @ ${host}`
  } catch {
    return `${packageName} @ ${registry}`
  }
}

function getDefaultManifestSourceLabel(manifestUrl: string, manifestBaseUrl: string): string {
  const candidate = manifestUrl || manifestBaseUrl
  if (!candidate) return ''
  try {
    return `Manifest @ ${new URL(candidate).host}`
  } catch {
    return 'Manifest'
  }
}

export function shouldCreateWebUiDataDir(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production'
}

export function getCorsOrigins(env: Record<string, string | undefined> = process.env): string {
  return env.CORS_ORIGINS?.trim() || ''
}

const appHome = getWebUiHome()
const updatePackageName = normalizePackageName(process.env.WEBUI_UPDATE_PACKAGE)
const updateRegistry = normalizeUrl(process.env.WEBUI_UPDATE_REGISTRY)
const updateManifestUrl = normalizeOptionalUrl(process.env.WEBUI_UPDATE_MANIFEST_URL)
const updateManifestBaseUrl = normalizeUrl(process.env.WEBUI_UPDATE_MANIFEST_BASE_URL)

export const config = {
  port: parseInt(process.env.PORT || '8648', 10),
  // Default to IPv4 for stable WSL/Windows browser access. Use BIND_HOST=:: explicitly for IPv6.
  host: getListenHost(),
  appHome,
  uploadDir: getUploadDir(),
  dataDir: resolve(__dirname, '..', 'data'),
  corsOrigins: getCorsOrigins(),
  update: {
    enabled: parseBoolean(process.env.WEBUI_UPDATE_ENABLED),
    strategy: normalizeUpdateStrategy(process.env.WEBUI_UPDATE_STRATEGY),
    packageName: updatePackageName,
    registry: updateRegistry,
    sourceLabel: (process.env.WEBUI_UPDATE_SOURCE_LABEL || '').trim()
      || getDefaultManifestSourceLabel(updateManifestUrl, updateManifestBaseUrl)
      || getDefaultUpdateSourceLabel(updatePackageName, updateRegistry),
    distTag: (process.env.WEBUI_UPDATE_DIST_TAG || 'latest').trim() || 'latest',
    cliBin: (process.env.WEBUI_UPDATE_CLI_BIN || '').trim() || getDefaultUpdateCliBin(updatePackageName || 'hermes-web-ui'),
    script: (process.env.WEBUI_UPDATE_SCRIPT || '').trim(),
    channel: (process.env.WEBUI_UPDATE_CHANNEL || 'stable').trim() || 'stable',
    manifestUrl: updateManifestUrl,
    manifestBaseUrl: updateManifestBaseUrl,
    packageType: normalizeUpdatePackageType(process.env.WEBUI_UPDATE_PACKAGE_TYPE),
  },
}

export function hasConfiguredManifestCheck(
  envUpdate: typeof config.update = config.update,
): boolean {
  return Boolean(envUpdate.enabled && (envUpdate.manifestUrl || envUpdate.manifestBaseUrl))
}

export function hasConfiguredUpdateCheck(
  envUpdate: typeof config.update = config.update,
): boolean {
  return Boolean(
    envUpdate.enabled
    && ((envUpdate.manifestUrl || envUpdate.manifestBaseUrl) || (envUpdate.packageName && envUpdate.registry)),
  )
}

export function hasConfiguredUpdateExecution(
  envUpdate: typeof config.update = config.update,
): boolean {
  if (!hasConfiguredUpdateCheck(envUpdate))
    return false
  if (envUpdate.strategy === 'device-package')
    return false
  if (envUpdate.strategy === 'source-deploy')
    return Boolean(envUpdate.script)
  return Boolean(envUpdate.cliBin)
}
