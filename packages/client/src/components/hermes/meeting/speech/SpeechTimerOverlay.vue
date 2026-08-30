<script setup lang="ts">
// 演讲评分 · 计时舱（极简版）。
// 设计语言：舞台唯一英雄元素 = 倒计时（细字重、相位色）；
// 控制全部为无边框幽灵按钮，主操作唯一实色；无 emoji、无渐变色块。
// 结构：cabin-overlay（覆盖 canvas，纯展示）+ cabin-dock（下方单行控制条）。
import { useI18n } from 'vue-i18n'
import { NButton, NInput } from 'naive-ui'
import { injectSpeechTimer } from './speechTimerContext'

const { t } = useI18n()
const timer = injectSpeechTimer()
</script>

<template>
  <!-- 倒计时层：覆盖 canvas，唯一英雄元素 -->
  <div class="cabin-overlay" :class="`phase-${timer.phase}`">
    <span v-if="timer.timerMode === 'transition'" class="cabin-mode">{{ t('meeting.speechEval.transitionMode') }}</span>
    <span class="cabin-time">{{ timer.display }}</span>
    <span class="cabin-phase">{{ timer.phaseLabel }}</span>
  </div>

  <!-- 控制条：canvas 下方单行，全部幽灵按钮，主操作唯一实色 -->
  <div class="cabin-dock">
    <NButton size="small" type="primary" class="ctl-start" @click="timer.toggle">
      {{ timer.timerRunning ? t('meeting.speechEval.pause') : t('meeting.speechEval.start') }}
    </NButton>
    <NButton size="small" quaternary class="ctl-ghost" @click="timer.reset">
      {{ t('meeting.speechEval.reset') }}
    </NButton>
    <span class="ctl-divider" />
    <span class="ctl-segment" :data-mode="timer.timerMode">
      <button
        class="seg-btn"
        :class="{ active: timer.timerMode === 'segment' }"
        @click="timer.switchTimerMode('segment')"
      >{{ t('meeting.speechEval.segmentMode') }}</button>
      <button
        class="seg-btn"
        :class="{ active: timer.timerMode === 'transition' }"
        @click="timer.switchTimerMode('transition')"
      >{{ t('meeting.speechEval.transitionMode') }}</button>
    </span>
    <span class="ctl-divider" />
    <button class="ctl-toggle" :class="{ on: timer.voiceAlert }" @click="timer.toggleVoiceAlert">
      {{ t('meeting.speechEval.voiceAlert') }}
    </button>
    <span class="ctl-divider" />
    <NInput
      v-if="timer.timerMode === 'segment'"
      v-model:value="timer.timerLabel"
      size="tiny"
      :placeholder="t('meeting.speechEval.segmentLabelPlaceholder')"
      class="ctl-input"
    />
    <NButton size="small" type="primary" secondary class="ctl-start" @click="timer.recordSegment">
      {{ timer.timerMode === 'transition' ? t('meeting.speechEval.recordTransition') : t('meeting.speechEval.recordSegment') }}
    </NButton>
  </div>
</template>

<style scoped lang="scss">
.cabin-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.cabin-time {
  font-size: 56px;
  font-weight: 200;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: 2px;
  color: #fff;
  transition: color 0.4s ease;

  .phase-green & { color: #63e2b7; }
  .phase-yellow & { color: #f0a020; }
  .phase-red & { color: #ff4d4f; }
}

.cabin-phase {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.4);

  .phase-green & { color: rgba(99, 226, 183, 0.7); }
  .phase-yellow & { color: rgba(240, 160, 32, 0.7); }
  .phase-red & { color: rgba(255, 77, 79, 0.7); }
}

.cabin-mode {
  position: absolute;
  top: 10px;
  right: 14px;
  font-size: 10px;
  letter-spacing: 0.15em;
  color: rgba(255, 255, 255, 0.5);
}

// ── 控制条：单行幽灵按钮 ──
.cabin-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.3);
}

.ctl-start {
  min-width: 72px;
}

.ctl-ghost {
  color: rgba(255, 255, 255, 0.65);
}

.ctl-divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.1);
}

.ctl-segment {
  display: flex;
  gap: 2px;

  .seg-btn {
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.4);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover { color: rgba(255, 255, 255, 0.8); }
    &.active {
      color: #fff;
      background: rgba(255, 255, 255, 0.08);
    }
  }
}

.ctl-toggle {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover { color: rgba(255, 255, 255, 0.8); }
  &.on { color: #63e2b7; }
}

.ctl-input {
  width: 140px;
}
</style>
