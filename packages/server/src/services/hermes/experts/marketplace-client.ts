/**
 * 专家市场 - 云端 API 客户端
 * 兼容两套后台：
 * - 新版 skillhub: /api/skillhub/expert-catalog/*
 * - 旧版 marketplace: /api/experts/*
 */
import { loadExpertsMarketplaceConfig } from './config'

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
  latest_version: ExpertVersionMeta | null
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
  message?: string
  data: T | null
}

interface SkillhubCategory {
  slug?: string
  name?: string
}

interface SkillhubCatalogPayload {
  experts?: unknown[]
}

interface SkillhubLatestVersionPayload {
  id?: number
  version?: string
  artifact_url?: string
  artifact_sha256?: string
  artifact_size?: number
  manifest_json?: unknown
  release_notes?: string
  published_at?: string
  updated_at?: string
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
    throw new MarketplaceError(env.code ?? 500, stage, env.message || fallbackMessage)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeCategoryName(value: unknown): string {
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    const name = asString(value.name)
    if (name) return name
    return asString(value.slug)
  }
  return ''
}

function normalizeVersionMeta(value: unknown): ExpertVersionMeta | null {
  if (typeof value === 'string') {
    return {
      version: value,
      artifact_size: 0,
      artifact_sha256: '',
      published_at: '',
    }
  }
  if (!isRecord(value)) return null
  const version = asString(value.version)
  if (!version) return null
  return {
    version,
    artifact_size: asNumber(value.artifact_size),
    artifact_sha256: asString(value.artifact_sha256),
    published_at: asString(value.published_at),
    release_notes: asOptionalString(value.release_notes),
  }
}

function normalizeCatalogItem(value: unknown): ExpertCatalogItem | null {
  if (!isRecord(value)) return null
  const slug = asString(value.slug)
  if (!slug) return null
  return {
    id: typeof value.id === 'number' ? value.id : undefined,
    slug,
    name: asString(value.name),
    kind: value.kind === 'team' ? 'team' : 'expert',
    summary: asString(value.summary),
    icon_url: asOptionalString(value.icon_url) ?? null,
    cover_url: asOptionalString(value.cover_url) ?? null,
    category: normalizeCategoryName(value.category),
    default_launch_target: asString(value.default_launch_target, 'chat'),
    is_featured: value.is_featured === true,
    latest_version: normalizeVersionMeta(value.latest_version),
    updated_at: asString(value.updated_at),
  }
}

function normalizeTeamMembers(value: unknown): ExpertDetail['team_members'] {
  if (!Array.isArray(value)) return null
  return value
    .filter(isRecord)
    .map((item) => ({
      slug: asString(item.slug),
      name: asString(item.name),
      role_name: asString(item.role_name),
      sort_order: asNumber(item.sort_order),
      is_captain: item.is_captain === true,
      latest_version: typeof item.latest_version === 'string' ? item.latest_version : null,
    }))
}

function normalizeDetail(value: unknown): ExpertDetail | null {
  if (!isRecord(value)) return null
  const slug = asString(value.slug)
  if (!slug) return null
  return {
    slug,
    name: asString(value.name),
    kind: value.kind === 'team' ? 'team' : 'expert',
    summary: asString(value.summary),
    description: asString(value.description),
    icon_url: asOptionalString(value.icon_url) ?? null,
    cover_url: asOptionalString(value.cover_url) ?? null,
    category: normalizeCategoryName(value.category),
    default_launch_target: asString(value.default_launch_target, 'chat'),
    is_featured: value.is_featured === true,
    latest_version: normalizeVersionMeta(value.latest_version),
    team_members: normalizeTeamMembers(value.team_members),
  }
}

