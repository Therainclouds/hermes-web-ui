// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { useSpeechTimer, fmtSec } from '@/composables/useSpeechTimer'
import type { SpeechEvalState } from '@/stores/hermes/meeting'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => `i18n:${key}` }),
}))

function makeEvalState(overrides: Partial<SpeechEvalState> = {}) {
  const state = ref<SpeechEvalState>({
    timerDurationSec: 180,
    yellowAtSec: 30,
    redAtSec: 10,
    timerRecords: [],
    fillerWords: {},
    wordOfTheDay: '',
    wotdUsedCount: 0,
    goodPhrases: [],
    grammarNotes: [],
    ...overrides,
  })
  const persist = vi.fn((patch: Partial<SpeechEvalState>) => {
    state.value = { ...state.value, ...patch }
  })
  return { evalState: computed(() => state.value), persist, state }
}

// 计时器状态是模块级单例：每个用例前重置，避免相互污染。
beforeEach(() => {
  const t = useSpeechTimer()
  t.setThresholds({ durationSec: 180, yellowAtSec: 30, redAtSec: 10 })
  t.reset()
})

describe('useSpeechTimer（共享单例核心）', () => {
  it('fmtSec formats seconds as mm:ss', () => {
    expect(fmtSec(0)).toBe('00:00')
    expect(fmtSec(65.4)).toBe('01:05')
    expect(fmtSec(-3)).toBe('00:00')
  })

  it('setThresholds seeds the remaining time; negative remainder shows overtime', () => {
    const timer = useSpeechTimer()
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    expect(timer.timerRemainingMs.value).toBe(60_000)
    expect(timer.display.value).toBe('01:00')

    timer.timerRemainingMs.value = -5_000
    expect(timer.display.value).toBe('+00:05')
  })

  it('classifies the phase from the synced thresholds', () => {
    const timer = useSpeechTimer()
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    // 满时长 → green；剩余进入红牌阈值 → red
    expect(timer.phase.value).toBe('green')
    timer.timerRemainingMs.value = 0
    expect(timer.phase.value).toBe('red')
  })

  it('shares state across two composable instances (MeetingView ↔ panel sync)', () => {
    const a = useSpeechTimer()
    const b = useSpeechTimer()
    a.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    a.toggle()
    expect(b.timerRunning.value).toBe(true)
    // 单例走表中 b 看到同一份剩余时间
    const before = b.timerRemainingMs.value
    expect(before).toBeLessThanOrEqual(60_000)
    a.stop()
    expect(b.timerRunning.value).toBe(false)
  })

  it('toggle pauses by wall-clock and stop settles the remainder', () => {
    const timer = useSpeechTimer()
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    timer.toggle()
    timer.toggle() // 暂停
    expect(timer.timerRunning.value).toBe(false)
    expect(timer.timerRemainingMs.value).toBeLessThanOrEqual(60_000)

    timer.toggle()
    timer.stop()
    expect(timer.timerRunning.value).toBe(false)
    expect(timer.timerRemainingMs.value).toBeLessThanOrEqual(60_000)
  })
})

