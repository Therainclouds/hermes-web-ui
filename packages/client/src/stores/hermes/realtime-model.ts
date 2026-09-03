import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import * as realtimeModelApi from '@/api/hermes/realtime-model'
import { useProfilesStore } from './profiles'

/**
 * 千问（DashScope）Realtime 模型统一配置。
 *
 * 这是会议模式 ASR 与 Realtime 对话共用的千问 API Key 的统一入口：在
 * “设置 → 模型 → Realtime 模型”里配置一次后，会议 ASR 与 Realtime 在
 * 未单独填写 DashScope Key 时会默认回落到这里，避免各场景重复粘贴 API Key。
 *
 * 配置持久化在当前用户 Profile（服务端，按 Hermes profile 一行保存），与
 * STT/TTS 等模型设置一致；浏览器 localStorage 只作为离线/首帧缓存，并负责
 * 把升级前旧的浏览器配置一次性迁移到服务端 Profile。
 */
export interface RealtimeModelConfig {
  /** 千问/DashScope API Key（sk-...），供会议 ASR 与 Realtime 共用。 */
  apiKey: string
  /** Realtime 对话模型，默认 qwen3.5-omni-flash-realtime。 */
  model: string
  /** 默认语音（qwen3.5-omni-flash-realtime 目录内有效）。 */
  voice: string
}

/**
 * Per-model turn / duration limits from the Bailian docs
 * (https://help.aliyun.com/zh/model-studio/qwen-omni-realtime). The UI uses
 * these to surface a banner before the user starts a session that will hit
 * the cap mid-conversation. Single session hard ceiling (120 minutes) is the
 * same for every model and is exposed separately.
 */
export interface RealtimeModelLimits {
  /** Maximum audio turns the model keeps in context before older turns drop. */
  audioTurns: number | null
  /** Maximum video turns the model keeps in context. */
  videoTurns: number | null
  /** Maximum cumulative audio duration in seconds the model keeps. */
  audioSeconds: number | null
  /** Maximum cumulative video duration in seconds. */
  videoSeconds: number | null
  /** Short human-readable label for the UI banner. */
  label: string
}

const STORAGE_KEY = 'hermes.realtimeModel'

const DEFAULT_MODEL = 'qwen3.5-omni-flash-realtime'
const DEFAULT_VOICE = 'Tina'

/** Per-model limits from the Bailian docs (https://help.aliyun.com/zh/model-studio/qwen-omni-realtime). */
const MODEL_LIMITS: Record<string, RealtimeModelLimits> = {
  'qwen3.5-omni-plus-realtime': {
    audioTurns: 100, videoTurns: 50, audioSeconds: 600, videoSeconds: 240,
    label: 'qwen3.5-omni-plus-realtime',
  },
  'qwen3.5-omni-flash-realtime': {
    audioTurns: 80, videoTurns: 50, audioSeconds: 480, videoSeconds: 120,
    label: 'qwen3.5-omni-flash-realtime',
  },
  'qwen3-omni-flash-realtime': {
    audioTurns: 8, videoTurns: 8, audioSeconds: null, videoSeconds: null,
    label: 'qwen3-omni-flash-realtime',
  },
}

/** Single-session hard ceiling (every Omni-Realtime model). */
export const OMNI_REALTIME_MAX_SESSION_SECONDS = 120 * 60

export function getRealtimeModelLimits(model: string): RealtimeModelLimits | null {
  return MODEL_LIMITS[model] ?? null
}

function normalizeConfig(partial?: Partial<RealtimeModelConfig> | null): RealtimeModelConfig {
  return {
    apiKey: typeof partial?.apiKey === 'string' ? partial.apiKey : '',
    model: typeof partial?.model === 'string' && partial.model.trim()
      ? partial.model.trim()
      : DEFAULT_MODEL,
    voice: typeof partial?.voice === 'string' && partial.voice.trim()
      ? partial.voice.trim()
      : DEFAULT_VOICE,
  }
}

/**
 * Local cache entry. `profile === null` marks a pre-profile-era entry (v1,
 * whole-object config) that has not yet been attributed to a profile — it is
 * the source for the one-time migration into the active profile's server row.
 */
interface CachedRealtimeModelConfig {
  v: 2
  profile: string | null
  config: RealtimeModelConfig
}

function readCache(): CachedRealtimeModelConfig | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return null
    const parsed = JSON.parse(saved) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      if (parsed.v === 2 && parsed.config && typeof parsed.config === 'object') {
        return {
          v: 2,
          profile: typeof parsed.profile === 'string' ? parsed.profile : null,
          config: normalizeConfig(parsed.config as Partial<RealtimeModelConfig>),
        }
      }
      // v1 legacy entry: the whole stored object is the config.
      return { v: 2, profile: null, config: normalizeConfig(parsed as Partial<RealtimeModelConfig>) }
    }
  } catch {}
  return null
}

function writeCache(config: RealtimeModelConfig, profile: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, profile, config }))
  } catch {}
}

function configHasContent(config: RealtimeModelConfig): boolean {
  return config.apiKey.trim() !== '' || config.model !== DEFAULT_MODEL || config.voice !== DEFAULT_VOICE
}

