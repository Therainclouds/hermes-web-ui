import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as hermesCli from './hermes-cli'
import { HermesSkillInjector } from './skill-injector'
import { AgentBridgeClient } from './agent-bridge'
import { prepareGatewayForProfileDelete } from './gateway-autostart'
import {
  profileMetadataDir,
  setProfileAvatarGenerated,
  setProfileAvatarRemote,
  setProfileDisplayName,
} from './profile-metadata'
import { detectHermesRootHome } from './hermes-path'
import { getActiveProfileName } from './hermes-profile'
import { updateConfigYamlForProfile } from '../config-helpers'
import { logger } from '../logger'

/**
 * Per-WeChat-user provisioning: every bound WeChat account owns a dedicated
 * Hermes agent profile (`u_<TokenPlatform user id>`) that isolates its agent,
 * sessions and Token Platform api_key from every other user. `default` stays
 * super-admin-only and is never shared with WeChat users.
 */

const TOKEN_PLATFORM_PROVIDER_NAME = 'token_platform'

export function personalProfileNameFor(platformProfileId: number): string {
  return `u_${platformProfileId}`
}

export function personalProfileDirExists(profileName: string): boolean {
  return existsSync(join(detectHermesRootHome(), 'profiles', profileName))
}

async function syncBundledSkills(profileName: string): Promise<void> {
  try {
    const targetDir = HermesSkillInjector.resolveTargetDirForProfile(profileName)
    await new HermesSkillInjector(undefined, targetDir).injectMissingSkills()
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to sync bundled skills for profile "%s"', profileName)
  }
}

function applyProfileIdentity(profileName: string, displayName: string, avatarUrl?: string | null): void {
  try {
    setProfileDisplayName(profileName, displayName)
    if (avatarUrl) {
      setProfileAvatarRemote(profileName, avatarUrl)
    } else {
      setProfileAvatarGenerated(profileName, displayName)
    }
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to write identity metadata for profile "%s"', profileName)
  }
}

/**
 * Write (or refresh) the user's own Token Platform custom provider entry into
 * their personal profile's config.yaml so each WeChat account calls the relay
 * with its own api_key. Provider config is profile-scoped, which keeps keys
 * isolated between users.
 */
export async function applyTokenPlatformProvider(
  profileName: string,
  apiBase: string,
  apiKey: string,
  models: string[],
): Promise<boolean> {
  const model = models[0] || ''
  if (!model) {
    logger.warn('[wechat-provision] no model available; skipping provider config for profile "%s"', profileName)
    return false
  }
  try {
    await updateConfigYamlForProfile(profileName, (config) => {
      if (typeof config.model !== 'object' || config.model === null) config.model = {}
      if (!Array.isArray(config.custom_providers)) config.custom_providers = []
      const existing = (config.custom_providers as any[]).find(
        (entry: any) => `custom:${entry?.name}` === `custom:${TOKEN_PLATFORM_PROVIDER_NAME}`,
      )
      if (existing) {
        existing.base_url = apiBase
        existing.api_key = apiKey
        existing.model = model
      } else {
        config.custom_providers.push({
          name: TOKEN_PLATFORM_PROVIDER_NAME,
          base_url: apiBase,
          api_key: apiKey,
          model,
        })
      }
      config.model.default = model
      config.model.provider = `custom:${TOKEN_PLATFORM_PROVIDER_NAME}`
      delete config.model.base_url
      delete config.model.api_key
      return config
    })
    return true
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to write token_platform provider for profile "%s"', profileName)
    return false
  }
}

export interface PersonalWorkspaceInput {
  userId: number
  platformProfileId: number
  displayName: string
  avatarUrl?: string | null
  apiBase?: string
  apiKey?: string
  models?: string[]
}

/**
 * Ensure the WeChat user has their personal agent profile: create it on disk
 * when missing, bind it to the user, sync the WeChat identity onto it, and
 * (when credentials are given) point its token_platform provider at the user's
 * own api_key. Returns the profile name, or null when provisioning failed —
 * callers must not fail the login itself in that case.
 */
export async function ensurePersonalWorkspace(input: PersonalWorkspaceInput): Promise<string | null> {
  const profileName = personalProfileNameFor(input.platformProfileId)
  try {
    if (!personalProfileDirExists(profileName)) {
      await hermesCli.createProfile(profileName)
      if (!personalProfileDirExists(profileName)) {
        logger.warn('[wechat-provision] profile "%s" missing after create', profileName)
        return null
      }
      await syncBundledSkills(profileName)
    }
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to create personal profile "%s"', profileName)
    return null
  }

  applyProfileIdentity(profileName, input.displayName, input.avatarUrl)

  if (input.apiBase && input.apiKey) {
    await applyTokenPlatformProvider(profileName, input.apiBase, input.apiKey, input.models || [])
  }

  return profileName
}

function removeProfileMetadata(profileName: string): void {
  try {
    rmSync(profileMetadataDir(profileName), { recursive: true, force: true })
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to remove metadata for profile "%s"', profileName)
  }
}

/**
 * Delete a profile's disk footprint (sessions, config, provider credentials)
 * the same way the profiles controller does: destroy bridge sessions, stop the
 * gateway runtime, run the Hermes CLI delete, then clean Web-UI metadata.
 * `default` is never deleted here — it is owned by the super administrator.
 */
export async function deleteProfileFromDisk(profileName: string): Promise<boolean> {
  if (!profileName || profileName === 'default') return false
  try {
    const bridge = new AgentBridgeClient({ connectRetryMs: 0, timeoutMs: 5000 })
    await bridge.destroyProfile(profileName)
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to destroy bridge sessions for profile "%s"', profileName)
  }
  try {
    await prepareGatewayForProfileDelete(profileName)
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to prepare gateway for profile delete "%s"', profileName)
  }
  const ok = await hermesCli.deleteProfile(profileName)
  if (ok && !personalProfileDirExists(profileName)) {
    removeProfileMetadata(profileName)
    try {
      if (getActiveProfileName() === profileName) {
        writeFileSync(join(detectHermesRootHome(), 'active_profile'), 'default\n', 'utf-8')
      }
    } catch {}
    return true
  }
  if (ok) {
    logger.warn('[wechat-provision] profile "%s" directory still exists after delete', profileName)
    return false
  }
  return false
}