function requireManifest(value: unknown, fallback: {
  slug: string
  name: string
  kind: 'expert' | 'team'
  category: string
  summary: string
  defaultLaunchTarget: string
  version: ExpertVersionMeta
}): ExpertManifest {
  if (!isRecord(value)) {
    throw new MarketplaceError(500, 'manifest', 'latest.manifest_json 缺失或格式错误')
  }
  const expertRaw = isRecord(value.expert) ? value.expert : {}
  const versionRaw = isRecord(value.version) ? value.version : {}
  const profileTemplateRaw = isRecord(value.profileTemplate)
    ? value.profileTemplate
    : isRecord(value.profile_template)
      ? value.profile_template
      : {}
  const starterPromptsRaw = profileTemplateRaw.starterPrompts ?? profileTemplateRaw.starter_prompts
  const defaultSkillsRaw = profileTemplateRaw.defaultSkills ?? profileTemplateRaw.default_skills
  const starterPrompts = Array.isArray(starterPromptsRaw)
    ? starterPromptsRaw.map((item: unknown) => asString(item)).filter(Boolean)
    : []
  const defaultSkills = Array.isArray(defaultSkillsRaw)
    ? defaultSkillsRaw.map((item: unknown) => asString(item)).filter(Boolean)
    : []

  return {
    expert: {
      slug: asString(expertRaw.slug, fallback.slug),
      name: asString(expertRaw.name, fallback.name),
      kind: expertRaw.kind === 'team' ? 'team' : fallback.kind,
      category: normalizeCategoryName(expertRaw.category) || fallback.category,
      summary: asString(expertRaw.summary, fallback.summary),
      defaultLaunchTarget: asString(
        expertRaw.defaultLaunchTarget ?? expertRaw.default_launch_target,
        fallback.defaultLaunchTarget,
      ),
    },
    version: {
      name: asString(versionRaw.name ?? versionRaw.version, fallback.version.version),
      artifactSha256: asString(
        versionRaw.artifactSha256 ?? versionRaw.artifact_sha256,
        fallback.version.artifact_sha256,
      ),
      artifactSize: asNumber(
        versionRaw.artifactSize ?? versionRaw.artifact_size,
        fallback.version.artifact_size,
      ),
      releaseNotes: asOptionalString(
        versionRaw.releaseNotes ?? versionRaw.release_notes ?? fallback.version.release_notes,
      ),
    },
    profileTemplate: {
      displayName: asString(
        profileTemplateRaw.displayName ?? profileTemplateRaw.display_name,
        fallback.name,
      ),
      systemPromptPath: asString(
        profileTemplateRaw.systemPromptPath ?? profileTemplateRaw.system_prompt_path,
        'prompts/system.md',
      ),
      avatarPath: asString(
        profileTemplateRaw.avatarPath ?? profileTemplateRaw.avatar_path,
        'assets/avatar.png',
      ),
      starterPrompts,
      defaultSkills,
    },
  }
}

function extractCatalogItems(
  payload: unknown,
): ExpertCatalogItem[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeCatalogItem).filter((item): item is ExpertCatalogItem => item !== null)
  }
  if (isRecord(payload) && Array.isArray(payload.experts)) {
    return payload.experts
      .map(normalizeCatalogItem)
      .filter((item): item is ExpertCatalogItem => item !== null)
  }
  return []
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof MarketplaceError && err.code === 404
}

async function tryFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary()
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }
  return await fallback()
}

async function fetchSkillhubCatalog(): Promise<ExpertCatalogItem[]> {
  const payload = await fetchJson<SkillhubCatalogPayload>(
    '/api/skillhub/expert-catalog/',
    undefined,
    'catalog',
  )
  return extractCatalogItems(payload)
}

async function fetchLegacyCatalog(): Promise<ExpertCatalogItem[]> {
  const payload = await fetchJson<unknown>(
    '/api/experts/catalog/',
    undefined,
    'catalog',
  )
  return extractCatalogItems(payload)
}

async function fetchSkillhubDetail(slug: string): Promise<ExpertDetail> {
  const raw = await fetchJson<unknown>(
    `/api/skillhub/expert-catalog/${encodeURIComponent(slug)}/`,
    undefined,
    'detail',
  )
  const detail = normalizeDetail(raw)
  if (!detail) {
    throw new MarketplaceError(500, 'detail', '专家详情格式错误')
  }
  return detail
}

async function fetchLegacyDetail(slug: string): Promise<ExpertDetail> {
  const raw = await fetchJson<unknown>(
    `/api/experts/${encodeURIComponent(slug)}/detail/`,
    undefined,
    'detail',
  )
  const detail = normalizeDetail(raw)
  if (!detail) {
    throw new MarketplaceError(404, 'detail', '专家不存在')
  }
  return detail
}

