<script setup lang="ts">
import { NAlert, NButton, NInput, NSelect, type SelectOption } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { useMessage } from '@/composables/useAppMessage'

/**
 * Realtime 模型面板（设置 → 模型 → Realtime 模型）。
 *
 * 这里统一管理两个共用 API：
 *   1. 千问（DashScope）API Key —— 会议模式 ASR 与 Realtime 对话
 *      在未单独填写 DashScope Key 时默认回落此处。
 *   2. MiniMax API Key —— 会议模式 ASR 选择 MiniMax provider 时使用；
 *      详见 https://platform.minimax.cn/docs/api-reference/speech-to-text 。
 *
 * 配置持久化在当前用户 Profile（服务端），与 STT/TTS 模型设置一致——打开
 * 面板时先从服务端拉取当前 Profile 的配置，保存时写回服务端。
 */

const { t } = useI18n()
const message = useMessage()
const store = useRealtimeModelStore()

// Voices verified against the DashScope `qwen3.8-omni-flash-realtime`
// catalogue (default model). `Cherry`, `Chelsie`, and `Adam` are NOT valid
// for that model — DashScope closes the WS with 1007 if they are sent.
const voiceOptions: SelectOption[] = [
  { label: 'Ethan (男声 · 中文 · 默认)', value: 'Ethan' },
  { label: 'Tina (女声 · 中文)', value: 'Tina' },
  { label: 'Serena (女声 · 中文)', value: 'Serena' },
  { label: 'Jennifer (女声 · 中文)', value: 'Jennifer' },
  { label: 'Ryan (男声 · 中文)', value: 'Ryan' },
]

/** ASR provider options for the meeting-mode speech recognition card. */
const asrProviderOptions: SelectOption[] = [
  {
    label: 'DashScope (Qwen Paraformer / Fun-ASR)',
    value: 'dashscope',
  },
  {
    label: 'MiniMax (Speech-to-Text)',
    value: 'minimax',
  },
]

const apiKey = ref(store.config.apiKey)
const model = ref(store.config.model)
const voice = ref(store.config.voice)
const asrProvider = ref(store.config.asrProvider)
const minimaxApiKey = ref(store.config.minimaxApiKey)
const minimaxAsrModel = ref(store.config.minimaxAsrModel)
const minimaxBaseUrl = ref(store.config.minimaxBaseUrl)
const saving = ref(false)

onMounted(async () => {
  // Refresh from the active profile's server row so the form always shows
  // profile-persisted values (e.g. after switching profiles / browsers).
  await store.loadFromServer(null, { force: true })
  apiKey.value = store.config.apiKey
  model.value = store.config.model
  voice.value = store.config.voice
  asrProvider.value = store.config.asrProvider
  minimaxApiKey.value = store.config.minimaxApiKey
  minimaxAsrModel.value = store.config.minimaxAsrModel
  minimaxBaseUrl.value = store.config.minimaxBaseUrl
})

async function handleSave() {
  saving.value = true
  try {
    const result = await store.updateConfig({
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || 'qwen3.8-omni-flash-realtime',
      voice: voice.value || 'Ethan',
      asrProvider: asrProvider.value,
      minimaxApiKey: minimaxApiKey.value.trim(),
      minimaxAsrModel: minimaxAsrModel.value.trim() || 'asr-1.0',
      minimaxBaseUrl: minimaxBaseUrl.value.trim() || 'https://api.minimaxi.com',
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

    <div class="realtime-models-section-divider">
      <span>{{ t('models.realtimeAsrSectionTitle') }}</span>
    </div>

    <div class="realtime-models-form">
      <div class="realtime-models-field">
        <label>{{ t('models.realtimeAsrProviderLabel') }}</label>
        <NSelect v-model:value="asrProvider" :options="asrProviderOptions" />
        <div class="realtime-models-hint">{{ t('models.realtimeAsrProviderHint') }}</div>
      </div>

      <template v-if="asrProvider === 'minimax'">
        <div class="realtime-models-field">
          <label>
            {{ t('models.realtimeMinimaxApiKey') }}
            <a
              href="https://platform.minimax.cn/user-center/basic-information/interface-key"
              target="_blank"
              rel="noopener noreferrer"
              class="realtime-models-link"
              @click.stop
            >{{ t('meeting.howToGetApiKey') }}</a>
          </label>
          <NInput
            v-model:value="minimaxApiKey"
            type="password"
            show-password-on="click"
            :placeholder="t('models.realtimeMinimaxApiKeyPlaceholder')"
          />
          <div class="realtime-models-hint">{{ t('models.realtimeMinimaxApiKeyHint') }}</div>
        </div>

        <div class="realtime-models-field">
          <label>{{ t('models.realtimeMinimaxModelLabel') }}</label>
          <NInput
            v-model:value="minimaxAsrModel"
            :placeholder="t('models.realtimeMinimaxModelPlaceholder')"
          />
          <div class="realtime-models-hint">{{ t('models.realtimeMinimaxModelHint') }}</div>
        </div>

        <div class="realtime-models-field">
          <label>{{ t('models.realtimeMinimaxBaseUrlLabel') }}</label>
          <NInput
            v-model:value="minimaxBaseUrl"
            :placeholder="t('models.realtimeMinimaxBaseUrlPlaceholder')"
          />
          <div class="realtime-models-hint">{{ t('models.realtimeMinimaxBaseUrlHint') }}</div>
        </div>
      </template>

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

.realtime-models-section-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 -4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-secondary;

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(var(--accent-primary-rgb), 0.18);
  }
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
