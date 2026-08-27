<script setup lang="ts">
import { computed } from 'vue'
import { NTag, NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMeetingStore } from '@/stores/hermes/meeting'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  (e: 'open-settings'): void
  (e: 'close-session'): void
}>()

const { t } = useI18n()
const meetingStore = useMeetingStore()

const session = computed(() =>
  meetingStore.sessions.find(s => s.id === props.sessionId),
)

const status = computed(() => session.value?.status ?? 'idle')
const isRecording = computed(() => status.value === 'recording')

const sceneLabel = computed(() => {
  const tpl = session.value?.sceneTemplate ?? 'general'
  return t(`meeting.scene.${tpl}`, tpl)
})
</script>

<template>
  <header class="scene-header">
    <div class="scene-header__title">
      <span class="scene-header__name">{{ session?.title || t('meeting.untitled') }}</span>
      <NTag size="small" round :type="isRecording ? 'error' : 'default'">
        {{ sceneLabel }}
      </NTag>
    </div>
    <div class="scene-header__status">
      <span v-if="isRecording" class="scene-header__rec">
        <span class="scene-header__dot" />
        <span>REC</span>
      </span>
      <NTooltip :show-arrow="true">
        <template #trigger>
          <NButton quaternary circle size="small" @click="emit('open-settings')">⚙</NButton>
        </template>
        {{ t('meeting.openSettings') }}
      </NTooltip>
      <NTooltip :show-arrow="true">
        <template #trigger>
          <NButton quaternary circle size="small" @click="emit('close-session')">✕</NButton>
        </template>
        {{ t('meeting.closeSession') }}
      </NTooltip>
    </div>
  </header>
</template>

<style scoped>
.scene-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--divider-color, #e0e0e0);
}
.scene-header__title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.scene-header__name {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}
.scene-header__status {
  display: flex;
  align-items: center;
  gap: 8px;
}
.scene-header__rec {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--error-color, #d03050);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.scene-header__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: scene-header-pulse 1.2s ease-in-out infinite;
}
@keyframes scene-header-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>