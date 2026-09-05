<script setup lang="ts">
/**
 * ScannerEnhanceControls - 单页增强控件：预设 + 对比度/亮度/锐化滑杆，
 * 以及「矫正裁剪 / 重置」动作。纯展示组件，状态由父级持有。
 */
import { NButton, NSelect, NSlider, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { ENHANCE_DEFAULTS, type EnhanceParams, type EnhancePreset } from '../vision/types'

const props = withDefaults(defineProps<{
  params: EnhanceParams
  /** 矫正中 loading。 */
  correcting?: boolean
  /** 是否可执行矫正（引擎可用且页面上有原图）。 */
  canCorrect?: boolean
}>(), {
  correcting: false,
  canCorrect: true,
})

const emit = defineEmits<{
  (e: 'update:params', params: EnhanceParams): void
  (e: 'correct'): void
  (e: 'reset'): void
}>()

const { t } = useI18n()
const tt = ((key: string) => {
  const value = (t as unknown as (k: string) => unknown)(key)
  return typeof value === 'string' ? value : String(key)
}) as (key: string) => string

const presetOptions = [
  { label: tt('scanner.enhance.presetNone'), value: 'none' },
  { label: tt('scanner.enhance.presetAuto'), value: 'auto' },
  { label: tt('scanner.enhance.presetGray'), value: 'gray' },
  { label: tt('scanner.enhance.presetBw'), value: 'bw' },
]

function patch(patch: Partial<EnhanceParams>) {
  emit('update:params', { ...props.params, ...patch })
}

function setPreset(preset: EnhancePreset) {
  // 切换预设时重置中性滑杆，避免叠加旧值
  emit('update:params', { ...ENHANCE_DEFAULTS[preset] })
}

function reset() {
  emit('reset')
}
</script>

<template>
  <div class="enhance-controls">
    <div class="enhance-row enhance-row-actions">
      <span class="enhance-label">{{ tt('scanner.enhance.label') }}</span>
      <NSelect
        :value="params.preset"
        :options="presetOptions"
        size="small"
        style="width: 128px;"
        @update:value="setPreset($event as EnhancePreset)"
      />
      <NTooltip>
        <template #trigger>
          <NButton
            size="small"
            quaternary
            type="primary"
            :loading="correcting"
            :disabled="!canCorrect || correcting"
            @click="emit('correct')"
          >
            {{ tt('scanner.enhance.correct') }}
          </NButton>
        </template>
        {{ tt('scanner.enhance.correctHint') }}
      </NTooltip>
      <NButton size="small" quaternary type="error" @click="reset">
        {{ tt('scanner.enhance.reset') }}
      </NButton>
    </div>

    <div class="enhance-row">
      <span class="enhance-label">{{ tt('scanner.enhance.contrast') }}</span>
      <NSlider
        :value="params.contrast"
        :min="0"
        :max="200"
        size="small"
        class="enhance-slider"
        @update:value="patch({ contrast: $event as number })"
      />
      <span class="enhance-value">{{ params.contrast }}</span>
    </div>
    <div class="enhance-row">
      <span class="enhance-label">{{ tt('scanner.enhance.brightness') }}</span>
      <NSlider
        :value="params.brightness"
        :min="-100"
        :max="100"
        size="small"
        class="enhance-slider"
        @update:value="patch({ brightness: $event as number })"
      />
      <span class="enhance-value">{{ params.brightness > 0 ? `+${params.brightness}` : params.brightness }}</span>
    </div>
    <div class="enhance-row">
      <span class="enhance-label">{{ tt('scanner.enhance.sharpen') }}</span>
      <NSlider
        :value="params.sharpen"
        :min="0"
        :max="100"
        size="small"
        class="enhance-slider"
        @update:value="patch({ sharpen: $event as number })"
      />
      <span class="enhance-value">{{ params.sharpen }}</span>
    </div>
  </div>
</template>

<style scoped>
.enhance-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-light, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  background: var(--bg-secondary, transparent);
}

.enhance-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.enhance-row-actions {
  flex-wrap: wrap;
}

.enhance-label {
  font-size: 12px;
  color: var(--text-muted, #999);
  min-width: 34px;
  flex-shrink: 0;
}

.enhance-slider {
  flex: 1;
  min-width: 120px;
}

.enhance-value {
  font-size: 11.5px;
  color: var(--text-muted, #999);
  width: 34px;
  text-align: right;
  flex-shrink: 0;
}
</style>