async function fetchSkillhubLatestRaw(slug: string): Promise<SkillhubLatestVersionPayload> {
  const raw = await fetchJson<unknown>(
    `/api/skillhub/expert-catalog/${encodeURIComponent(slug)}/latest/`,
    undefined,
    'latest',
  )
  if (!isRecord(raw)) {
    throw new MarketplaceError(500, 'latest', 'latest 返回格式错误')
  }
  return raw as SkillhubLatestVersionPayload
}

async function fetchLegacyLatestRaw(slug: string): Promise<unknown> {
  return await fetchJson<unknown>(
    `/api/experts/${encodeURIComponent(slug)}/latest/`,
    undefined,
    'latest',
  )
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
  const items = await tryFallback(fetchSkillhubCatalog, fetchLegacyCatalog)
  catalogCache = { fetchedAt: Date.now(), items }
  return items
}

export function clearCatalogCache(): void {
  catalogCache = null
}

export async function fetchDetail(slug: string): Promise<ExpertDetail> {
  return await tryFallback(
    () => fetchSkillhubDetail(slug),
    () => fetchLegacyDetail(slug),
  )
}

export async function fetchLatest(slug: string): Promise<ExpertVersionMeta | null> {
  return await tryFallback(
    async () => normalizeVersionMeta(await fetchSkillhubLatestRaw(slug)),
    async () => normalizeVersionMeta(await fetchLegacyLatestRaw(slug)),
  )
}

export async function fetchManifest(
  slug: string,
  version: string,
): Promise<ExpertManifest> {
  try {
    const detail = await fetchSkillhubDetail(slug)
    const latest = await fetchSkillhubLatestRaw(slug)
    const latestVersion = normalizeVersionMeta(latest)
    if (!latestVersion) {
      throw new MarketplaceError(404, 'manifest', 'manifest 不存在')
    }
    if (latestVersion.version !== version) {
      throw new MarketplaceError(400, 'manifest', `新市场仅支持最新版本，当前最新为 ${latestVersion.version}`)
    }
    return requireManifest(latest.manifest_json, {
      slug: detail.slug,
      name: detail.name,
      kind: detail.kind,
      category: detail.category,
      summary: detail.summary,
      defaultLaunchTarget: detail.default_launch_target,
      version: latestVersion,
    })
  } catch (err) {
    if (!isNotFoundError(err)) {
      if (!(err instanceof MarketplaceError) || err.code !== 400) {
        throw err
      }
      throw err
    }
  }

  const legacy = await fetchJson<unknown>(
    `/api/experts/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/manifest/`,
    undefined,
    'manifest',
  )
  if (!isRecord(legacy)) {
    throw new MarketplaceError(404, 'manifest', 'manifest 不存在')
  }
  return requireManifest(legacy, {
    slug,
    name: '',
    kind: 'expert',
    category: '',
    summary: '',
    defaultLaunchTarget: 'chat',
    version: {
      version,
      artifact_sha256: '',
      artifact_size: 0,
      published_at: '',
    },
  })
}

export async function requestDownload(
  slug: string,
  version: string,
  clientId: string,
): Promise<DownloadGrant> {
  void clientId
  try {
    const latestRaw = await fetchSkillhubLatestRaw(slug)
    const latest = normalizeVersionMeta(latestRaw)
    if (!latest) {
      throw new MarketplaceError(404, 'download', '下载授权失败')
    }
    if (latest.version !== version) {
      throw new MarketplaceError(400, 'download', `新市场仅支持最新版本，当前最新为 ${latest.version}`)
    }
    const directUrl =
      asOptionalString(latestRaw.artifact_url)
      ?? `/api/skillhub/expert-catalog/${encodeURIComponent(slug)}/download/`
    return {
      download_url: absolutizeDownloadUrl(directUrl),
      sha256: latest.artifact_sha256,
      size: latest.artifact_size,
      expires_at: Date.now() + 10 * 60 * 1000,
      signature_algorithm: 'direct',
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      if (!(err instanceof MarketplaceError) || err.code !== 400) {
        throw err
      }
      throw err
    }
  }

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
