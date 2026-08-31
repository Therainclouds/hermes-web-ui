import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * 千问（DashScope）Realtime 模型统一配置。
 *
 * 这是会议模式 ASR 与 Realtime 对话共用的千问 API Key 的统一入口：在
 * “设置 → 模型 → Realtime 模型”里配置一次后，会议 ASR 与 Realtime 在
 * 未单独填写 DashScope Key 时会默认回落到这里，避免各场景重复粘贴 API Key。
 */
export interface RealtimeModelConfig {
  /** 千问/DashScope API Key（sk-...），供会议 ASR 与 Realtime 共用。 */
  apiKey: string
  /** Realtime 对话模型，默认 qwen3.5-omni-flash-realtime。 */
  model: string
  /** 默认语音（qwen3.5-omni-flash-realtime 目录内有效）。 */
  voice: string
}

const STORAGE_KEY = 'hermes.realtimeModel'

const DEFAULT_MODEL = 'qwen3.5-omni-flash-realtime'
const DEFAULT_VOICE = 'Tina'

function loadConfig(): RealtimeModelConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<RealtimeModelConfig>
      return {
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        model: typeof parsed.model === 'string' && parsed.model.trim()
          ? parsed.model.trim()
          : DEFAULT_MODEL,
        voice: typeof parsed.voice === 'string' && parsed.voice.trim()
          ? parsed.voice.trim()
          : DEFAULT_VOICE,
      }
    }
  } catch {}
  return { apiKey: '', model: DEFAULT_MODEL, voice: DEFAULT_VOICE }
}

function saveConfig(config: RealtimeModelConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {}
}

export const useRealtimeModelStore = defineStore('realtimeModel', () => {
  const config = ref<RealtimeModelConfig>(loadConfig())

  const hasApiKey = computed(() => !!config.value.apiKey.trim())

  function updateConfig(patch: Partial<RealtimeModelConfig>) {
    config.value = { ...config.value, ...patch }
    saveConfig(config.value)
  }

  return {
    config,
    hasApiKey,
    updateConfig,
  }
})
