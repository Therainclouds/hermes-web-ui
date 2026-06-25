/**
 * 专家市场 - 云端 API 客户端
 * 转发到 Web_Admin_UI_HT 公开接口 (catalog/detail/manifest/download)
 */
import { loadExpertsMarketplaceConfig } from './config'

export interface ExpertCatalogItem {
  id: number
  slug: string
  name: string
  kind: 'expert' | 'team'
  summary: string
  icon_url: string | null
  cover_url: string | null
  category: string
  default_launch_target: string
  is_featured: boolean
  latest_version: string | null
  updated_at: string
}

export interface ExpertVersionMeta {
  version: string
  artifact_size: number
  artifact_sha256: string
  published_at: string
  release_notes?: string
}

export interface ExpertDetail {
  slug: string
  name: string
  kind: 'expert' | 'team'
  summary: string
  description: string
  icon_url: string | null
  cover_url: string | null
  category: string
  default_launch_target: string
  is_featured: boolean
  latest_version: ExpertVersionMeta | null
  team_members: Array<{
    slug: string
    name: string
    role_name: string
    sort_order: number
    is_captain: boolean
    latest_version: string | null
  }> | null
}

export interface ExpertManifest {
  expert: {
    slug: string
    name: string
    kind: 'expert' | 'team'
    category: string
    summary: string
    defaultLaunchTarget: string
  }
  version: {
    name: string
    artifactSha256: string
    artifactSize: number
    releaseNotes?: string
  }
  profileTemplate: {
    displayName: string
    systemPromptPath: string
    avatarPath: string
    starterPrompts: string[]
    defaultSkills: string[]
  }
}

export interface DownloadGrant {
  download_url: string
  sha256: string
  size: number
  expires_at: number
  signature_algorithm: string
}

export class MarketplaceError extends Error {
  constructor(
    public readonly code: number,
    public readonly stage: string,
    message: string,
  ) {
    super(message)
  }
}

interface ApiEnvelope<T> {
  code: number
  message: string
  data: T | null
}

let catalogCache: { fetchedAt: number; items: ExpertCatalogItem[] } | null = null

function baseUrl(): string {
  const cfg = loadExpertsMarketplaceConfig()
  return cfg.baseUrl.replace(/\/+$/, '')
}

function throwOnBad(
  env: ApiEnvelope<unknown>,
  stage: string,
  fallbackMessage: string,
): void {
  if (env.code !== 0) {
    throw new MarketplaceError(env.code, stage, env.message || fallbackMessage)
  }
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
  stage = 'fetch',
): Promise<T> {
  const url = `${baseUrl()}${path}`
  let resp: Response
  try {
    resp = await fetch(url, init)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'network error'
    throw new MarketplaceError(0, stage, `Network error: ${msg}`)
  }
  if (!resp.ok) {
    throw new MarketplaceError(resp.status, stage, `HTTP ${resp.status}`)
  }
  const env = (await resp.json()) as ApiEnvelope<T>
  throwOnBad(env, stage, 'cloud error')
  return env.data as T
}

export async function fetchCatalog(
  force = false,
): Promise<ExpertCatalogItem[]> {
  const cfg = loadExpertsMarketplaceConfig()
  if (
    !force &&
    catalogCache &&
    Date.now() - catalogCache.fetchedAt < cfg.cacheTtlSeconds * 1000
  ) {
    return catalogCache.items
  }
  const payload = await fetchJson<ExpertCatalogItem[] | { experts: ExpertCatalogItem[] }>(
    '/api/experts/catalog/',
    undefined,
    'catalog',
  )
  const items = extractCatalogItems(payload)
  catalogCache = { fetchedAt: Date.now(), items }
  return items
}

function extractCatalogItems(
  payload: ExpertCatalogItem[] | { experts: ExpertCatalogItem[] } | null | undefined,
): ExpertCatalogItem[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray((payload as { experts: ExpertCatalogItem[] }).experts)) {
    return (payload as { experts: ExpertCatalogItem[] }).experts
  }
  return []
}

export function clearCatalogCache(): void {
  catalogCache = null
}

export async function fetchDetail(slug: string): Promise<ExpertDetail> {
  const data = await fetchJson<ExpertDetail>(
    `/api/experts/${encodeURIComponent(slug)}/detail/`,
    undefined,
    'detail',
  )
  if (!data) {
    throw new MarketplaceError(404, 'detail', '专家不存在')
  }
  return data
}

export async function fetchManifest(
  slug: string,
  version: string,
): Promise<ExpertManifest> {
  const data = await fetchJson<ExpertManifest>(
    `/api/experts/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/manifest/`,
    undefined,
    'manifest',
  )
  if (!data) {
    throw new MarketplaceError(404, 'manifest', 'manifest 不存在')
  }
  return data
}

export async function fetchLatest(slug: string): Promise<ExpertVersionMeta | null> {
  const data = await fetchJson<ExpertVersionMeta | null>(
    `/api/experts/${encodeURIComponent(slug)}/latest/`,
    undefined,
    'latest',
  )
  return data
}

export async function requestDownload(
  slug: string,
  version: string,
  clientId: string,
): Promise<DownloadGrant> {
  const data = await fetchJson<DownloadGrant>(
    `/api/experts/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download/`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
    },
    'download',
  )
  if (!data) {
    throw new MarketplaceError(400, 'download', '下载授权失败')
  }
  // 规范化 download_url：可能是相对路径（云端通过 /api/internal/local-storage/ 提供）
  // 也要保证 URL 的 host 来自云端 baseUrl，避免被本地 dev proxy 拦截
  return {
    ...data,
    download_url: absolutizeDownloadUrl(data.download_url),
  }
}

function absolutizeDownloadUrl(url: string): string {
  if (!url) return url
  if (/^https?:\/\//i.test(url)) return url
  const cfg = loadExpertsMarketplaceConfig()
  const base = cfg.baseUrl.replace(/\/+$/, '')
  if (!base) return url
  if (url.startsWith('/')) return `${base}${url}`
  return `${base}/${url}`
}
