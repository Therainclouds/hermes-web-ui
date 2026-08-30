<script setup lang="ts">
// 演讲评分 · 计时员卡：环节/串场记录、发言人用时、声音提醒。
// 走表控制与倒计时展示以舞台浮层（SpeechTimerOverlay）为唯一操作面，
// 本卡片不再重复渲染计时器（用户反馈：两个计时功能太多余）。
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
  <div class="timer-mode-row">
    <NButton size="small" :type="timer.timerMode === 'segment' ? 'info' : 'default'" @click="timer.switchTimerMode('segment')">
      {{ t('meeting.speechEval.segmentMode') }}
    </NButton>
    <NButton size="small" :type="timer.timerMode === 'transition' ? 'info' : 'default'" @click="timer.switchTimerMode('transition')">
      {{ t('meeting.speechEval.transitionMode') }}
    </NButton>
    <NButton size="small" :type="timer.voiceAlert ? 'success' : 'default'" @click="timer.toggleVoiceAlert" :title="t('meeting.speechEval.voiceAlertDesc')">
      🔊 {{ timer.voiceAlert ? t('meeting.speechEval.voiceAlertOn') : t('meeting.speechEval.voiceAlertOff') }}
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
// --- 计时员卡（去重后：仅保留浮层没有的记录与管理功能） ---
.timer-mode-row { display: flex; gap: 6px; flex-wrap: wrap; }
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
