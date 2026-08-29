<script setup lang="ts">
// 演讲评分 · 计时员卡：走表展示、环节/串场记录、发言人用时。
// 计时状态经 speechTimerContext 注入（面板创建的唯一实例）。
import { useI18n } from 'vue-i18n'
import { NButton, NInput } from 'naive-ui'
import { injectSpeechTimer } from '../speechTimerContext'
import { fmtSec } from '@/composables/useSpeechTimer'

defineProps<{
  /** 发言人用时（由转写时间戳估算，面板经 useSpeechAiAggregation 提供） */
  speakerDurations: Array<{ speaker: string; durationSec: number }>
}>()

const { t } = useI18n()
const timer = injectSpeechTimer()
</script>

<template>
  <div class="timer-display" :class="`phase-${timer.phase}`">
    <span class="timer-time">{{ timer.display }}</span>
    <span class="timer-phase-label">{{ timer.phaseLabel }}</span>
  </div>

  <div class="timer-cards">
    <span class="card green" :class="{ active: timer.phase === 'green' }">🟢 {{ t('meeting.speechEval.greenCard') }}</span>
    <span class="card yellow" :class="{ active: timer.phase === 'yellow' }">🟡 {{ t('meeting.speechEval.yellowCard') }}</span>
    <span class="card red" :class="{ active: timer.phase === 'red' }">🔴 {{ t('meeting.speechEval.redCard') }}</span>
  </div>

  <div class="timer-controls">
    <NButton size="small" :type="timer.timerRunning ? 'warning' : 'primary'" @click="timer.toggle">
      {{ timer.timerRunning ? t('meeting.speechEval.pause') : t('meeting.speechEval.start') }}
    </NButton>
    <NButton size="small" @click="timer.reset">{{ t('meeting.speechEval.reset') }}</NButton>
    <NButton size="small" :type="timer.timerMode === 'segment' ? 'info' : 'default'" @click="timer.switchTimerMode('segment')">
      {{ t('meeting.speechEval.segmentMode') }}
    </NButton>
    <NButton size="small" :type="timer.timerMode === 'transition' ? 'info' : 'default'" @click="timer.switchTimerMode('transition')">
      {{ t('meeting.speechEval.transitionMode') }}
    </NButton>
    <NButton size="small" :type="timer.voiceAlert ? 'success' : 'default'" @click="timer.toggleVoiceAlert" :title="t('meeting.speechEval.voiceAlertDesc')">
      {{ timer.voiceAlert ? t('meeting.speechEval.voiceAlertOn') : t('meeting.speechEval.voiceAlertOff') }}
    </NButton>
  </div>

  <div v-if="timer.timerMode === 'transition'" class="transition-hint">⏭️ {{ t('meeting.speechEval.transitionHint') }}</div>

  <div class="segment-row">
    <NInput v-if="timer.timerMode === 'segment'" v-model:value="timer.timerLabel" size="small" :placeholder="t('meeting.speechEval.segmentLabelPlaceholder')" />
    <NButton size="small" type="primary" @click="timer.recordSegment">
      {{ timer.timerMode === 'transition' ? t('meeting.speechEval.recordTransition') : t('meeting.speechEval.recordSegment') }}
    </NButton>
  </div>

  <div class="time-records">
    <div class="records-title">{{ t('meeting.speechEval.timeRecords') }}</div>
    <div v-if="timer.timerRecords.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyRecords') }}</div>
    <div v-for="(r, i) in timer.timerRecords" :key="i" class="record-item">
      <span class="record-label">{{ r.label }}</span>
      <span class="record-duration">{{ fmtSec(r.durationSec) }}<span v-if="r.overtimeSec > 0" class="record-overtime"> (+{{ fmtSec(r.overtimeSec) }})</span></span>
      <button class="record-remove" @click="timer.removeRecord(i)">×</button>
    </div>
  </div>

  <!-- 发言人用时（由转写时间戳估算，供时间把控/串场分析） -->
  <div class="time-records">
    <div class="records-title">👥 {{ t('meeting.speechEval.speakerDuration') }}</div>
    <div v-if="speakerDurations.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptySpeakerDurations') }}</div>
    <div v-for="d in speakerDurations" :key="d.speaker" class="record-item">
      <span class="record-label">{{ d.speaker }}</span>
      <span class="record-duration">{{ fmtSec(d.durationSec) }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
// --- 计时员卡（自 SpeechEvaluationPanel 原样搬出） ---
.timer-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.2);
  transition: all 0.3s ease;

  &.phase-green { border-color: rgba(24, 160, 88, 0.6); }
  &.phase-yellow { border-color: rgba(240, 160, 32, 0.7); background: rgba(240, 160, 32, 0.06); }
  &.phase-red { border-color: rgba(208, 48, 80, 0.8); background: rgba(208, 48, 80, 0.08); }
}

.timer-time {
  font-size: 40px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  color: var(--n-text-color, #fff);
}

.phase-green .timer-time { color: #63e2b7; }
.phase-yellow .timer-time { color: #f0a020; }
.phase-red .timer-time { color: #ff4d4f; }

.timer-phase-label { font-size: 12px; font-weight: 600; letter-spacing: 0.5px; }

.timer-cards { display: flex; gap: 6px; }

.card {
  flex: 1;
  text-align: center;
  font-size: 11px;
  padding: 4px 0;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  opacity: 0.45;
  transition: all 0.2s ease;

  &.green.active { opacity: 1; border-color: #18a058; background: rgba(24, 160, 88, 0.15); }
  &.yellow.active { opacity: 1; border-color: #f0a020; background: rgba(240, 160, 32, 0.15); }
  &.red.active { opacity: 1; border-color: #d03050; background: rgba(208, 48, 80, 0.18); }
}

.timer-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.segment-row { display: flex; gap: 8px; align-items: center; }

.transition-hint {
  font-size: 11px;
  color: #70c0e8;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(112, 192, 232, 0.08);
  border: 1px solid rgba(112, 192, 232, 0.15);
}

.time-records { display: flex; flex-direction: column; gap: 4px; }
.records-title { font-size: 11px; color: var(--n-text-color3, #888); }

.record-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.record-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-duration { font-variant-numeric: tabular-nums; }
.record-overtime { color: #ff4d4f; }

.record-remove {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;

  &:hover { color: #ff4d4f; }
}
</style>
