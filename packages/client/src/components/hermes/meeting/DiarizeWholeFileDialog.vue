<script setup lang="ts">
// 「拆分人声」对话框：选择识别模型（MiniMax / Qwen）与说话人数后，把整段录音
// 重新送 ASR 做说话人分离。
//
// 为什么需要这个对话框而不是直接点按就执行：
//  - 两个引擎的说话人分离能力不同：MiniMax 直接返回说话人；Qwen 只有在
//    DashScope 异步文件转写接口上才支持 diarization，而该接口只接受公网可访问
//    的音频 URL，因此必须先有 OSS（bucket / AK / SK）。
//  - 所以 Qwen 选项内联 OSS 配置，并在缺失时禁用「开始拆分」，避免把后端
//    `qwen_diarization_requires_oss` 这类错误直接甩给用户。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NModal, NRadio, NRadioGroup, NSelect } from 'naive-ui'

export interface DiarizeOssConfig {
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  endpoint: string
  pathPrefix: string
}

export type DiarizeEngine = 'minimax' | 'qwen'

const props = withDefaults(defineProps<{
  visible: boolean
  /** 打开时预选的引擎（一般取当前会话的 ASR provider）。 */
  defaultEngine?: DiarizeEngine
  /** 打开时预选的说话人数（0 = 自动）。 */
  defaultSpeakerCount?: number
  /** 是否已配置 MiniMax API Key（缺失时禁用该引擎）。 */
  minimaxKeyAvailable?: boolean
  /** 是否已配置 DashScope API Key（缺失时禁用该引擎）。 */
  dashscopeKeyAvailable?: boolean
  /** 已保存的 OSS 配置（打开时预填）。 */
  oss?: Partial<DiarizeOssConfig>
  busy?: boolean
}>(), {
  defaultEngine: 'minimax',
  defaultSpeakerCount: 0,
  minimaxKeyAvailable: false,
  dashscopeKeyAvailable: false,
  oss: () => ({}),
  busy: false,
})

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'start', payload: { engine: DiarizeEngine; speakerCount: number; oss: DiarizeOssConfig }): void
}>()

const { t } = useI18n()

const engine = ref<DiarizeEngine>('minimax')
const speakerCount = ref(0)
const ossBucket = ref('')
const ossAccessKeyId = ref('')
const ossAccessKeySecret = ref('')
const ossEndpoint = ref('oss-cn-beijing.aliyuncs.com')
const ossPathPrefix = ref('meeting-asr-uploads/')

/** 每次打开都从外部状态重新播种，避免上次填了一半的值残留。 */
watch(() => props.visible, (visible) => {
  if (!visible) return
  engine.value = props.defaultEngine
  speakerCount.value = props.defaultSpeakerCount
  ossBucket.value = props.oss?.bucket || ''
  ossAccessKeyId.value = props.oss?.accessKeyId || ''
  ossAccessKeySecret.value = props.oss?.accessKeySecret || ''
  ossEndpoint.value = props.oss?.endpoint || 'oss-cn-beijing.aliyuncs.com'
  ossPathPrefix.value = props.oss?.pathPrefix || 'meeting-asr-uploads/'
}, { immediate: true })

const speakerCountOptions = computed(() => [
  { label: t('meeting.speakerCountAuto'), value: 0 },
  ...['2', '3', '4', '5', '6', '7', '8'].map(n => ({ label: n, value: Number(n) })),
])

const engineKeyAvailable = computed(() =>
  engine.value === 'minimax' ? props.minimaxKeyAvailable : props.dashscopeKeyAvailable,
)

/** Qwen 的整段分离需要 OSS 提供公网 URL；三项必填。 */
const ossComplete = computed(() =>
  !!ossBucket.value.trim() && !!ossAccessKeyId.value.trim() && !!ossAccessKeySecret.value.trim(),
)

const canStart = computed(() => {
  if (props.busy) return false
  if (!engineKeyAvailable.value) return false
  if (engine.value === 'qwen' && !ossComplete.value) return false
  return true
})

function onEngineChange(value: DiarizeEngine) {
  engine.value = value
}

function close() {
  emit('update:visible', false)
}

