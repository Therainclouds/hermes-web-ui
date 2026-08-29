import { inject, provide, reactive, type InjectionKey, type UnwrapNestedRefs } from 'vue'
import { useSpeechTimer } from '@/composables/useSpeechTimer'

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
    throw new Error('SpeechTimerCard/SettingsDialog must be used inside SpeechEvaluationPanel (provideSpeechTimer missing)')
  }
  return api
}
