/**
 * 专家市场本地接入配置加载
 * 启动时从 config/experts-marketplace.yaml 读取；仅 baseUrl 必填
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface ExpertsMarketplaceConfig {
  baseUrl: string
  cacheTtlSeconds: number
  localPackagesRoot: string
  clientIdTemplate: string
  maxPackageBytes: number
  downloadTimeoutMs: number
  verifyTimeoutMs: number
}

const DEFAULTS: Omit<ExpertsMarketplaceConfig, 'baseUrl' | 'localPackagesRoot'> = {
  cacheTtlSeconds: 30,
  clientIdTemplate: 'hermes-web-ui-v{version}-user-{userId}',
  maxPackageBytes: 100 * 1024 * 1024,
  downloadTimeoutMs: 60_000,
  verifyTimeoutMs: 30_000,
}

let cached: ExpertsMarketplaceConfig | null = null

function getConfigPath(): string {
  // hermes-web-ui/packages/server/src/services/hermes/experts -> hermes-web-ui/config
  // 4 层向上
  return join(process.cwd(), 'config', 'experts-marketplace.yaml')
}

function parseSimpleYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function resolvePackagesRoot(raw: string | undefined): string {
  const envRoot = process.env.HERMES_WEBUI_STATE_DIR
  const base = raw && raw.includes('${HERMES_WEBUI_STATE_DIR}')
    ? raw.replace('${HERMES_WEBUI_STATE_DIR}', envRoot ?? '')
    : raw
  if (base && base.trim().length > 0) return base
  const fallback = envRoot
    ? join(envRoot, 'experts', 'packages')
    : join(process.cwd(), '.hermes', 'experts', 'packages')
  return fallback
}

export function loadExpertsMarketplaceConfig(): ExpertsMarketplaceConfig {
  if (cached) return cached
  const cfgPath = getConfigPath()
  const raw: Record<string, string> = existsSync(cfgPath)
    ? parseSimpleYaml(readFileSync(cfgPath, 'utf8'))
    : {}
  if (!raw.baseUrl || raw.baseUrl.trim().length === 0) {
    // 配置缺失不抛错：让上层业务按需提示
    cached = {
      baseUrl: '',
      ...DEFAULTS,
      localPackagesRoot: resolvePackagesRoot(undefined),
    }
    return cached
  }
  cached = {
    baseUrl: raw.baseUrl,
    cacheTtlSeconds: raw.cacheTtlSeconds
      ? Number(raw.cacheTtlSeconds)
      : DEFAULTS.cacheTtlSeconds,
    localPackagesRoot: resolvePackagesRoot(raw.localPackagesRoot),
    clientIdTemplate: raw.clientIdTemplate || DEFAULTS.clientIdTemplate,
    maxPackageBytes: raw.maxPackageBytes
      ? Number(raw.maxPackageBytes)
      : DEFAULTS.maxPackageBytes,
    downloadTimeoutMs: raw.downloadTimeoutMs
      ? Number(raw.downloadTimeoutMs)
      : DEFAULTS.downloadTimeoutMs,
    verifyTimeoutMs: raw.verifyTimeoutMs
      ? Number(raw.verifyTimeoutMs)
      : DEFAULTS.verifyTimeoutMs,
  }
  return cached
}

export function resetExpertsMarketplaceConfigCache(): void {
  cached = null
}
