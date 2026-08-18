import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { setApiKey, hasApiKey } from '@/api/client'
import {
  fetchHermesDeviceBinding,
  restoreHermesDeviceLogin,
  unbindHermesDevice,
  type HermesDeviceBindingStatus,
} from '@/api/device-login'

/**
 * Boot-time Token Platform binding restore.
 *
 * A device that previously completed a WeChat scan has a persisted server-side
 * binding. On later boots the login page can offer to restore that session
 * without requiring a new scan: it verifies the stored api_key against the
 * Token Platform and re-issues a Hermes JWT.
 */
export function useDeviceBinding() {
  const router = useRouter()
  const checking = ref(false)
  const binding = ref<HermesDeviceBindingStatus | null>(null)
  const hasBinding = ref(false)
  const restoring = ref(false)
  const restoreError = ref('')

  async function loadBinding() {
    checking.value = true
    try {
      binding.value = await fetchHermesDeviceBinding()
      hasBinding.value = binding.value?.bound === true
    } catch {
      hasBinding.value = false
    } finally {
      checking.value = false
    }
  }

  async function restore() {
    if (hasApiKey()) {
      router.replace('/hermes/chat')
      return
    }
    restoring.value = true
    restoreError.value = ''
    try {
      const result = await restoreHermesDeviceLogin()
      setApiKey(result.token)
      router.replace('/hermes/chat')
    } catch (err: any) {
      restoreError.value = err?.message || 'Restore failed'
    } finally {
      restoring.value = false
    }
  }

  async function unbind() {
    const result = await unbindHermesDevice()
    // Forget the local binding state so the restore/unbind buttons disappear.
    binding.value = null
    hasBinding.value = false
    return result
  }

  onMounted(() => {
    void loadBinding()
  })

  return {
    checking,
    binding,
    hasBinding,
    restoring,
    restoreError,
    restore,
    unbind,
  }
}
