import { ref, computed } from 'vue'

/**
 * 演讲评分场景的共享计时器（模块级单例）。
 *
 * 左侧（MeetingView 波形区/转写区）与右侧（SpeechEvaluationPanel 时间卡）
 * 引用同一份运行态，保证两边倒计时/红黄绿牌完全同步。
 * 持久化数据（时长/黄牌/红牌阈值、环节用时记录）仍存 session.speechEval，
 * 本 composable 只负责"正在走表"这份瞬时状态。
 */

const timerRunning = ref(false)
const timerRemainingMs = ref(0)

let timerInterval: number | null = null
let timerStartAt = 0
let timerStartRemaining = 0

// 阈值：由各组件从 session.speechEval 同步进来
const durationSec = ref(180)
const yellowAtSec = ref(30)
const redAtSec = ref(10)

function clearTicker() {
  if (timerInterval !== null) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function useSpeechTimer() {
  /** 同步阈值（时长/黄牌/红牌剩余秒数）。未开始走表时把剩余时间重置为满时长。 */
  function setThresholds(opts: { durationSec: number; yellowAtSec: number; redAtSec: number }) {
    durationSec.value = opts.durationSec
    yellowAtSec.value = opts.yellowAtSec
    redAtSec.value = opts.redAtSec
    if (!timerRunning.value) {
      timerRemainingMs.value = durationSec.value * 1000
    }
  }

  function reset() {
    clearTicker()
    timerRunning.value = false
    timerRemainingMs.value = durationSec.value * 1000
  }

  function toggle() {
    if (timerRunning.value) {
      // 暂停：按墙钟结算剩余时间
      timerRemainingMs.value = timerStartRemaining - (Date.now() - timerStartAt)
      clearTicker()
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

  function stop() {
    if (timerRunning.value) {
      timerRemainingMs.value = timerStartRemaining - (Date.now() - timerStartAt)
    }
    clearTicker()
    timerRunning.value = false
  }

  const phase = computed<'green' | 'yellow' | 'red'>(() => {
    const rem = timerRemainingMs.value
    if (rem <= redAtSec.value * 1000) return 'red'
    if (rem <= yellowAtSec.value * 1000) return 'yellow'
    return 'green'
  })

  const display = computed(() => {
    const rem = timerRemainingMs.value
    if (rem > 0) return fmtSec(rem / 1000)
    return `+${fmtSec(-rem / 1000)}`
  })

  const remainingSec = computed(() => Math.max(0, timerRemainingMs.value / 1000))

  return {
    timerRunning,
    timerRemainingMs,
    durationSec,
    yellowAtSec,
    redAtSec,
    phase,
    display,
    remainingSec,
    setThresholds,
    reset,
    toggle,
    stop,
  }
}
