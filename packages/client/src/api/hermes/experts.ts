/**
 * 专家系统前端 API 封装
 * - 不直连云端，统一走本地 Koa
 */
import { request } from '../client'

export interface ExpertCatalogItem {
  id?: number
  slug: string
  name: string
  kind: 'expert' | 'team'
  summary: string
  icon_url: string | null
  cover_url: string | null
  category: string
  default_launch_target: string
  is_featured: boolean
  latest_version: ExpertVersionLite | null
  updated_at?: string
}

export interface ExpertVersionLite {
  version: string
  artifact_sha256: string
  artifact_size: number
  release_notes?: string
  published_at: string
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

export interface InstalledExpertRow {
  id: number
  expert_slug: string
  expert_name: string
  kind: 'expert' | 'team'
  category: string
  installed_version: string
  status: 'downloading' | 'verifying' | 'extracting' | 'installing_profile' | 'installed' | 'failed' | string
  local_path: string
  manifest_json: string
  last_error: string
  last_error_stage: string
  installed_at: number
  updated_at: number
  team_slug: string
}

export interface ExpertProfileBindingRow {
  id: number
  expert_slug: string
  profile_name: string
  role: 'expert' | 'captain' | 'member' | string
  parent_team_slug: string
  installed_version: string
  created_at: number
  updated_at: number
}

export interface MarketplaceConfig {
  baseUrl: string
  cacheTtlSeconds: number
  localPackagesRoot: string
  clientIdTemplate: string
  maxPackageBytes: number
}

interface ApiEnvelope<T> {
  code: number
  message: string
  data: T | null
}

function unwrap<T>(env: ApiEnvelope<T>): T {
  if (env.code !== 0) {
    throw new Error(env.message || `api error code=${env.code}`)
  }
  return (env.data ?? (null as unknown)) as T
}

export async function fetchMarketplaceConfig(): Promise<MarketplaceConfig> {
  const env = await request<ApiEnvelope<MarketplaceConfig>>('/api/hermes/experts/config')
  return unwrap(env)
}

export async function fetchCatalog(): Promise<ExpertCatalogItem[]> {
  const env = await request<ApiEnvelope<unknown>>('/api/hermes/experts/catalog')
  return extractCatalogList(unwrap(env))
}

export async function refreshCatalog(): Promise<ExpertCatalogItem[]> {
  const env = await request<ApiEnvelope<unknown>>(
    '/api/hermes/experts/catalog/refresh',
    { method: 'POST' },
  )
  return extractCatalogList(unwrap(env))
}

function extractCatalogList(payload: unknown): ExpertCatalogItem[] {
  if (Array.isArray(payload)) return payload as ExpertCatalogItem[]
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj.experts)) return obj.experts as ExpertCatalogItem[]
    if (Array.isArray(obj.results)) return obj.results as ExpertCatalogItem[]
    if (Array.isArray(obj.data)) return obj.data as ExpertCatalogItem[]
  }
  return []
}

export async function fetchDetail(slug: string): Promise<ExpertDetail> {
  const env = await request<ApiEnvelope<ExpertDetail>>(
    `/api/hermes/experts/${encodeURIComponent(slug)}/detail`,
  )
  return unwrap(env)
}

export async function fetchManifest(slug: string, version: string): Promise<ExpertManifest> {
  const env = await request<ApiEnvelope<ExpertManifest>>(
    `/api/hermes/experts/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/manifest`,
  )
  return unwrap(env)
}

export interface InstalledResponse {
  installed: Array<{
    slug: string
    profile_name: string
    role: string
    parent_team_slug?: string
    created: boolean
    updated: boolean
  }>
  failed: Array<{ slug: string; reason: string }>
  installed_expert: { slug: string; version: string; status: string }
}

export async function fetchInstalled(): Promise<{
  installed: InstalledExpertRow[]
  bindings: ExpertProfileBindingRow[]
  summary: Record<string, { count: number; roles: Record<string, number> }>
}> {
  const env = await request<ApiEnvelope<{
    installed: InstalledExpertRow[]
    bindings: ExpertProfileBindingRow[]
    summary: Record<string, { count: number; roles: Record<string, number> }>
  }>>('/api/hermes/experts/installed')
  return unwrap(env)
}

export async function installExpert(input: {
  slug: string
  version: string
  client_id?: string
}): Promise<InstalledResponse> {
  const env = await request<ApiEnvelope<InstalledResponse>>('/api/hermes/experts/install', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return unwrap(env)
}

export async function upgradeExpert(slug: string, clientId?: string): Promise<InstalledResponse> {
  const env = await request<ApiEnvelope<InstalledResponse>>(
    `/api/hermes/experts/${encodeURIComponent(slug)}/upgrade`,
    {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId }),
    },
  )
  return unwrap(env)
}

export async function uninstallExpert(slug: string): Promise<{
  removed_profiles: number
  failed_profiles: string[]
  disk_removed: boolean
}> {
  const env = await request<ApiEnvelope<{
    removed_profiles: number
    failed_profiles: string[]
    disk_removed: boolean
  }>>(`/api/hermes/experts/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' })
  return unwrap(env)
}

export async function fetchStatus(slug: string): Promise<{
  installed_expert: InstalledExpertRow
  bindings: ExpertProfileBindingRow[]
}> {
  const env = await request<ApiEnvelope<{
    installed_expert: InstalledExpertRow
    bindings: ExpertProfileBindingRow[]
  }>>(`/api/hermes/experts/${encodeURIComponent(slug)}/status`)
  return unwrap(env)
}

export async function activateExpertProfile(profileName: string): Promise<{ success: boolean }> {
  const env = await request<ApiEnvelope<{ success: boolean }>>('/api/hermes/experts/activate-profile', {
    method: 'POST',
    body: JSON.stringify({ profile_name: profileName }),
  })
  return unwrap(env)
}
