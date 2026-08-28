// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useSpeechTimer } from '@/composables/useSpeechTimer'
import { useSpeechFillerCounter } from '@/composables/useSpeechFillerCounter'
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

describe('useSpeechTimer', () => {
  it('formats seconds as mm:ss', () => {
    const { fmtSec } = useSpeechTimer(makeEvalState())
    expect(fmtSec(0)).toBe('00:00')
    expect(fmtSec(65.4)).toBe('01:05')
    expect(fmtSec(-3)).toBe('00:00')
  })

  it('starts full and displays remaining time; negative remainder shows overtime', () => {
    const { timerDisplay, timerRemainingMs, resetTimer } = useSpeechTimer(makeEvalState({ timerDurationSec: 60 }))
    resetTimer()
    expect(timerRemainingMs.value).toBe(60_000)
    expect(timerDisplay.value).toBe('01:00')

    timerRemainingMs.value = -5_000
    expect(timerDisplay.value).toBe('+00:05')
  })

  it('classifies the phase from yellow/red thresholds', () => {
    const { phase } = useSpeechTimer(makeEvalState({ yellowAtSec: 30, redAtSec: 10 }))
    // 剩余 0ms（未开始）→ red
    expect(phase.value).toBe('red')
  })

  it('records a segment with computed duration/overtime and resets the timer', () => {
    const { persist, evalState } = makeEvalState({ timerDurationSec: 60 })
    const timer = useSpeechTimer({ evalState, persist })
    timer.resetTimer()
    timer.timerRemainingMs.value = 50_000 // 已用 10 秒
    timer.timerLabel.value = '开场'

    timer.recordSegment()

    expect(persist).toHaveBeenCalledTimes(1)
    const record = evalState.value.timerRecords[0]
    expect(record.label).toBe('开场')
    expect(record.durationSec).toBeCloseTo(10, 5)
    expect(record.overtimeSec).toBe(0)
    // 记录后清空标签并重置计时器
    expect(timer.timerLabel.value).toBe('')
    expect(timer.timerRemainingMs.value).toBe(60_000)
  })

  it('auto-labels segments when no label was typed', () => {
    const { persist, evalState } = makeEvalState()
    evalState.value.timerRecords = [
      { label: '段落 1', durationSec: 10, overtimeSec: 0, timestamp: 1 },
      { label: '段落 2', durationSec: 10, overtimeSec: 0, timestamp: 2 },
    ]
    const timer = useSpeechTimer({ evalState, persist })
    timer.resetTimer()
    timer.recordSegment()
    expect(evalState.value.timerRecords[2].label).toBe('i18n:meeting.speechEval.segmentLabelPrefix 3')
  })

  it('removes a record by index', () => {
    const { persist, evalState } = makeEvalState()
    const recordB = { label: 'b', durationSec: 2, overtimeSec: 0, timestamp: 2 }
    evalState.value.timerRecords = [
      { label: 'a', durationSec: 1, overtimeSec: 0, timestamp: 1 },
      recordB,
    ]
    const timer = useSpeechTimer({ evalState, persist })
    timer.removeRecord(0)
    expect(persist).toHaveBeenCalledWith({ timerRecords: [recordB] })
  })

  it('clamps settings on save and resets the timer to the new duration', () => {
    const { persist, evalState } = makeEvalState({ timerDurationSec: 60 })
    const timer = useSpeechTimer({ evalState, persist })
    timer.resetTimer()

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
})

describe('useSpeechFillerCounter', () => {
  function setup(fillers: Record<string, number>, aiRounds: Array<{ fillerWords?: Array<{ word: string; count: number }> }> = []) {
    const { evalState, persist, state } = makeEvalState({ fillerWords: fillers })
    const rounds = ref(aiRounds)
    const counter = useSpeechFillerCounter({ evalState, persist, rounds })
    return { counter, persist, state, rounds }
  }

  it('merges manual corrections with AI-detected totals', () => {
    const { counter } = setup({ '然后': 2 }, [
      { fillerWords: [{ word: '那个', count: 3 }, { word: '然后', count: 1 }] },
    ])
    expect(counter.fillerWords.value).toEqual({ '然后': 3, '那个': 3 })
    expect(counter.fillerTotal.value).toBe(6)
  })

  it('increments only the manual counter (AI data stays read-only)', () => {
    const { counter, persist } = setup({ '嗯': 1 })
    counter.incrementFiller('嗯')
    expect(persist).toHaveBeenCalledWith({ fillerWords: { '嗯': 2 } })
  })

  it('removes only manually added words', () => {
    const { counter, persist } = setup({ '嗯': 1 })
    counter.removeFiller('嗯')
    expect(persist).toHaveBeenCalledWith({ fillerWords: {} })
  })

  it('registers a new filler with count 0 so it becomes removable', () => {
    const { counter, persist } = setup({})
    counter.newFiller.value = '那个'
    counter.addFiller()
    expect(persist).toHaveBeenCalledWith({ fillerWords: { '那个': 0 } })
    expect(counter.newFiller.value).toBe('')
  })

  it('ignores blank input', () => {
    const { counter, persist } = setup({})
    counter.newFiller.value = '   '
    counter.addFiller()
    expect(persist).not.toHaveBeenCalled()
  })
})
