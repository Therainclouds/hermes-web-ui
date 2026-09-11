/**
 * Knowledge plugin — settings composable.
 *
 * Manages embedding API key state, validation, and persistence.
 */
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import * as api from '../api'
import type { KnowledgeSettings } from '../api'
import { useMessage } from '@/composables/useAppMessage'
import { isValidApiKey, validateApiKey } from '../utils/validate'

export function useKnowledgeSettings() {
  const { t } = useI18n()
  const message = useMessage()

  const settings = shallowRef<KnowledgeSettings | null>(null)
  const apiKeyInput = ref('')
  const savingKey = ref(false)
  let generation = 0
  let disposed = false

  const validationError = computed(() => {
    if (!apiKeyInput.value.trim()) return null
    return validateApiKey(apiKeyInput.value)
  })

  const canSave = computed(() => {
    return apiKeyInput.value.trim().length >= 8 && validationError.value === null && !savingKey.value
  })

  async function load(): Promise<void> {
    const gen = ++generation
    try {
      const res = await api.getSettings()
      if (!disposed && gen === generation) {
        settings.value = res
      }
    } catch {
      if (!disposed && gen === generation) {
        settings.value = null
      }
    }
  }

  async function save(): Promise<void> {
    const key = apiKeyInput.value.trim()
    if (!isValidApiKey(key)) {
      message.error(t('knowledge.settings.saveFailed'))
      return
    }
    savingKey.value = true
    try {
      const res = await api.saveApiKey(key)
      apiKeyInput.value = ''
      if (res.reinitError) {
        message.warning(res.reinitError)
      } else if (!res.enabled) {
        message.warning(t('knowledge.settings.pluginDisabled'))
      } else if (res.initialized) {
        message.success(t('knowledge.settings.saved'))
      } else {
        message.warning(t('knowledge.settings.savedButNotInitialized'))
      }
      await load()
    } catch {
      message.error(t('knowledge.settings.saveFailed'))
    } finally {
      savingKey.value = false
    }
  }

  function clearInput(): void {
    apiKeyInput.value = ''
  }

  onBeforeUnmount(() => {
    disposed = true
  })

  return {
    settings,
    apiKeyInput,
    savingKey,
    validationError,
    canSave,
    load,
    save,
    clearInput,
  }
}