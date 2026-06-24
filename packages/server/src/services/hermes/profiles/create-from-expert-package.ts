/**
 * profiles 服务扩展入口：_from_expert_package
 * - 不复用 createProfile（保持命名清晰）
 * - 幂等：同名 profile 已存在则覆盖预设内容（system prompt / avatar），
 *   不覆盖 user 自定义内容（config.yaml / env 凭据）
 */
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { createProfile, deleteProfile } from '../hermes-cli'
import { getProfileDir } from '../hermes-profile'

export interface CreateExpertProfileInput {
  profileName: string
  displayName: string
  expertSlug: string
  expertKind: 'expert' | 'team' | 'team-member'
  installedVersion: string
  sourceManifestPath: string
  systemPromptAbs: string
  avatarAbs?: string
  parentTeamSlug?: string
}

export interface CreateExpertProfileResult {
  profileName: string
  created: boolean
  updated: boolean
  profileDir: string
}

/**
 * 命名规则：
 * - 单专家：expert_<slug>
 * - 团长：expert_team_<slug>
 * - 成员：expert_member_<slug>
 */
export function buildExpertProfileName(
  expertKind: 'expert' | 'team' | 'team-member',
  slug: string,
): string {
  const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (expertKind === 'team') return `expert_team_${safe}`
  if (expertKind === 'team-member') return `expert_member_${safe}`
  return `expert_${safe}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function safeCopyFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
}

async function writeMarker(
  profileDir: string,
  manifest: CreateExpertProfileInput,
): Promise<void> {
  const marker = {
    source: 'expert_package',
    expert_slug: manifest.expertSlug,
    expert_kind: manifest.expertKind,
    installed_version: manifest.installedVersion,
    parent_team_slug: manifest.parentTeamSlug ?? '',
    manifest_path: manifest.sourceManifestPath,
    updated_at: Math.floor(Date.now() / 1000),
  }
  const dest = join(profileDir, 'expert-package.json')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(dest, JSON.stringify(marker, null, 2), 'utf8')
}

export async function createExpertProfile(
  input: CreateExpertProfileInput,
): Promise<CreateExpertProfileResult> {
  const existingDir = getProfileDir(input.profileName)
  const existed = await pathExists(existingDir)
  let created = false
  if (!existed) {
    await createProfile(input.profileName)
    created = true
  }
  const profileDir = getProfileDir(input.profileName)

  // 写入 system prompt（覆盖预设），不触碰 config.yaml / .env
  const systemMdDest = join(profileDir, 'SOUL.md')
  try {
    await fs.access(input.systemPromptAbs)
    await safeCopyFile(input.systemPromptAbs, systemMdDest)
  } catch {
    // 缺少 system prompt 不视为致命错误
  }

  // 写入 avatar（若包内提供）
  if (input.avatarAbs) {
    try {
      const dest = join(profileDir, 'avatar.png')
      await safeCopyFile(input.avatarAbs, dest)
    } catch {
      // ignore
    }
  }

  await writeMarker(profileDir, input)

  return {
    profileName: input.profileName,
    created,
    updated: !created,
    profileDir,
  }
}

export async function removeExpertProfile(profileName: string): Promise<boolean> {
  return deleteProfile(profileName)
}
