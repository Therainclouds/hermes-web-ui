<script setup lang="ts">
// 演讲评分场景 · 转写区顶部计时状态条（自 MeetingView 搬出，经 scene-ui-registry 渲染）。
// 走表状态来自 useSpeechTimer 模块级单例；句数读自会议 store。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSpeechTimer } from '@/composables/useSpeechTimer'
import { useMeetingStore } from '@/stores/hermes/meeting'

const { t } = useI18n()
const meetingStore = useMeetingStore()

const {
  timerRunning,
  phase,
} = useSpeechTimer()

const sentenceCount = computed(() => meetingStore.activeSession?.sentences.length ?? 0)
</script>

<template>
  <div class="speech-transcript-strip" :class="`phase-${phase}`">
    <div class="strip-left">
      <span class="strip-dot" :class="{ running: timerRunning }" />
      <span class="strip-label">{{ timerRunning ? t('meeting.recording') : t('meeting.idle') }}</span>
    </div>
    <div class="strip-right">
      <span class="strip-count">{{ sentenceCount }} {{ t('meeting.sentences') }}</span>
      <span class="strip-hint">{{ t('meeting.speechEval.practiceHint') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

// --- 演讲评分：转写区顶部计时状态条（自 MeetingView 原样搬出） ---
.speech-transcript-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px;
  border-bottom: 1px solid $border-color;
  background: $bg-card;
  font-size: 12px;

  &.phase-green { border-left: 3px solid #18a058; }
  &.phase-yellow { border-left: 3px solid #f0a020; }
  &.phase-red { border-left: 3px solid #d03050; }

  .strip-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .strip-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;

    &.running { background: #18a058; animation: strip-pulse 1.5s infinite; }
  }

  .strip-label {
    font-size: 11px;
    font-weight: 600;
    color: $text-secondary;
  }

  .strip-right {
    display: flex;
    align-items: center;
    gap: 12px;
    color: $text-secondary;
  }

  .strip-hint {
    font-size: 11px;
    opacity: 0.7;
  }
}

@keyframes strip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
