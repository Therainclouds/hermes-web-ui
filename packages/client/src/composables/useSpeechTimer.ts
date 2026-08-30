import { computed, ref, watch, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SpeechEvalState, SpeechTimerRecord } from '@/stores/hermes/meeting'

/**
 * 演讲评分场景的共享计时器（合并自 org「会议模式演讲功能」与本地 PR-6 拆分；
 * S2 收编设备侧内联在面板里的计时模式/串场记录/TTS 语音提醒）。
 *
 * 核心走表状态是**模块级单例**：左侧（MeetingView 波形区浮层/转写区状态条）
 * 与右侧（SpeechEvaluationPanel 时间卡）引用同一份运行态，保证两边倒计时/
 * 红黄绿牌完全同步。持久化数据（时长/黄牌/红牌阈值、环节用时记录、串场、
 * 语音提醒开关）仍存 session.speechEval，本 composable 只负责"正在走表"
 * 这份瞬时状态。
 *
 * 面板侧额外功能（环节标签、用时/串场记录、设置对话框、语音提醒）通过传入
 * deps 启用——只有 SpeechEvaluationPanel 传 { evalState, persist }；
 * MeetingView 只读共享状态，不传 deps，也不注册任何副作用。
 *
 * 生命周期归属：面板卸载不停表（左侧覆盖层继续走表）；页面卸载/切换会话
 * 由 MeetingView 统一 reset/stop。
 */

// ── 模块级单例状态 ──
// 初始即满时长：阈值同步前的 boot 阶段不出现"满时间却红牌"的错乱
const timerRunning = ref(false)
const timerRemainingMs = ref(180_000)
/** 计时模式：演讲环节 / 主持人串场（记录时打不同标签，报告按标签汇总） */
const timerMode = ref<'segment' | 'transition'>('segment')

let timerInterval: number | null = null
let timerStartAt = 0        // 本次开始计时的墙钟时间戳
let timerStartRemaining = 0 // 本次开始时的剩余毫秒

// 阈值：由各组件从 session.speechEval 同步进来
const durationSec = ref(180)
const yellowAtSec = ref(30)
const redAtSec = ref(10)

// TTS 语音提醒的防重触发标志（模块级：reset 统一复位，与走表状态同生命周期）
let lastVoicePhase: 'green' | 'yellow' | 'red' | null = null
let voiceWasOver = false

