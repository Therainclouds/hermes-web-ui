<script setup lang="ts">
// 演讲评分场景 · 波形舞台计时器浮层（自 MeetingView 搬出，经 scene-ui-registry 渲染）。
// 走表状态来自 useSpeechTimer 模块级单例——与右侧评估面板/转写状态条天然同步。
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import { useSpeechTimer } from '@/composables/useSpeechTimer'

const { t } = useI18n()

const {
  timerRunning,
  phase,
  display,
  phaseLabel,
  toggle,
  reset,
} = useSpeechTimer()
</script>

<template>
  <div class="speech-timer-overlay" :class="`phase-${phase}`">
    <div class="speech-timer-main">
      <span class="speech-timer-time">{{ display }}</span>
      <span class="speech-timer-phase">{{ phaseLabel }}</span>
    </div>
    <div class="speech-timer-cards">
      <span class="tm-card green" :class="{ active: phase === 'green' }">🟢 {{ t('meeting.speechEval.greenCard') }}</span>
      <span class="tm-card yellow" :class="{ active: phase === 'yellow' }">🟡 {{ t('meeting.speechEval.yellowCard') }}</span>
      <span class="tm-card red" :class="{ active: phase === 'red' }">🔴 {{ t('meeting.speechEval.redCard') }}</span>
    </div>
    <div class="speech-timer-actions">
      <NButton size="tiny" :type="timerRunning ? 'warning' : 'primary'" @click="toggle">
        {{ timerRunning ? t('meeting.speechEval.pause') : t('meeting.speechEval.start') }}
      </NButton>
      <NButton size="tiny" @click="reset">{{ t('meeting.speechEval.reset') }}</NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
// --- 演讲评分：波形上计时覆盖层（自 MeetingView 原样搬出） ---
.speech-timer-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 12px;
  flex-wrap: wrap;
  align-content: center;
  background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.45) 40%, rgba(15, 23, 42, 0.6));
  pointer-events: none;

  &.phase-green { background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(24, 160, 88, 0.12) 55%, rgba(15, 23, 42, 0.6)); }
  &.phase-yellow { background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(240, 160, 32, 0.16) 55%, rgba(15, 23, 42, 0.6)); }
  &.phase-red { background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(208, 48, 80, 0.2) 55%, rgba(15, 23, 42, 0.6)); }

  .speech-timer-main {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .speech-timer-time {
    font-size: 26px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: #fff;
    text-shadow: 0 0 20px rgba(0, 0, 0, 0.6);
  }

  &.phase-green .speech-timer-time { color: #63e2b7; }
  &.phase-yellow .speech-timer-time { color: #f0a020; }
  &.phase-red .speech-timer-time { color: #ff4d4f; }

  .speech-timer-phase {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.85);
  }

  .speech-timer-cards {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: center;
  }

  .tm-card {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    opacity: 0.45;
    background: rgba(0, 0, 0, 0.35);
    transition: all 0.2s ease;
    white-space: nowrap;

    &.green.active { opacity: 1; border-color: #18a058; background: rgba(24, 160, 88, 0.35); color: #63e2b7; }
    &.yellow.active { opacity: 1; border-color: #f0a020; background: rgba(240, 160, 32, 0.35); color: #f0c060; }
    &.red.active { opacity: 1; border-color: #d03050; background: rgba(208, 48, 80, 0.4); color: #ff8a8a; }
  }

  .speech-timer-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    pointer-events: auto;
  }
}
</style>