describe('useSpeechTimer（面板功能层，deps 启用）', () => {
  it('records a segment with computed duration/overtime and resets the timer', () => {
    const { evalState, persist } = makeEvalState()
    evalState.value.timerDurationSec = 60
    const timer = useSpeechTimer({ evalState, persist })
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    timer.timerRemainingMs.value = 50_000 // 已用 10 秒
    timer.timerLabel.value = '开场'

    timer.recordSegment()

    expect(persist).toHaveBeenCalledTimes(1)
    const record = evalState.value.timerRecords[0]
    expect(record.label).toBe('开场')
    expect(record.durationSec).toBeCloseTo(10, 5)
    expect(record.overtimeSec).toBe(0)
    expect(record.kind).toBe('segment')
    // 记录后清空标签并重置计时器
    expect(timer.timerLabel.value).toBe('')
    expect(timer.timerRemainingMs.value).toBe(60_000)
  })

  it('first segment spans from the timer start wall-clock to the click', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(500_000)
      const { evalState, persist } = makeEvalState()
      evalState.value.timerDurationSec = 60
      const timer = useSpeechTimer({ evalState, persist })
      timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
      timer.timerLabel.value = '开场介绍/燕灵'
      timer.toggle() // 开始走表：区间起点锚定
      vi.setSystemTime(540_000)

      timer.recordSegment()

      const record = evalState.value.timerRecords[0]
      expect(record.startTs).toBe(500_000)
      expect(record.timestamp).toBe(540_000)
      expect(record.durationSec).toBeCloseTo(40, 5)
      expect(record.overtimeSec).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('next segments span from the previous record timestamp to the click', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { evalState, persist } = makeEvalState()
      evalState.value.timerDurationSec = 60
      evalState.value.timerRecords = [
        { label: '开场介绍/燕灵', durationSec: 30, overtimeSec: 0, timestamp: 900_000, startTs: 870_000, kind: 'segment' },
      ]
      const timer = useSpeechTimer({ evalState, persist })
      timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
      timer.timerLabel.value = '小组共创/UU'

      timer.recordSegment()

      const record = evalState.value.timerRecords[1]
      expect(record.startTs).toBe(900_000) // 上一条记录时刻 → 本次点击
      expect(record.timestamp).toBe(1_000_000)
      expect(record.durationSec).toBeCloseTo(100, 5)
      expect(record.overtimeSec).toBeCloseTo(40, 5)
      expect(record.kind).toBe('segment')
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-labels segments when no label was typed', () => {
    const { evalState, persist } = makeEvalState()
    evalState.value.timerRecords = [
      { label: '段落 1', durationSec: 10, overtimeSec: 0, timestamp: 1 },
      { label: '段落 2', durationSec: 10, overtimeSec: 0, timestamp: 2 },
    ]
    const timer = useSpeechTimer({ evalState, persist })
    timer.setThresholds({ durationSec: 180, yellowAtSec: 30, redAtSec: 10 })
    timer.recordSegment()
    expect(evalState.value.timerRecords[2].label).toBe('i18n:meeting.speechEval.segmentLabelPrefix 3')
  })

  it('removes a record by index', () => {
    const { evalState, persist } = makeEvalState()
    const recordB = { label: 'b', durationSec: 2, overtimeSec: 0, timestamp: 2 }
    evalState.value.timerRecords = [
      { label: 'a', durationSec: 1, overtimeSec: 0, timestamp: 1 },
      recordB,
    ]
    const timer = useSpeechTimer({ evalState, persist })
    timer.removeRecord(0)
    expect(persist).toHaveBeenCalledWith({ timerRecords: [recordB] })
  })

  it('clamps settings on save, syncs thresholds and resets to the new duration', () => {
    const { evalState, persist } = makeEvalState({ timerDurationSec: 60 })
    const timer = useSpeechTimer({ evalState, persist })
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })

    timer.openSettings()
    expect(timer.showSettings.value).toBe(true)
    timer.settingsDuration.value = 5      // below min → clamped to 10
    timer.settingsYellow.value = -3       // below min → clamped to 0
    timer.settingsRed.value = 12.6        // rounds to 13
    timer.saveSettings()

    expect(persist).toHaveBeenCalledWith({ timerDurationSec: 10, yellowAtSec: 0, redAtSec: 13 })
    expect(timer.showSettings.value).toBe(false)
    expect(timer.timerRemainingMs.value).toBe(10_000)
  })

  it('no-ops panel features when deps are omitted (MeetingView usage)', () => {
    const timer = useSpeechTimer()
    expect(timer.timerRecords.value).toEqual([])
    timer.recordSegment()
    timer.removeRecord(0)
    timer.openSettings()
    timer.saveSettings()
    expect(timer.showSettings.value).toBe(false)
  })
})

