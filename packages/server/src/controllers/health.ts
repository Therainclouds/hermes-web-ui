import * as hermesCli from '../services/hermes/hermes-cli'
import { config, hasConfiguredManifestCheck, hasConfiguredUpdateCheck, hasConfiguredUpdateExecution } from '../config'
import { getAgentBridgeManager } from '../services/hermes/agent-bridge/manager'
import { redactAgentBridgeError } from '../services/hermes/agent-bridge/redact'
import { resolveManifestCheckResult } from '../services/update/manifest-client'
import { getLocalWebUiVersion } from '../services/update/package-info'
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
  detectionSource: 'manifest',
}

const LOCAL_VERSION = getLocalWebUiVersion(BUILD_VERSION)
const AGENT_BRIDGE_HEALTH_FIRST_WAIT_MS = 75
const AGENT_BRIDGE_HEALTH_CACHE_TTL_MS = 1000

type AgentBridgeHealthPayload = {
  status: 'ready' | 'starting' | 'recovering' | 'stopping' | 'restarting' | 'unreachable' | 'unknown'
  reachable: boolean
  ready?: boolean
  running?: boolean
  attached?: boolean
  starting?: boolean
  stopping?: boolean
  restart_scheduled?: boolean
  restart_attempts?: number
  endpoint_kind?: 'ipc' | 'tcp' | 'unknown'
  pid?: number
  error?: string
}

let cachedAgentBridgeHealth: { value: AgentBridgeHealthPayload; expiresAt: number } | null = null
let pendingAgentBridgeHealthRefresh: Promise<AgentBridgeHealthPayload> | null = null

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

export async function checkLatestVersion(): Promise<void> {
  if (!hasConfiguredUpdateCheck(config.update)) return
  // Manifest is the only authoritative source. Never probe the npm registry,
  // so a stale or unconfigured `latest` tag cannot surface as a fake update.
  if (!hasConfiguredManifestCheck(config.update)) return

  try {
    const nextInfo = await resolveManifestCheckResult(config.update)
    if (nextInfo?.latestVersion) {
      cachedUpdateInfo = nextInfo
      if (isRemoteVersionNewer(LOCAL_VERSION, nextInfo.latestVersion)) {
        console.log(`Update available: ${LOCAL_VERSION} → ${nextInfo.latestVersion}`)
      }
    }
  } catch {
    // Manifest fetch failed; surface nothing instead of probing the registry.
  }
}

export function startVersionCheck(): void {
  if (!hasConfiguredUpdateCheck(config.update) || isUpdateCheckDisabled()) return
  setTimeout(checkLatestVersion, 5000)
  setInterval(checkLatestVersion, 30 * 60 * 1000)
}

async function getAgentBridgeHealth() {
  const now = Date.now()
  if (cachedAgentBridgeHealth && cachedAgentBridgeHealth.expiresAt > now) {
    return cachedAgentBridgeHealth.value
  }

  if (!pendingAgentBridgeHealthRefresh) {
    pendingAgentBridgeHealthRefresh = refreshAgentBridgeHealth().finally(() => {
      pendingAgentBridgeHealthRefresh = null
    })
  }

  if (cachedAgentBridgeHealth) {
    return cachedAgentBridgeHealth.value
  }

  const firstResult = await Promise.race([
    pendingAgentBridgeHealthRefresh,
    new Promise<AgentBridgeHealthPayload>((resolve) => {
      setTimeout(() => resolve({ status: 'unknown', reachable: false }), AGENT_BRIDGE_HEALTH_FIRST_WAIT_MS)
    }),
  ])

  return firstResult
}

async function refreshAgentBridgeHealth(): Promise<AgentBridgeHealthPayload> {
  let endpoint: string | undefined

  try {
    const manager = getAgentBridgeManager()
    endpoint = typeof manager.getRuntimeState === 'function'
      ? manager.getRuntimeState().endpoint
      : undefined

    const readiness = await manager.checkReadiness({ timeoutMs: AGENT_BRIDGE_HEALTH_FIRST_WAIT_MS, connectRetryMs: 0 })
    const value: AgentBridgeHealthPayload = {
      status: readiness.status,
      reachable: readiness.reachable,
      ready: readiness.ready,
      running: readiness.running,
      attached: readiness.attached,
      starting: readiness.starting,
      stopping: readiness.stopping,
      restart_scheduled: readiness.restartScheduled,
      restart_attempts: readiness.restartAttempts,
      endpoint_kind: readiness.endpointKind,
      pid: readiness.pid,
      error: redactAgentBridgeError(readiness.error, readiness.endpoint),
    }
    cachedAgentBridgeHealth = { value, expiresAt: Date.now() + AGENT_BRIDGE_HEALTH_CACHE_TTL_MS }
    return value
  } catch (err) {
    const value: AgentBridgeHealthPayload = {
      status: 'unknown',
      reachable: false,
      error: redactAgentBridgeError(err instanceof Error ? err.message : String(err), endpoint),
    }
    cachedAgentBridgeHealth = { value, expiresAt: Date.now() + AGENT_BRIDGE_HEALTH_CACHE_TTL_MS }
    return value
  }
}

export async function healthCheck(ctx: any) {
  const raw = await hermesCli.getVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  const updateEnabled = hasConfiguredUpdateExecution(config.update)
  const updateCheckConfigured = hasConfiguredUpdateCheck(config.update)
  const updateCheckDisabled = isUpdateCheckDisabled()
  const agentBridge = await getAgentBridgeHealth()
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
    agent_bridge: agentBridge,
  }
}
