import { existsSync } from 'fs'
import { rename } from 'fs/promises'
import { deviceBindingFilePath, loadDeviceBinding } from './device-binding'
import { demoteLegacyWeChatSuperAdmins, findUserByUsername } from '../db/hermes/users-store'
import { findBindingByPlatformId, upsertBindingByPlatformId } from '../db/hermes/wechat-bindings-store'
import { logger } from './logger'

const MIGRATED_SUFFIX = '.migrated'

/**
 * One-time migration from the legacy single-owner device binding
 * (device-binding.json) to the per-WeChat-account `wechat_bindings` table.
 *
 * - Imports the legacy binding as a row keyed by the Token Platform user id.
 * - Demotes any legacy `tp_`-prefixed WeChat user that still holds the
 *   single-owner `super_admin` role: the multi-user model reserves super admin
 *   for the built-in `quanthermes` account.
 * - Renames the legacy file so the import never runs twice.
 *
 * Idempotent and safe to run on every boot.
 */
export async function migrateLegacyDeviceBinding(): Promise<void> {
  const legacyFile = deviceBindingFilePath()
  if (existsSync(legacyFile)) {
    try {
      const binding = await loadDeviceBinding()
      if (binding?.api_key && binding.api_base && binding.profile_id != null) {
        const existing = findBindingByPlatformId(binding.profile_id)
        if (!existing) {
          const localUsername = binding.username && binding.username.startsWith('tp_')
            ? binding.username
            : `tp_${binding.profile_id}`
          const user = findUserByUsername(localUsername)
          upsertBindingByPlatformId({
            userId: user?.id ?? null,
            platformProfileId: binding.profile_id,
            platformUsername: binding.username || '',
            apiBase: binding.api_base,
            apiKey: binding.api_key,
            deviceId: binding.device_id,
            models: binding.models || [],
            displayName: binding.display_name || '',
          })
          logger.info({ platformProfileId: binding.profile_id }, '[wechat-binding] legacy device binding imported')
        }
      }
    } catch (err) {
      logger.warn(err, '[wechat-binding] failed to import legacy device binding')
    }
    try {
      await rename(legacyFile, `${legacyFile}${MIGRATED_SUFFIX}`)
    } catch (err) {
      logger.warn(err, '[wechat-binding] failed to rename legacy device binding file')
    }
  }

  try {
    const demoted = demoteLegacyWeChatSuperAdmins()
    if (demoted > 0) {
      logger.info({ demoted }, '[wechat-binding] demoted legacy WeChat super admins')
    }
  } catch (err) {
    logger.warn(err, '[wechat-binding] failed to demote legacy WeChat super admins')
  }
}
