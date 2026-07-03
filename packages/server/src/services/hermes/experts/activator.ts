/**
 * 专家市场 - 激活器
 * install 完成后调用，把 installDir 内的 manifest 转换为 expert profile
 * - 单专家：创建 1 个 expert_<slug> profile
 * - 专家团：递归拉成员 -> 创建团长 + N 个成员 profile
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { fetchDetail, fetchLatest, type ExpertManifest } from './marketplace-client'
import { InstallError, installExpertPackage } from './installer'
import {
  upsertBinding,
  upsertInstalledExpert,
  type ExpertRole,
} from '../../../db/hermes/experts-store'
import {
  buildExpertProfileName,
  createExpertProfile,
  removeExpertProfile,
} from '../profiles/create-from-expert-package'

export interface ActivateItem {
  slug: string
  profile_name: string
  role: ExpertRole
  parent_team_slug?: string
  created: boolean
  updated: boolean
}

export interface ActivateResult {
  installed: ActivateItem[]
  failed: Array<{ slug: string; reason: string }>
}

async function safePath(installDir: string, rel: string): Promise<string> {
  return join(installDir, rel)
}

async function activateOne(
  slug: string,
  version: string,
  installDir: string,
  manifest: ExpertManifest,
  role: ExpertRole,
  parentTeamSlug?: string,
): Promise<ActivateItem> {
  const profileName = buildExpertProfileName(
    role === 'captain' ? 'team' : role === 'member' ? 'team-member' : 'expert',
    slug,
  )
  const systemPromptAbs = await safePath(
    installDir,
    manifest.profileTemplate.systemPromptPath,
  )
  const avatarAbs = await safePath(installDir, manifest.profileTemplate.avatarPath).catch(() => '')

  const result = await createExpertProfile({
    profileName,
    displayName: manifest.profileTemplate.displayName,
    expertSlug: slug,
    expertKind: role === 'captain' ? 'team' : role === 'member' ? 'team-member' : 'expert',
    installedVersion: version,
    sourceManifestPath: join(installDir, 'manifest.json'),
    systemPromptAbs,
    avatarAbs: avatarAbs || undefined,
    parentTeamSlug,
  })

  upsertBinding({
    expert_slug: slug,
    profile_name: profileName,
    role,
    parent_team_slug: parentTeamSlug ?? '',
    installed_version: version,
  })

  return {
    slug,
    profile_name: result.profileName,
    role,
    parent_team_slug: parentTeamSlug,
    created: result.created,
    updated: result.updated,
  }
}

export async function activateFromInstallDir(
  slug: string,
  version: string,
  installDir: string,
  manifest: ExpertManifest,
  clientId?: string,
): Promise<ActivateResult> {
  const out: ActivateResult = { installed: [], failed: [] }

  if (manifest.expert.kind === 'expert') {
    try {
      const item = await activateOne(slug, version, installDir, manifest, 'expert')
      out.installed.push(item)
    } catch (err) {
      out.failed.push({ slug, reason: err instanceof Error ? err.message : 'activate failed' })
    }
    return out
  }

  // expert.kind === 'team' : 团长 + 成员
  try {
    const captainItem = await activateOne(slug, version, installDir, manifest, 'captain')
    out.installed.push(captainItem)
  } catch (err) {
    out.failed.push({ slug, reason: err instanceof Error ? err.message : 'captain activate failed' })
    return out
  }

  // 拉 team.members，按成员独立安装
  let members: Array<{ slug: string; name: string; role_name: string; sort_order: number; is_captain: boolean; latest_version: string | null }> = []
  try {
    const detail = await fetchDetail(slug)
    members = (detail.team_members || []).filter(m => !m.is_captain)
  } catch (err) {
    out.failed.push({ slug, reason: 'fetch team members failed: ' + (err instanceof Error ? err.message : 'unknown') })
    return out
  }

  for (const m of members) {
    let memberVersion = m.latest_version
    if (!memberVersion) {
      try {
        memberVersion = (await fetchLatest(m.slug))?.version ?? null
      } catch (err) {
        out.failed.push({ slug: m.slug, reason: err instanceof Error ? err.message : 'fetch member latest failed' })
        continue
      }
    }
    if (!memberVersion) {
      out.failed.push({ slug: m.slug, reason: 'member has no published version' })
      continue
    }
    try {
      if (!clientId) {
        throw new InstallError('download', 'team member install requires clientId', 400)
      }
      const memberInstall = await installExpertPackage(m.slug, memberVersion, clientId)
      const item = await activateOne(
        m.slug,
        memberVersion,
        memberInstall.installDir,
        memberInstall.manifest,
        'member',
        slug,
      )
      out.installed.push(item)
      upsertInstalledExpert({
        expert_slug: m.slug,
        installed_version: memberVersion,
        status: 'installed',
        local_path: memberInstall.installDir,
        manifest_json: JSON.stringify(memberInstall.manifest),
        team_slug: slug,
      })
    } catch (err) {
      upsertInstalledExpert({
        expert_slug: m.slug,
        installed_version: memberVersion,
        status: 'failed',
        last_error: err instanceof Error ? err.message : 'member activate failed',
        last_error_stage: err instanceof InstallError ? err.stage : 'activate',
        team_slug: slug,
      })
      out.failed.push({ slug: m.slug, reason: err instanceof Error ? err.message : 'member activate failed' })
    }
  }
  return out
}

export async function deactivateExpert(
  slug: string,
  profileNames: string[],
): Promise<{ removed: number; failed: string[] }> {
  let removed = 0
  const failed: string[] = []
  for (const name of profileNames) {
    try {
      const ok = await removeExpertProfile(name)
      if (ok) removed += 1
    } catch (err) {
      failed.push(name)
    }
  }
  return { removed, failed }
  // 静默 use，避免引入额外未使用变量告警
  void fs
}
