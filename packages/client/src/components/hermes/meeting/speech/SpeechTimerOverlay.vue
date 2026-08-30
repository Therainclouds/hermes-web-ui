<script setup lang="ts">
// 演讲评分场景 · 波形舞台计时舱（经 scene-ui-registry 渲染，MeetingView provide 的
// 单例实例向下注入）。双层结构：
//   - cabin-overlay：倒计时 + 相位 + 模式徽章 + 红黄绿卡，绝对定位覆盖 canvas；
//   - cabin-dock：控制工具条，正常文档流排在 canvas 下方（舞台自动长高，不挤压）。
import { useI18n } from 'vue-i18n'
import { NButton, NInput } from 'naive-ui'
import { injectSpeechTimer } from './speechTimerContext'

const { t } = useI18n()
const timer = injectSpeechTimer()
</script>

<template>
  <!-- 浮层：只覆盖 canvas 区域（100px），纯展示 -->
  <div class="cabin-overlay" :class="`phase-${timer.phase}`">
    <div class="cabin-main">
      <span v-if="timer.timerMode === 'transition'" class="cabin-mode">⏭️ {{ t('meeting.speechEval.transitionMode') }}</span>
      <span class="cabin-time">{{ timer.display }}</span>
      <span class="cabin-phase">{{ timer.phaseLabel }}</span>
    </div>
    <div class="cabin-cards">
      <span class="cabin-card green" :class="{ active: timer.phase === 'green' }">🟢 {{ t('meeting.speechEval.greenCard') }}</span>
      <span class="cabin-card yellow" :class="{ active: timer.phase === 'yellow' }">🟡 {{ t('meeting.speechEval.yellowCard') }}</span>
      <span class="cabin-card red" :class="{ active: timer.phase === 'red' }">🔴 {{ t('meeting.speechEval.redCard') }}</span>
    </div>
  </div>

  <!-- 工具条：正常文档流，canvas 下方，所有计时控制集中于此 -->
  <div class="cabin-dock">
    <div class="dock-row">
      <NButton size="tiny" :type="timer.timerRunning ? 'warning' : 'primary'" @click="timer.toggle">
        {{ timer.timerRunning ? t('meeting.speechEval.pause') : t('meeting.speechEval.start') }}
      </NButton>
      <NButton size="tiny" quaternary @click="timer.reset">{{ t('meeting.speechEval.reset') }}</NButton>
      <span class="mode-switch">
        <NButton size="tiny" :type="timer.timerMode === 'segment' ? 'info' : 'default'" @click="timer.switchTimerMode('segment')">
          {{ t('meeting.speechEval.segmentMode') }}
        </NButton>
        <NButton size="tiny" :type="timer.timerMode === 'transition' ? 'info' : 'default'" @click="timer.switchTimerMode('transition')">
          {{ t('meeting.speechEval.transitionMode') }}
        </NButton>
      </span>
      <NButton size="tiny" :type="timer.voiceAlert ? 'success' : 'default'" @click="timer.toggleVoiceAlert" :title="t('meeting.speechEval.voiceAlertDesc')">
        {{ timer.voiceAlert ? t('meeting.speechEval.voiceAlertOn') : t('meeting.speechEval.voiceAlertOff') }}
      </NButton>
    </div>
    <div class="dock-row dock-record">
      <NInput
        v-if="timer.timerMode === 'segment'"
        v-model:value="timer.timerLabel"
        size="tiny"
        :placeholder="t('meeting.speechEval.segmentLabelPlaceholder')"
        class="record-input"
      />
      <NButton size="tiny" type="primary" @click="timer.recordSegment">
        {{ timer.timerMode === 'transition' ? t('meeting.speechEval.recordTransition') : t('meeting.speechEval.recordSegment') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
// ── 浮层：倒计时覆盖 canvas（100px 内，纯展示不挤压） ──
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
  background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.45) 40%, rgba(15, 23, 42, 0.6));
  pointer-events: none;

  &.phase-green { background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(24, 160, 88, 0.12) 55%, rgba(15, 23, 42, 0.6)); }
  &.phase-yellow { background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(240, 160, 32, 0.16) 55%, rgba(15, 23, 42, 0.6)); }
  &.phase-red { background: linear-gradient(90deg, rgba(15, 23, 42, 0.85), rgba(208, 48, 80, 0.2) 55%, rgba(15, 23, 42, 0.6)); }

  .cabin-main {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .cabin-time {
    font-size: 26px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: #fff;
    text-shadow: 0 0 20px rgba(0, 0, 0, 0.6);
  }

  &.phase-green .cabin-time { color: #63e2b7; }
  &.phase-yellow .cabin-time { color: #f0a020; }
  &.phase-red .cabin-time { color: #ff4d4f; }

  .cabin-mode {
    font-size: 10px;
    color: #70c0e8;
    background: rgba(112, 192, 232, 0.12);
    border: 1px solid rgba(112, 192, 232, 0.3);
    border-radius: 10px;
    padding: 0 8px;
  }

  .cabin-phase {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.85);
  }

  .cabin-cards {
    display: flex;
    gap: 4px;
  }

  .cabin-card {
    font-size: 10px;
    padding: 1px 6px;
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
}

// ── 工具条：canvas 下方，正常文档流 ──
.cabin-dock {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 12px 8px;
  background: rgba(0, 0, 0, 0.25);
  border-top: 1px solid rgba(255, 255, 255, 0.06);

  .dock-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .mode-switch {
    display: flex;
    border-radius: 6px;
    overflow: hidden;

    :deep(.n-button) { border-radius: 0; }
    :deep(.n-button:first-child) { border-radius: 6px 0 0 6px; }
    :deep(.n-button:last-child) { border-radius: 0 6px 6px 0; }
  }

  .record-input {
    width: 150px;
  }
}
</style>
