/**
 * 专家系统本地入口编排：把 installer + activator 串起来
 */
import { join } from 'path'
import { promises as fs } from 'fs'
import {
  installExpertPackage,
  InstallError,
  uninstallExpertPackage,
} from './installer'
import { activateFromInstallDir, deactivateExpert } from './activator'
import {
  deleteInstalledExpertsByTeam,
  deleteBindingByProfile,
  deleteBindingsByExpert,
  deleteInstalledExpert,
  getInstalledExpert,
  listBindings,
  listBindingsByExpert,
  listBindingsByParentTeam,
  listInstalledExperts,
  upsertBinding,
  upsertInstalledExpert,
} from '../../../db/hermes/experts-store'
import { fetchCatalog, fetchDetail, fetchManifest, type ExpertManifest } from './marketplace-client'
import { buildExpertProfileName } from '../profiles/create-from-expert-package'
import { loadExpertsMarketplaceConfig } from './config'

export async function listLocalInstalled() {
  const items = listInstalledExperts()
  const bindings = listBindings()
  return {
    installed_experts: items,
    bindings,
  }
}

export async function installExpertFlow(input: {
  slug: string
  version: string
  clientId: string
}) {
  const { slug, version, clientId } = input
  const installResult = await installExpertPackage(slug, version, clientId)
  const activation = await activateFromInstallDir(
    slug,
    version,
    installResult.installDir,
    installResult.manifest,
    clientId,
  )

  // 只有"至少一个 profile 激活成功"才标记 installed；否则一律 failed
  const allOk = activation.failed.length === 0 && activation.installed.length > 0
  if (allOk) {
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'installed',
      last_error: '',
      last_error_stage: '',
    })
  } else {
    const reason = activation.failed.length > 0
      ? `${activation.failed.length} profile(s) failed: ${activation.failed
          .map(f => `${f.slug}=${f.reason}`)
          .slice(0, 3)
          .join('; ')}`
      : 'no profile activated'
    upsertInstalledExpert({
      expert_slug: slug,
      installed_version: version,
      status: 'failed',
      last_error: reason.slice(0, 500),
      last_error_stage: 'activate',
    })
  }

  return {
    installed_expert: {
      slug,
      version,
      status: allOk ? 'installed' : 'failed',
    },
    installed: activation.installed,
    failed: activation.failed,
  }
}

export async function upgradeExpertFlow(input: { slug: string; clientId: string }) {
  const { slug, clientId } = input
  const detail = await fetchDetail(slug)
  const latest = detail.latest_version
  if (!latest) {
    throw new InstallError('download', '无已发布版本', 404)
  }
  const existing = getInstalledExpert(slug)
  if (existing && existing.installed_version === latest.version) {
    return {
      installed_expert: { slug, version: latest.version, status: 'installed' },
      skipped: true,
      reason: '已是最新版本',
    }
  }
  return await installExpertFlow({ slug, version: latest.version, clientId })
}

export async function uninstallExpertFlow(input: { slug: string }) {
  const { slug } = input
  const directBindings = listBindingsByExpert(slug)
  const memberBindings = listBindingsByParentTeam(slug)
  const bindings = [...directBindings, ...memberBindings]
  const profileNames = Array.from(new Set(bindings.map(b => b.profile_name)))
  const memberSlugs = Array.from(new Set(memberBindings.map(b => b.expert_slug).filter(Boolean)))
  // eslint-disable-next-line no-console
  console.log('[experts.uninstall] profiles to remove:', profileNames)

  const removed = await deactivateExpert(slug, profileNames)
  // eslint-disable-next-line no-console
  if (removed.failed.length > 0) console.warn('[experts.uninstall] failed to remove profiles:', removed.failed)

  for (const name of profileNames) {
    deleteBindingByProfile(name)
  }
  deleteBindingsByExpert(slug)
  for (const memberSlug of memberSlugs) {
    deleteBindingsByExpert(memberSlug)
    await uninstallExpertPackage(memberSlug)
    deleteInstalledExpert(memberSlug)
  }
  deleteInstalledExpertsByTeam(slug)
  const diskCleanup = await uninstallExpertPackage(slug)
  deleteInstalledExpert(slug)
  return {
    removed_profiles: removed.removed,
    failed_profiles: removed.failed,
    disk_removed: diskCleanup.removed,
  }
}

export async function previewExpertManifest(slug: string, version: string) {
  return await fetchManifest(slug, version)
}

export function getLocalCatalog() {
  // 优先读云端 catalog；为简化，controller 直接调 fetchCatalog
  return fetchCatalog()
}

export async function getLocalDetail(slug: string) {
  return await fetchDetail(slug)
}

export async function getLocalManifest(slug: string, version: string): Promise<ExpertManifest> {
  return await fetchManifest(slug, version)
}

// 给前端展示本地绑定统计
export function summarizeBindings() {
  const list = listBindings()
  const map: Record<string, { count: number; roles: Record<string, number> }> = {}
  for (const b of list) {
    const key = b.parent_team_slug || b.expert_slug
    if (!map[key]) map[key] = { count: 0, roles: {} }
    map[key].count += 1
    map[key].roles[b.role] = (map[key].roles[b.role] || 0) + 1
  }
  return map
}

export function buildProfileNameForExpert(
  role: 'expert' | 'captain' | 'member',
  slug: string,
) {
  return buildExpertProfileName(
    role === 'captain' ? 'team' : role === 'member' ? 'team-member' : 'expert',
    slug,
  )
}

export function isExpertProfileName(name: string): boolean {
  return /^expert_(team_|member_)?[a-zA-Z0-9_-]+$/.test(name)
}

export function getInstalledExpertRow(slug: string) {
  return getInstalledExpert(slug)
}

export function getMarketplaceConfigSummary() {
  const cfg = loadExpertsMarketplaceConfig()
  return {
    baseUrl: cfg.baseUrl,
    cacheTtlSeconds: cfg.cacheTtlSeconds,
    localPackagesRoot: cfg.localPackagesRoot,
    clientIdTemplate: cfg.clientIdTemplate,
    maxPackageBytes: cfg.maxPackageBytes,
  }
}

export function listBindingProfiles() {
  return listBindings()
}

export async function assertManifestReadable(installDir: string) {
  const manifestPath = join(installDir, 'manifest.json')
  const raw = await fs.readFile(manifestPath, 'utf8')
  return JSON.parse(raw) as ExpertManifest
}