describe('useSpeechTimer（计时模式 / 串场 / 语音提醒）', () => {
  it('switchTimerMode switches mode and resets the ticker when stopped', () => {
    const { evalState, persist } = makeEvalState()
    const timer = useSpeechTimer({ evalState, persist })
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })

    timer.switchTimerMode('transition')
    expect(timer.timerMode.value).toBe('transition')
    // 已停表：切换时清零为满时长
    expect(timer.timerRemainingMs.value).toBe(60_000)
  })

  it('records transition segments with auto transition labels', () => {
    const { evalState, persist } = makeEvalState({ timerDurationSec: 60 })
    const timer = useSpeechTimer({ evalState, persist })
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    timer.switchTimerMode('transition')
    timer.timerRemainingMs.value = 50_000 // 已用 10 秒

    timer.recordSegment()

    const record = evalState.value.timerRecords[0]
    expect(record.label).toBe('i18n:meeting.speechEval.transitionLabel 1')
    expect(record.durationSec).toBeCloseTo(10, 5)
  })

  it('aggregates transition records separately from segment records', () => {
    const { evalState } = makeEvalState()
    evalState.value.timerRecords = [
      { label: '段落 1', durationSec: 60, overtimeSec: 0, timestamp: 1 },
      { label: 'i18n:meeting.speechEval.transitionLabel 1', durationSec: 15, overtimeSec: 0, timestamp: 2 },
      { label: 'i18n:meeting.speechEval.transitionLabel 2', durationSec: 25, overtimeSec: 0, timestamp: 3 },
    ]
    const timer = useSpeechTimer({ evalState, persist: vi.fn() })
    expect(timer.transitionRecords.value).toHaveLength(2)
    expect(timer.transitionTotalSec.value).toBe(40)
  })

  it('toggles the voice alert through persist', () => {
    const { persist } = makeEvalState({ voiceAlert: true })
    const timer = useSpeechTimer({ evalState: makeEvalState({ voiceAlert: true }).evalState, persist })
    expect(timer.voiceAlert.value).toBe(true)
    timer.toggleVoiceAlert()
    expect(persist).toHaveBeenCalledWith({ voiceAlert: false })
  })

  it('announces yellow card via TTS when phase changes while running', async () => {
    const speak = vi.fn()
    const cancel = vi.fn()
    ;(window as any).speechSynthesis = { cancel, speak }
    ;(window as any).SpeechSynthesisUtterance = class {
      constructor(public text: string) {}
      lang = 'zh-CN'
      rate = 1
    }

    const { evalState, persist } = makeEvalState({ timerDurationSec: 60 })
    const timer = useSpeechTimer({ evalState, persist })
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    timer.toggle()
    // 既有语义：watch 首次触发只建立基线（green→yellow 不播报），
    // 之后的相位变化才播报——先入黄牌区建基线，再进红牌区触发。
    timer.timerRemainingMs.value = 20_000
    await nextTick()
    timer.timerRemainingMs.value = 5_000
    await nextTick()

    expect(speak).toHaveBeenCalled()
    expect(speak.mock.calls.some(([u]) => String((u as any)?.text).includes('红牌'))).toBe(true)
    delete (window as any).speechSynthesis
  })

  it('does not announce when no deps are provided (MeetingView usage)', async () => {
    const speak = vi.fn()
    ;(window as any).speechSynthesis = { cancel: vi.fn(), speak }
    const { nextTick } = await import('vue')

    const timer = useSpeechTimer()
    timer.setThresholds({ durationSec: 60, yellowAtSec: 30, redAtSec: 10 })
    timer.toggle()
    timer.timerRemainingMs.value = 20_000
    await nextTick()

    expect(speak).not.toHaveBeenCalled()
    timer.stop()
    delete (window as any).speechSynthesis
  })
})
