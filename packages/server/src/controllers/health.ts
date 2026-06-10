import * as hermesCli from '../services/hermes/hermes-cli'
import { config, hasConfiguredManifestCheck, hasConfiguredUpdateCheck, hasConfiguredUpdateExecution } from '../config'
import { resolveManifestCheckResult } from '../services/update/manifest-client'
import { getLocalWebUiVersion, readPackageInfo } from '../services/update/package-info'
import type { UpdateCheckResult } from '../services/update/types'
import { isRemoteVersionNewer } from '../services/update/version-compare'

declare const __APP_VERSION__: string

const BUILD_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : ''

let cachedUpdateInfo: UpdateCheckResult = {
  latestVersion: '',
  sourceLabel: config.update.sourceLabel,
  channel: config.update.channel,
  packageType: config.update.packageType,
  strategy: config.update.strategy,
  detectionSource: 'npm-registry',
}

const PACKAGE_INFO = readPackageInfo()
const LOCAL_VERSION = getLocalWebUiVersion(BUILD_VERSION)

function hasConfiguredUpdateSource(): boolean {
  return hasConfiguredUpdateExecution(config.update)
}

/**
 * Whether the periodic npm-registry version check is disabled.
 *
 * Useful when the Web UI is bundled inside a packaged distribution
 * (e.g. a desktop app) where the user can't `npm install -g <your-package>@latest`
 * to upgrade — the "update available" prompt would be misleading and
 * the periodic outbound HTTP request to the npm registry is unnecessary.
 *
 * Set HERMES_WEB_UI_DISABLE_UPDATE_CHECK=true (or 1, on, yes) to disable.
 */
function isUpdateCheckDisabled(): boolean {
  if (hasConfiguredUpdateCheck(config.update)) return false
  const raw = (process.env.HERMES_WEB_UI_DISABLE_UPDATE_CHECK || '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes'
}

async function resolveRegistryCheckResult(): Promise<UpdateCheckResult | null> {
  if (!(config.update.packageName && config.update.registry)) return null

  const packageName = config.update.packageName || PACKAGE_INFO?.name || 'hermes-web-ui'
  const registry = config.update.registry || 'https://registry.npmjs.org'
  const distTag = config.update.distTag || 'latest'
  const registryName = encodeURIComponent(packageName)
  const url = `${registry}/${registryName}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) {
    throw new Error(`Failed to resolve the latest published version from ${registry}: HTTP ${res.status}`)
  }

  const data = await res.json() as { version?: string; 'dist-tags'?: Record<string, string> }
  const version = data['dist-tags']?.[distTag] || data.version || data['dist-tags']?.latest || ''
  if (!version) return null

  return {
    latestVersion: version,
    sourceLabel: config.update.sourceLabel,
    channel: config.update.channel,
    packageType: config.update.packageType,
    strategy: config.update.strategy,
    detectionSource: 'npm-registry',
  }
}

export async function checkLatestVersion(): Promise<void> {
  if (!hasConfiguredUpdateCheck(config.update)) return

  try {
    const nextInfo = hasConfiguredManifestCheck(config.update)
      ? await resolveManifestCheckResult(config.update)
      : await resolveRegistryCheckResult()
    if (nextInfo?.latestVersion) {
      cachedUpdateInfo = nextInfo
      if (isRemoteVersionNewer(LOCAL_VERSION, nextInfo.latestVersion)) {
        console.log(`Update available: ${LOCAL_VERSION} → ${nextInfo.latestVersion}`)
      }
    }
  } catch {
    if (!hasConfiguredManifestCheck(config.update)) return
    try {
      const fallbackInfo = await resolveRegistryCheckResult()
      if (fallbackInfo?.latestVersion) {
        cachedUpdateInfo = fallbackInfo
      }
    } catch {
      // ignore
    }
  }
}

export function startVersionCheck(): void {
  if (!hasConfiguredUpdateCheck(config.update) || isUpdateCheckDisabled()) return
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  const updateEnabled = hasConfiguredUpdateExecution(config.update)
  const updateCheckConfigured = hasConfiguredUpdateCheck(config.update)
  const updateCheckDisabled = isUpdateCheckDisabled()
  ctx.body = {
    status: 'ok',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: 'running',
    webui_version: LOCAL_VERSION,
    webui_latest: updateCheckDisabled ? '' : cachedUpdateInfo.latestVersion,
    webui_update_enabled: updateEnabled,
    webui_update_source_label: updateCheckConfigured ? (cachedUpdateInfo.sourceLabel || config.update.sourceLabel) : '',
    webui_update_channel: updateCheckConfigured ? (cachedUpdateInfo.channel || config.update.channel) : '',
    webui_update_strategy: updateCheckConfigured ? config.update.strategy : '',
    webui_update_package_type: updateCheckConfigured ? (cachedUpdateInfo.packageType || config.update.packageType) : '',
    webui_update_available: updateCheckDisabled
      ? false
      : isRemoteVersionNewer(LOCAL_VERSION, cachedUpdateInfo.latestVersion),
    node_version: process.versions.node,
  }
}
