<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NTag } from 'naive-ui'
import { request } from '@/api/client'
import { copyToClipboard } from '@/utils/clipboard'
const { t } = useI18n()
const state = ref<{ configured: boolean; gatewayOnline: boolean; sessions: number; deviceId?: string; otaUrl?: string }>()
const stt = ref<{ configured: boolean; activeProvider: string | null }>()
const tts = ref(''), error = ref(false), loading = ref(false), copied = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    const [device, speech, voice] = await Promise.all([
      request<NonNullable<typeof state.value>>('/api/xiaozhi/status'),
      request<NonNullable<typeof stt.value>>('/api/hermes/stt/profile-status'),
      request<{ activeProvider: string }>('/api/hermes/tts/settings'),
    ])
    state.value = device; stt.value = speech; tts.value = voice.activeProvider || ''; error.value = false
  } catch { error.value = true; state.value = undefined }
  finally { loading.value = false }
}
async function copy() { if (state.value?.otaUrl) copied.value = await copyToClipboard(state.value.otaUrl) }
onMounted(() => { void refresh(); timer = setInterval(refresh, 10000) })
onUnmounted(() => clearInterval(timer))
</script>
<template>
  <section class="connection">
    <header><h2>{{ t('xiaozhiConnection.title') }}</h2><NButton :loading="loading" @click="refresh">{{ t('xiaozhiConnection.refresh') }}</NButton></header>
    <p v-if="error" role="alert">{{ t('xiaozhiConnection.error') }}</p>
    <template v-else-if="state">
      <NTag :type="state.sessions > 0 ? 'success' : 'warning'">{{ t(state.sessions > 0 ? 'xiaozhiConnection.connected' : 'xiaozhiConnection.offline') }}</NTag> {{ state.deviceId }}
      <dl><div><dt>{{ t('xiaozhiConnection.gateway') }}</dt><dd>{{ t(state.gatewayOnline ? 'xiaozhiConnection.online' : 'xiaozhiConnection.offline') }}</dd></div><div><dt>STT / ASR</dt><dd>{{ stt?.configured ? stt.activeProvider : t('xiaozhiConnection.unconfigured') }}</dd></div><div><dt>TTS</dt><dd>{{ tts || t('xiaozhiConnection.unconfigured') }}</dd></div></dl>
      <template v-if="state.otaUrl"><p>{{ t('xiaozhiConnection.setup') }}</p><code>{{ state.otaUrl }}</code><NButton size="small" @click="copy">{{ t(copied ? 'xiaozhiConnection.copied' : 'xiaozhiConnection.copy') }}</NButton></template>
      <RouterLink :to="{ name: 'hermes.settings' }">{{ t('xiaozhiConnection.voiceSettings') }}</RouterLink>
    </template>
  </section>
</template>
<style scoped>
.connection{padding:24px;border:1px solid var(--border-color,#8884);border-radius:16px;margin-bottom:24px;background:var(--bg-secondary,#8881)}header{display:flex;justify-content:space-between;gap:16px}h2{font-size:20px;margin:0}p{opacity:.75;line-height:1.6}dl{display:flex;gap:40px;flex-wrap:wrap}dt{opacity:.65;font-size:12px}dd{margin:6px 0}code{display:block;overflow-wrap:anywhere;padding:12px;margin-bottom:8px;background:#8881;border-radius:8px}a{display:block;margin-top:16px}
</style>