function clearTicker() {
  if (timerInterval !== null) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

export function resetVoiceFlags() {
  lastVoicePhase = null
  voiceWasOver = false
}

export function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ---------- 计时语音提醒（浏览器 TTS，黄牌/红牌/时间到） ----------

function speakAnnouncement(text: string) {
  try {
    const synth = window.speechSynthesis
    if (!synth || typeof synth.speak !== 'function') return
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'zh-CN'
    u.rate = 1.05
    synth.speak(u)
  } catch { /* 语音播报失败不影响主流程 */ }
}

export function cancelAnnouncement() {
  try {
    const synth = window.speechSynthesis
    if (synth && typeof synth.cancel === 'function') synth.cancel()
  } catch { /* ignore */ }
}

export interface UseSpeechTimerDeps {
  /** 持久化的评估状态（session.speechEval）——面板侧传，用于环节记录/设置/语音提醒 */
  evalState: ComputedRef<SpeechEvalState>
  /** 持久化补丁写入 */
  persist: (patch: Partial<SpeechEvalState>) => void
}

export function useSpeechTimer(deps?: UseSpeechTimerDeps) {
  const { t } = useI18n()

  const phase = computed<'green' | 'yellow' | 'red'>(() => {
    const rem = timerRemainingMs.value
    if (rem <= redAtSec.value * 1000) return 'red'
    if (rem <= yellowAtSec.value * 1000) return 'yellow'
    return 'green'
  })

  const timerDisplay = computed(() => {
    const rem = timerRemainingMs.value
    if (rem > 0) return fmtSec(rem / 1000)
    return `+${fmtSec(-rem / 1000)}`
  })

  const remainingSec = computed(() => Math.max(0, timerRemainingMs.value / 1000))

  const phaseLabel = computed(() => {
    const map = {
      green: t('meeting.speechEval.greenCard'),
      yellow: t('meeting.speechEval.yellowCard'),
      red: t('meeting.speechEval.redCard'),
    }
    return map[phase.value]
  })

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
    resetVoiceFlags()
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

  // ── 面板功能层（deps 提供时启用） ──

  const timerLabel = ref('')

  const timerRecords = computed<SpeechTimerRecord[]>(() => deps?.evalState.value.timerRecords || [])

  // ---------- 串场计时（主持人过渡/串场用时） ----------
  // 与演讲环节共用同一份走表运行态：切换模式只影响记录标签，
  // 报告里按标签汇总串场用时，让 AI 在时间把控评分中体现串场是否拖沓。
  const transitionRecords = computed(() =>
    timerRecords.value.filter(r => r.label.includes(t('meeting.speechEval.transitionLabel'))),
  )
  const transitionTotalSec = computed(() => transitionRecords.value.reduce((a, r) => a + r.durationSec, 0))

  function transitionLabel(): string {
    const n = transitionRecords.value.length + 1
    return `${t('meeting.speechEval.transitionLabel')} ${n}`
  }

  /** 切换"演讲计时/串场计时"模式；切换时若计时器已停，清零准备新一段计时。 */
  function switchTimerMode(mode: 'segment' | 'transition') {
    timerMode.value = mode
    if (!timerRunning.value) {
      reset()
    }
  }

  function nextLabel(): string {
    const n = timerRecords.value.length + 1
    return `${t('meeting.speechEval.segmentLabelPrefix')} ${n}`
  }

  function recordSegment() {
    if (!deps) return
    const duration = durationSec.value - timerRemainingMs.value / 1000
    const overtimeSec = Math.max(0, -timerRemainingMs.value / 1000)
    const isTransition = timerMode.value === 'transition'
    const record: SpeechTimerRecord = {
      label: isTransition ? transitionLabel() : (timerLabel.value.trim() || nextLabel()),
      durationSec: duration,
      overtimeSec,
      timestamp: Date.now(),
    }
    deps.persist({ timerRecords: [...deps.evalState.value.timerRecords, record] })
    timerLabel.value = ''
    reset()
  }

  function removeRecord(index: number) {
    if (!deps) return
    const records = [...deps.evalState.value.timerRecords]
    records.splice(index, 1)
    deps.persist({ timerRecords: records })
  }

  // ---------- 计时设置对话框 ----------

  const showSettings = ref(false)
  const settingsDuration = ref(180)
  const settingsYellow = ref(30)
  const settingsRed = ref(10)

  function openSettings() {
    if (!deps) return
    settingsDuration.value = deps.evalState.value.timerDurationSec
    settingsYellow.value = deps.evalState.value.yellowAtSec
    settingsRed.value = deps.evalState.value.redAtSec
    showSettings.value = true
  }

  function saveSettings() {
    if (!deps) return
    const next = {
      timerDurationSec: Math.max(10, Math.round(settingsDuration.value || 180)),
      yellowAtSec: Math.max(0, Math.round(settingsYellow.value || 30)),
      redAtSec: Math.max(0, Math.round(settingsRed.value || 10)),
    }
    deps.persist(next)
    // 立即同步共享计时器阈值并重置为满时长（不依赖 store 回流的 watch 时序）。
    setThresholds({ durationSec: next.timerDurationSec, yellowAtSec: next.yellowAtSec, redAtSec: next.redAtSec })
    reset()
    showSettings.value = false
  }

  // ---------- 计时语音提醒（黄牌/红牌/时间到 语音播报，persist 开关） ----------

  const voiceAlert = computed(() => deps?.evalState.value.voiceAlert !== false)

  function toggleVoiceAlert() {
    if (!deps) return
    deps.persist({ voiceAlert: !voiceAlert.value })
  }

  // 副作用仅在使用面板层（deps）时注册；MeetingView 的无 deps 调用不注册。
  if (deps) {
    // 红黄绿牌切换时语音提醒
    watch(phase, (p) => {
      if (!timerRunning.value || !voiceAlert.value) return
      if (lastVoicePhase === null) { lastVoicePhase = p; return }
      if (p !== lastVoicePhase) {
        lastVoicePhase = p
        if (p === 'yellow') {
          speakAnnouncement(`黄牌，还剩 ${Math.ceil(timerRemainingMs.value / 1000)} 秒`)
        } else if (p === 'red') {
          speakAnnouncement('红牌，请注意时间')
        }
      }
    })

    // 超时瞬间语音提醒
    watch(timerRemainingMs, (ms) => {
      if (!timerRunning.value || !voiceAlert.value) return
      if (ms <= 0 && !voiceWasOver) {
        voiceWasOver = true
        speakAnnouncement('时间到，请结束发言')
      } else if (ms > 0) {
        voiceWasOver = false
      }
    })
  }

  return {
    // 共享状态（单例）
    timerRunning,
    timerRemainingMs,
    timerMode,
    phase,
    display: timerDisplay,
    remainingSec,
    phaseLabel,
    fmtSec,
    setThresholds,
    reset,
    toggle,
    stop,
    // 面板功能层（deps 缺省时记录/设置/提醒为 no-op）
    timerLabel,
    timerRecords,
    transitionRecords,
    transitionTotalSec,
    switchTimerMode,
    recordSegment,
    removeRecord,
    voiceAlert,
    toggleVoiceAlert,
    cancelAnnouncement,
    resetVoiceFlags,
    showSettings,
    settingsDuration,
    settingsYellow,
    settingsRed,
    openSettings,
    saveSettings,
  }
}