export const useRealtimeModelStore = defineStore('realtimeModel', () => {
  const config = ref<RealtimeModelConfig>(normalizeConfig(readCache()?.config))
  const loading = ref(false)

  const hasApiKey = computed(() => !!config.value.apiKey.trim())
  const limits = computed<RealtimeModelLimits | null>(() =>
    getRealtimeModelLimits(config.value.model),
  )

  /** Profile whose server row is currently reflected in `config`. */
  let loadedProfile: string | null = null
  /** True once a server load succeeded for the current profile. */
  let lastLoadOk = false
  let inFlight: Promise<void> | null = null
  let generation = 0
  const migratedProfiles = new Set<string>()
  let saveSeq = 0

  function currentProfileName(): string | null {
    const profilesStore = useProfilesStore()
    return profilesStore.activeProfileName ?? profilesStore.activeProfile?.name ?? null
  }

  function applyServerSetting(
    setting: realtimeModelApi.RealtimeModelServerSetting | null,
    profileName: string,
  ): Promise<void> {
    if (setting) {
      config.value = {
        apiKey: typeof setting.secrets?.apiKey === 'string' ? setting.secrets.apiKey : '',
        model: typeof setting.settings?.model === 'string' && setting.settings.model.trim()
          ? setting.settings.model.trim()
          : DEFAULT_MODEL,
        voice: typeof setting.settings?.voice === 'string' && setting.settings.voice.trim()
          ? setting.settings.voice.trim()
          : DEFAULT_VOICE,
      }
      writeCache(config.value, profileName)
      return Promise.resolve()
    }

    // No server row for this profile yet. Migrate a browser-only config into
    // the profile once (legacy entries with `profile === null` or entries
    // already attributed to this profile), so existing keys survive the move
    // from localStorage to the profile.
    const cache = readCache()
    const legacy = cache && (cache.profile === null || cache.profile === profileName)
    if (legacy && !migratedProfiles.has(profileName) && configHasContent(cache.config)) {
      migratedProfiles.add(profileName)
      const content = cache.config
      return realtimeModelApi.saveRealtimeModelSetting({
        settings: { model: content.model, voice: content.voice },
        secrets: { apiKey: content.apiKey },
      }).then(() => {
        writeCache(content, profileName)
      }).catch((err) => {
        // Migration is best-effort; the browser cache keeps working meanwhile.
        console.warn('[realtime-model] failed to migrate browser config into profile:', err)
      })
    }
    return Promise.resolve()
  }

  /**
   * Load the active profile's realtime model config from the server. Deduped
   * per profile; passes `force: true` to refresh after the profile changes or
   * when a settings panel opens.
   */
  async function loadFromServer(profileNameArg?: string | null, options?: { force?: boolean }): Promise<void> {
    const force = options?.force === true
    const profileName = profileNameArg ?? currentProfileName()
    if (!profileName) return
    if (!force && loadedProfile === profileName && lastLoadOk) return
    if (inFlight) {
      if (!force) return
      await inFlight.catch(() => undefined)
    }

    const gen = ++generation
    const task = (async () => {
      loading.value = true
      try {
        const setting = await realtimeModelApi.fetchRealtimeModelSetting()
        if (gen !== generation) return
        await applyServerSetting(setting, profileName)
        if (gen !== generation) return
        loadedProfile = profileName
        lastLoadOk = true
      } catch (err) {
        if (gen !== generation) return
        lastLoadOk = false
        console.warn('[realtime-model] failed to load settings from server:', err)
      } finally {
        if (gen === generation) loading.value = false
      }
    })()
    inFlight = task
    try {
      await task
    } finally {
      if (inFlight === task) inFlight = null
    }
  }

  /**
   * Update the realtime model config (optimistic local update + server
   * persist for the active profile). Resolves `{ ok: true }` on success;
   * on failure the local change is reverted and `{ ok: false }` returned so
   * the caller can surface an error.
   */
  async function updateConfig(
    patch: Partial<RealtimeModelConfig>,
  ): Promise<{ ok: boolean; error?: string }> {
    const previous = { ...config.value }
    const optimistic = { ...config.value, ...patch }
    config.value = optimistic
    const profileName = currentProfileName()
    if (!profileName) {
      writeCache(optimistic, null)
      return { ok: false, error: 'Active profile is not ready' }
    }
    writeCache(optimistic, profileName)

    const token = ++saveSeq
    try {
      await realtimeModelApi.saveRealtimeModelSetting({
        settings: { model: optimistic.model, voice: optimistic.voice },
        secrets: { apiKey: optimistic.apiKey },
      })
      writeCache(optimistic, profileName)
      loadedProfile = profileName
      lastLoadOk = true
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[realtime-model] failed to persist settings to server:', err)
      // Revert only if nothing newer was applied in the meantime.
      if (token === saveSeq && sameConfig(config.value, optimistic)) {
        config.value = previous
        writeCache(previous, profileName)
      }
      return { ok: false, error: message }
    }
  }

  function sameConfig(a: RealtimeModelConfig, b: RealtimeModelConfig): boolean {
    return a.apiKey === b.apiKey && a.model === b.model && a.voice === b.voice
  }

  // Keep `config` in sync with the active profile: reload whenever the active
  // profile changes or the profile list first populates (covers boot + login,
  // where the stored profile name may already equal the server's answer).
  watch(
    () => {
      const profilesStore = useProfilesStore()
      return profilesStore.activeProfileName
    },
    (name) => {
      if (name) void loadFromServer(name, { force: true })
    },
  )
  watch(
    () => {
      const profilesStore = useProfilesStore()
      return profilesStore.profiles.length
    },
    (length) => {
      if (length > 0) void loadFromServer()
    },
  )

  return {
    config,
    hasApiKey,
    limits,
    loading,
    loadFromServer,
    updateConfig,
  }
})
