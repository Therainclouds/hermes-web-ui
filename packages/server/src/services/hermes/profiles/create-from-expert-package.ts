/**
 * profiles 服务扩展入口：_from_expert_package
 * - 不复用 createProfile（保持命名清晰）
 * - 幂等：同名 profile 已存在则覆盖预设内容（system prompt / avatar），
 *   不覆盖 user 自定义内容（config.yaml / env 凭据）
 */
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { createProfile, deleteProfile } from '../hermes-cli'
import { detectHermesRootHome } from '../hermes-path'
import {
  readConfigYamlForProfile,
} from '../../config-helpers'
import { getActiveProfileName, getProfileDir } from '../hermes-profile'
import yaml from 'js-yaml'

function profileDir(name: string): string {
  const base = detectHermesRootHome()
  if (!name || name === 'default') return base
  return join(base, 'profiles', name)
}

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
    display_name: manifest.displayName,
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
  const dir = profileDir(input.profileName)
  const existed = await pathExists(dir)
  let created = false
  if (!existed) {
    await createProfile(input.profileName)
    created = true
  }
  const profileDirPath = profileDir(input.profileName)

  // 写入 system prompt（覆盖预设），不触碰 config.yaml / .env
  const systemMdDest = join(profileDirPath, 'SOUL.md')
  try {
    await fs.access(input.systemPromptAbs)
    await safeCopyFile(input.systemPromptAbs, systemMdDest)
  } catch {
    // 缺少 system prompt 不视为致命错误
  }

  // 写入 avatar（若包内提供）
  if (input.avatarAbs) {
    try {
      const dest = join(profileDirPath, 'avatar.png')
      await safeCopyFile(input.avatarAbs, dest)
    } catch {
      // ignore
    }
  }

  await writeMarker(profileDirPath, input)

  // Q2: 复制当前激活 profile 的 default model/provider 到专家 profile
  await copyModelFromActiveProfile(input.profileName)

  return {
    profileName: input.profileName,
    created,
    updated: !created,
    profileDir: profileDirPath,
  }
}

/**
 * 将 default profile 的 model.default / model.provider 写入目标 profile 的 config.yaml
 * - 来源优先级：default profile > PROVIDER_PRESETS 兜底（首个有模型的 provider）
 * - 不论 active 是否 == target，都强制复制，保证新建专家始终有模型
 */
async function copyModelFromActiveProfile(targetProfile: string): Promise<void> {
  try {
    const defaultCfg = await readConfigYamlForProfile('default')
    // eslint-disable-next-line no-console
    console.log('[experts.copyModel] target=', targetProfile, 'defaultCfg.model=', JSON.stringify(defaultCfg?.model || {}))
    const modelSection = defaultCfg?.model
    let defaultModel = ''
    let defaultProvider = ''
    if (typeof modelSection === 'object' && modelSection !== null) {
      defaultModel = String(modelSection.default || '').trim()
      defaultProvider = String(modelSection.provider || '').trim()
    } else if (typeof modelSection === 'string') {
      defaultModel = modelSection.trim()
    }
    // 兜底：从 PROVIDER_PRESETS 取第一个有模型的 provider
    if (!defaultModel || !defaultProvider) {
      const fallback = await loadFirstProviderPreset()
      if (fallback) {
        defaultProvider = defaultProvider || fallback.provider
        defaultModel = defaultModel || fallback.model
        // eslint-disable-next-line no-console
        console.log('[experts.copyModel] using PROVIDER_PRESETS fallback:', defaultProvider, defaultModel)
      }
    }
    if (!defaultModel || !defaultProvider) {
      // eslint-disable-next-line no-console
      console.log('[experts.copyModel] skipped: no model/provider available in default or presets')
      return
    }
    const configPath = join(detectHermesRootHome(), 'profiles', targetProfile, 'config.yaml')
    // eslint-disable-next-line no-console
    console.log('[experts.copyModel] writing to path=', configPath)
    // 直接读现有 config，合并 model 段，然后整个 yaml.dump 后 writeFile（避免 updateYaml 链路问题）
    let existing: Record<string, any> = {}
    try {
      const raw = await fs.readFile(configPath, 'utf-8')
      const parsed = yaml.load(raw, { json: true }) as Record<string, any> | null
      if (parsed && typeof parsed === 'object') existing = parsed
    } catch {
      // 文件不存在或解析失败，使用空对象
    }
    const existingModelSection = (existing.model && typeof existing.model === 'object' && !Array.isArray(existing.model))
      ? existing.model
      : {}
    existingModelSection.default = defaultModel
    existingModelSection.provider = defaultProvider
    existing.model = existingModelSection
    const yamlStr = yaml.dump(existing, { lineWidth: -1, noRefs: true })
    await fs.mkdir(dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, yamlStr, 'utf-8')
    // eslint-disable-next-line no-console
    console.log('[experts.copyModel] written yaml=\n', yamlStr)

    // 复制 default profile 的 .env（API key / 凭证）——没有 .env 则 buildAvailableForProfile
    // 会因 envHasValue(apiKeyEnv) === false 而跳过该 provider，导致前端显示"无可用"
    // 注意：getProfileDir('default') == hermesBase（不在 profiles/default 下）
    const defaultEnvPath = join(getProfileDir('default'), '.env')
    const targetEnvPath = join(dirname(configPath), '.env')
    try {
      const envContent = await fs.readFile(defaultEnvPath, 'utf-8')
      if (envContent && envContent.trim()) {
        await fs.writeFile(targetEnvPath, envContent, 'utf-8')
        // eslint-disable-next-line no-console
        console.log('[experts.copyModel] copied .env from default to', targetEnvPath)
      } else {
        // eslint-disable-next-line no-console
        console.log('[experts.copyModel] default .env is empty, skip copy')
      }
    } catch (envErr) {
      // eslint-disable-next-line no-console
      console.warn('[experts.copyModel] default .env not found, skip copy:', envErr)
    }

    // eslint-disable-next-line no-console
    console.log('[experts.copyModel] done: copied default=', defaultModel, 'provider=', defaultProvider, 'to=', targetProfile)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[experts.copyModel] failed', err)
  }
}

async function loadFirstProviderPreset(): Promise<{ provider: string; model: string } | null> {
  try {
    const { PROVIDER_PRESETS } = await import('../../../shared/providers')
    for (const preset of PROVIDER_PRESETS) {
      if (preset.models && preset.models.length > 0) {
        return { provider: preset.value, model: preset.models[0] }
      }
    }
  } catch {
    // ignore
  }
  return null
}

export async function removeExpertProfile(profileName: string): Promise<boolean> {
  // 先尝试 Hermes CLI 删除
  const cliOk = await deleteProfile(profileName)
  // 无论 CLI 是否成功，强制清理目录（CLI 可能漏删或 profile 处于 active 状态）
  const dir = profileDir(profileName)
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // 目录不存在或无权访问均不视为失败
  }
  return cliOk
}
