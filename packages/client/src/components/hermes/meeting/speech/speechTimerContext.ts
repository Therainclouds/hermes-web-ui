import { inject, provide, reactive, type InjectionKey, type UnwrapNestedRefs } from 'vue'
import { useSpeechTimer } from '@/composables/useSpeechTimer'
import type { SpeechEvalState } from '@/stores/hermes/meeting'

/** 演讲评估状态默认值（MeetingView 与 SpeechEvaluationPanel 共享）。 */
export const DEFAULT_EVAL: SpeechEvalState = {
  timerDurationSec: 180,
  yellowAtSec: 30,
  redAtSec: 10,
  timerRecords: [],
  // 赘语词表不再预置：由 AI 实时分析检测并汇总（手动 +1 仅作补充修正）
  fillerWords: {},
  wordOfTheDay: '',
  wotdUsedCount: 0,
  goodPhrases: [],
  grammarNotes: [],
  // 肢体语言与台风：AI 看不到画面，由人工观察记录，报告据此点评
  bodyNotes: [],
  // 计时声音提醒（黄牌/红牌/时间到 语音播报），默认开启
  voiceAlert: true,
}

/**
 * SpeechTimerCard / SpeechTimerSettingsDialog 与宿主面板之间的共享计时器上下文。
 *
 * 面板以 deps 创建唯一实例（reactive 包装使模板直接访问解包后的状态），
 * 子组件注入使用——保证 TTS 副作用 watch 只在面板实例注册一次。
 */
export type SpeechTimerViewModel = UnwrapNestedRefs<ReturnType<typeof useSpeechTimer>>

const SpeechTimerKey: InjectionKey<SpeechTimerViewModel> = Symbol('speech-timer')

export function provideSpeechTimer(deps: Parameters<typeof useSpeechTimer>[0]): SpeechTimerViewModel {
  const api = reactive(useSpeechTimer(deps))
  provide(SpeechTimerKey, api)
  return api
}

export function injectSpeechTimer(): SpeechTimerViewModel {
  const api = inject(SpeechTimerKey)
  if (!api) {
    throw new Error('SpeechTimerCard/SettingsDialog must be used inside a provider (provideSpeechTimer missing)')
  }
  return api
}

/**
 * 面板入口：优先注入 MeetingView 创建的实例（保证记录/提醒副作用只注册
 * 一次）；独立挂载（测试等场景）时自行创建并 provide。
 */
export function useSpeechTimerInjectOrCreate(deps: Parameters<typeof useSpeechTimer>[0]): SpeechTimerViewModel {
  const existing = inject(SpeechTimerKey, null)
  if (existing) return existing
  const api = reactive(useSpeechTimer(deps))
  provide(SpeechTimerKey, api)
  return api
}
