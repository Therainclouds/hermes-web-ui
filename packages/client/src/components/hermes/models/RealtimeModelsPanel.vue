<script setup lang="ts">
import { NAlert, NButton, NInput, NSelect, type SelectOption } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { useMessage } from '@/composables/useAppMessage'

/**
 * Realtime 模型面板（设置 → 模型 → Realtime 模型）。
 *
 * 这里统一管理千问（DashScope）API Key：会议模式的 ASR 与 Realtime 对话
 * 在未单独填写 DashScope Key 时会默认回落此处的 Key，方便千问 API 统一管理。
 *
 * 配置持久化在当前用户 Profile（服务端），与 STT/TTS 模型设置一致——打开
 * 面板时先从服务端拉取当前 Profile 的配置，保存时写回服务端。
 */

const { t } = useI18n()
const message = useMessage()
const store = useRealtimeModelStore()

// Voices verified against the DashScope `qwen3.5-omni-flash-realtime`
// catalogue (default model). `Cherry`, `Chelsie`, and `Adam` are NOT valid
// for that model — DashScope closes the WS with 1007 if they are sent.
const voiceOptions: SelectOption[] = [
  { label: 'Tina (女声 · 中文 · 默认)', value: 'Tina' },
  { label: 'Serena (女声 · 中文)', value: 'Serena' },
  { label: 'Ethan (男声 · 中文)', value: 'Ethan' },
  { label: 'Jennifer (女声 · 中文)', value: 'Jennifer' },
  { label: 'Ryan (男声 · 中文)', value: 'Ryan' },
]

const apiKey = ref(store.config.apiKey)
const model = ref(store.config.model)
const voice = ref(store.config.voice)
const saving = ref(false)

onMounted(async () => {
  // Refresh from the active profile's server row so the form always shows
  // profile-persisted values (e.g. after switching profiles / browsers).
  await store.loadFromServer(null, { force: true })
  apiKey.value = store.config.apiKey
  model.value = store.config.model
  voice.value = store.config.voice
})

async function handleSave() {
  saving.value = true
  try {
    const result = await store.updateConfig({
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || 'qwen3.5-omni-flash-realtime',
      voice: voice.value || 'Tina',
    })
    if (result.ok) {
      message.success(t('models.realtimeSaved'))
    } else {
      message.error(result.error || t('models.realtimeSaveFailed'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('models.realtimeSaveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="realtime-models-panel">
    <div class="realtime-models-header">
      <h3>{{ t('models.realtimeTitle') }}</h3>
      <p class="realtime-models-subtitle">{{ t('models.realtimeSubtitle') }}</p>
    </div>

    <NAlert type="info" :show-icon="false" class="realtime-models-alert">
      {{ t('models.realtimeSharedHint') }}
    </NAlert>

    <div class="realtime-models-form">
      <div class="realtime-models-field">
        <label>
          {{ t('models.realtimeApiKey') }}
          <a
            href="https://dashscope.aliyun.com/"
            target="_blank"
            rel="noopener noreferrer"
            class="realtime-models-link"
            @click.stop
          >{{ t('meeting.howToGetApiKey') }}</a>
        </label>
        <NInput
          v-model:value="apiKey"
          type="password"
          show-password-on="click"
          :placeholder="t('models.realtimeApiKeyPlaceholder')"
        />
        <div class="realtime-models-hint">{{ t('models.realtimeApiKeyHint') }}</div>
      </div>

      <div class="realtime-models-field">
        <label>{{ t('models.realtimeModelLabel') }}</label>
        <NInput
          v-model:value="model"
          :placeholder="t('models.realtimeModelPlaceholder')"
        />
      </div>

      <div class="realtime-models-field">
        <label>{{ t('models.realtimeVoiceLabel') }}</label>
        <NSelect v-model:value="voice" :options="voiceOptions" />
      </div>

      <div class="realtime-models-actions">
        <NButton
          type="primary"
          :loading="saving"
          data-guide-id="models-realtime-save"
          @click="handleSave"
        >
          {{ t('common.save') }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.realtime-models-panel {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.realtime-models-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
}

.realtime-models-subtitle {
  margin: 0;
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.5;
}

.realtime-models-alert {
  font-size: 13px;
}

.realtime-models-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
  border-radius: $radius-md;
  background: rgba(var(--accent-primary-rgb), 0.03);
}

.realtime-models-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.realtime-models-field label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
}

.realtime-models-link {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-primary, #667eea);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
}

.realtime-models-link:hover {
  opacity: 1;
}

.realtime-models-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.realtime-models-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
