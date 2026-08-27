<script setup lang="ts">
import { NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'

defineProps<{
  sessionId: string
  isRecording: boolean
  isPaused: boolean
  isBusy: boolean
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'pause'): void
  (e: 'stop'): void
  (e: 'request-report'): void
}>()

const { t } = useI18n()
</script>

<template>
  <footer class="scene-control-bar">
    <div class="scene-control-bar__left">
      <NTooltip>
        <template #trigger>
          <NButton
            type="primary"
            size="small"
            :disabled="isRecording || isBusy"
            @click="emit('start')"
          >
            ⏺ {{ t('meeting.control.start') }}
          </NButton>
        </template>
        {{ t('meeting.control.startHint') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            size="small"
            :disabled="!isRecording || isBusy"
            @click="emit('pause')"
          >
            ⏸ {{ isPaused ? t('meeting.control.resume') : t('meeting.control.pause') }}
          </NButton>
        </template>
        {{ t('meeting.control.pauseHint') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            size="small"
            type="warning"
            :disabled="!isRecording || isBusy"
            @click="emit('stop')"
          >
            ⏹ {{ t('meeting.control.stop') }}
          </NButton>
        </template>
        {{ t('meeting.control.stopHint') }}
      </NTooltip>
    </div>
    <div class="scene-control-bar__right">
      <NButton size="small" @click="emit('request-report')">
        📝 {{ t('meeting.control.report') }}
      </NButton>
    </div>
  </footer>
</template>

<style scoped>
.scene-control-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-top: 1px solid var(--divider-color, #e0e0e0);
  background: var(--card-color, #fff);
}
.scene-control-bar__left,
.scene-control-bar__right {
  display: flex;
  gap: 8px;
}
</style>