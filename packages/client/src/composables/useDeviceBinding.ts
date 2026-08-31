import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { setApiKey, hasApiKey } from '@/api/client'
import {
  fetchHermesDeviceBinding,
  restoreHermesDeviceLogin,
  type HermesDeviceBindingAccount,
  type HermesDeviceBindingStatus,
} from '@/api/device-login'

/**
 * Boot-time WeChat binding restore.
 *
 * A device may have several bound WeChat accounts (each with its own user and
 * personal agent profile). On later boots the login page can offer to restore
 * one of those sessions without requiring a new scan: it verifies the stored
 * api_key against the Token Platform and re-issues a Hermes JWT. With exactly
 * one bound account the restore is automatic; with several, the caller passes
 * the chosen `platform_profile_id`.
 */
export function useDeviceBinding() {
  const router = useRouter()
  const checking = ref(false)
  const binding = ref<HermesDeviceBindingStatus | null>(null)
  const hasBinding = ref(false)
  const accounts = ref<HermesDeviceBindingAccount[]>([])
  const restoring = ref(false)
  const restoreError = ref('')

  async function loadBinding() {
    checking.value = true
    try {
      binding.value = await fetchHermesDeviceBinding()
      hasBinding.value = binding.value?.bound === true
      accounts.value = binding.value?.accounts || []
    } catch {
      hasBinding.value = false
      accounts.value = []
    } finally {
      checking.value = false
    }
  }

  async function restore(platformProfileId?: number) {
    if (hasApiKey()) {
      router.replace('/hermes/chat')
      return
    }
    restoring.value = true
    restoreError.value = ''
    try {
      const result = await restoreHermesDeviceLogin(platformProfileId)
      setApiKey(result.token)
      router.replace('/hermes/chat')
    } catch (err: any) {
      restoreError.value = err?.message || 'Restore failed'
    } finally {
      restoring.value = false
    }
  }

  onMounted(() => {
    void loadBinding()
  })

  return {
    checking,
    binding,
    hasBinding,
    accounts,
    restoring,
    restoreError,
    restore,
  }
}