function start() {
  if (!canStart.value) return
  emit('start', {
    engine: engine.value,
    speakerCount: speakerCount.value || 0,
    oss: {
      bucket: ossBucket.value.trim(),
      accessKeyId: ossAccessKeyId.value.trim(),
      accessKeySecret: ossAccessKeySecret.value.trim(),
      endpoint: ossEndpoint.value.trim() || 'oss-cn-beijing.aliyuncs.com',
      pathPrefix: ossPathPrefix.value.trim() || 'meeting-asr-uploads/',
    },
  })
}
</script>

<template>
  <NModal
    :show="props.visible"
    preset="card"
    :title="t('meeting.diarizeDialogTitle')"
    :style="{ width: '560px' }"
    :bordered="false"
    :mask-closable="!props.busy"
    @update:show="(v: boolean) => emit('update:visible', v)"
  >
    <div class="diarize-form">
      <div class="form-item">
        <label class="form-label">{{ t('meeting.diarizeEngine') }}</label>
        <NRadioGroup :value="engine" @update:value="onEngineChange">
          <NRadio value="minimax">
            <div class="radio-content">
              <span class="radio-title">{{ t('meeting.asrProviderMinimax') }}</span>
              <span class="radio-desc">{{ t('meeting.directEngineMinimaxDesc') }}</span>
            </div>
          </NRadio>
          <NRadio value="qwen">
            <div class="radio-content">
              <span class="radio-title">{{ t('meeting.asrProviderDashscope') }}</span>
              <span class="radio-desc">{{ t('meeting.directEngineQwenDesc') }}</span>
            </div>
          </NRadio>
        </NRadioGroup>
      </div>

      <div v-if="engine === 'qwen'" class="form-item">
        <label class="form-label">{{ t('meeting.speakerCount') }}</label>
        <NSelect
          :value="speakerCount"
          :options="speakerCountOptions"
          size="small"
          :style="{ width: '160px' }"
          @update:value="(v: number) => (speakerCount = v ?? 0)"
        />
      </div>

      <NAlert v-if="!engineKeyAvailable" type="warning" :show-icon="true">
        {{ engine === 'minimax' ? t('meeting.diarizeNoMinimaxKey') : t('meeting.diarizeNoDashscopeKey') }}
      </NAlert>

      <!-- Qwen 异步文件转写只接受公网音频 URL → 需要 OSS 中转 -->
      <details v-if="engine === 'qwen'" class="oss-config-details" open>
        <summary class="oss-config-summary">{{ t('meeting.ossConfig') }}</summary>
        <div class="oss-config-body">
          <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
            {{ t('meeting.diarizeQwenNeedsOss') }}
          </NAlert>
          <label class="form-label">{{ t('meeting.ossBucket') }}</label>
          <NInput v-model:value="ossBucket" :placeholder="t('meeting.ossBucketPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossAccessKeyId') }}</label>
          <NInput v-model:value="ossAccessKeyId" type="password" show-password-on="click" :placeholder="t('meeting.ossAccessKeyIdPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossAccessKeySecret') }}</label>
          <NInput v-model:value="ossAccessKeySecret" type="password" show-password-on="click" :placeholder="t('meeting.ossAccessKeySecretPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossEndpoint') }}</label>
          <NInput v-model:value="ossEndpoint" :placeholder="t('meeting.ossEndpointPlaceholder')" />
          <label class="form-label" style="margin-top: 12px">{{ t('meeting.ossPathPrefix') }}</label>
          <NInput v-model:value="ossPathPrefix" :placeholder="t('meeting.ossPathPrefixPlaceholder')" />
        </div>
      </details>

      <div v-if="engine === 'qwen' && !ossComplete" class="form-hint">
        {{ t('meeting.diarizeQwenOssRequired') }}
      </div>
    </div>

    <template #action>
      <NButton :disabled="props.busy" @click="close">{{ t('common.cancel') }}</NButton>
      <NButton type="primary" :disabled="!canStart" :loading="props.busy" @click="start">
        {{ t('meeting.diarizeStart') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.diarize-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 14px;
  font-weight: 500;
  color: $text-primary;
}

.radio-desc {
  font-size: 12px;
  color: $text-secondary;
}

.oss-config-details {
  border: 1px solid rgba(var(--accent-primary-rgb), 0.15);
  border-radius: $radius-sm;
  overflow: hidden;
}

.oss-config-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  cursor: pointer;
  user-select: none;
  background: rgba(var(--accent-primary-rgb), 0.03);

  &::-webkit-details-marker {
    display: none;
  }
}

.oss-config-body {
  padding: 10px;
  border-top: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}
</style>
