import { computed, onUnmounted, ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SpeechEvalState, SpeechTimerRecord } from '@/stores/hermes/meeting'

export interface UseSpeechTimerDeps {
  /** 持久化的评估状态（session.speechEval，缺省用 DEFAULT_EVAL） */
  evalState: ComputedRef<SpeechEvalState>
  /** 持久化补丁写入 */
  persist: (patch: Partial<SpeechEvalState>) => void
}

/**
 * 演讲计时器（拆分自 SpeechEvaluationPanel.vue，行为保持一致）。
 *
 * 覆盖：倒计时状态机（墙钟结算的启动/暂停/重置）、红黄绿阶段判定、
 * 环节记录（recordSegment/removeRecord）与计时设置对话框状态。
 * 记录与设置通过 persist 写回 session.speechEval。
 */
export function useSpeechTimer(deps: UseSpeechTimerDeps) {
  const { t } = useI18n()

  const timerRunning = ref(false)
  const timerRemainingMs = ref(0)
  const timerLabel = ref('')
  let timerInterval: number | null = null
  let timerStartAt = 0        // 本次开始计时的墙钟时间戳
  let timerStartRemaining = 0 // 本次开始时的剩余毫秒

  function fmtSec(sec: number): string {
    const s = Math.max(0, Math.round(sec))
    const m = Math.floor(s / 60)
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  const timerDisplay = computed(() => {
    const rem = timerRemainingMs.value
    if (rem > 0) return fmtSec(rem / 1000)
    return `+${fmtSec(-rem / 1000)}`
  })

  const phase = computed(() => {
    const rem = timerRemainingMs.value
    if (rem <= deps.evalState.value.redAtSec * 1000) return 'red'
    if (rem <= deps.evalState.value.yellowAtSec * 1000) return 'yellow'
    return 'green'
  })

  const phaseLabel = computed(() => {
    const map = {
      green: t('meeting.speechEval.greenCard'),
      yellow: t('meeting.speechEval.yellowCard'),
      red: t('meeting.speechEval.redCard'),
    }
    return map[phase.value]
  })

  function resetTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
    timerRunning.value = false
    timerRemainingMs.value = deps.evalState.value.timerDurationSec * 1000
  }

  // 组件卸载时停掉走表 interval（与拆分前 onUnmounted 行为一致）。
  onUnmounted(() => {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  })

  function toggleTimer() {
    if (timerRunning.value) {
      // 暂停：按墙钟结算剩余时间
      timerRemainingMs.value = timerStartRemaining - (Date.now() - timerStartAt)
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
      timerRunning.value = false
      return
    }
    timerStartAt = Date.now()
    timerStartRemaining = timerRemainingMs.value
    timerRunning.value = true
    timerInterval = window.setInterval(() => {
      timerRemainingMs.value = timerStartRemaining - (Date.now() - timerStartAt)
    }, 250)
  }

  function nextLabel(): string {
    const n = timerRecords.value.length + 1
    return `${t('meeting.speechEval.segmentLabelPrefix')} ${n}`
  }

  function recordSegment() {
    const durationSec = deps.evalState.value.timerDurationSec - timerRemainingMs.value / 1000
    const overtimeSec = Math.max(0, -timerRemainingMs.value / 1000)
    const record: SpeechTimerRecord = {
      label: timerLabel.value.trim() || nextLabel(),
      durationSec,
      overtimeSec,
      timestamp: Date.now(),
    }
    deps.persist({ timerRecords: [...deps.evalState.value.timerRecords, record] })
    timerLabel.value = ''
    resetTimer()
  }

  function removeRecord(index: number) {
    const records = [...deps.evalState.value.timerRecords]
    records.splice(index, 1)
    deps.persist({ timerRecords: records })
  }

  const timerRecords = computed(() => deps.evalState.value.timerRecords || [])

  // ---------- 计时设置 ----------

  const showSettings = ref(false)
  const settingsDuration = ref(180)
  const settingsYellow = ref(30)
  const settingsRed = ref(10)

  function openSettings() {
    settingsDuration.value = deps.evalState.value.timerDurationSec
    settingsYellow.value = deps.evalState.value.yellowAtSec
    settingsRed.value = deps.evalState.value.redAtSec
    showSettings.value = true
  }

  function saveSettings() {
    deps.persist({
      timerDurationSec: Math.max(10, Math.round(settingsDuration.value || 180)),
      yellowAtSec: Math.max(0, Math.round(settingsYellow.value || 30)),
      redAtSec: Math.max(0, Math.round(settingsRed.value || 10)),
    })
    showSettings.value = false
    resetTimer()
  }

  return {
    // 计时状态
    timerRunning,
    timerRemainingMs,
    timerLabel,
    timerDisplay,
    phase,
    phaseLabel,
    timerRecords,
    fmtSec,
    resetTimer,
    toggleTimer,
    recordSegment,
    removeRecord,
    // 设置对话框
    showSettings,
    settingsDuration,
    settingsYellow,
    settingsRed,
    openSettings,
    saveSettings,
  }
}
