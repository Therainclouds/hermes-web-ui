import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { SpeechEvalState } from '@/stores/hermes/meeting'

/** AI 实时点评轮次中赘语/好词/语法相关的最小结构（来自 useMeetingAssist 的 rounds）。 */
export interface AssistRoundLike {
  fillerWords?: Array<{ word: string; count: number }>
  goodPhrases?: string[]
  grammarIssues?: Array<{ quote: string; issue: string }>
  wotdUsed?: boolean
}

export interface UseSpeechFillerCounterDeps {
  /** 持久化的评估状态（session.speechEval，缺省用 DEFAULT_EVAL） */
  evalState: ComputedRef<SpeechEvalState>
  /** 持久化补丁写入 */
  persist: (patch: Partial<SpeechEvalState>) => void
  /** AI 实时点评轮次流（Socket.IO） */
  rounds: Ref<AssistRoundLike[]>
}

/**
 * 填充词（赘语）统计（拆分自 SpeechEvaluationPanel.vue，行为保持一致）。
 *
 * 展示值 = AI 检测汇总（aiFillerTotals）+ 手动修正（evalState.fillerWords），
 * 两者分开计数、展示时合并；手动删除只作用于纯手动添加的词。
 */
export function useSpeechFillerCounter(deps: UseSpeechFillerCounterDeps) {
  const aiFillerTotals = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = {}
    for (const r of deps.rounds.value) {
      for (const f of r.fillerWords || []) {
        totals[f.word] = (totals[f.word] || 0) + f.count
      }
    }
    return totals
  })

  // 赘语展示 = AI 检测汇总 + 手动修正
  const fillerWords = computed<Record<string, number>>(() => {
    const merged: Record<string, number> = { ...deps.evalState.value.fillerWords }
    for (const [w, c] of Object.entries(aiFillerTotals.value)) {
      merged[w] = (merged[w] || 0) + c
    }
    return merged
  })

  const fillerTotal = computed(() => Object.values(fillerWords.value).reduce((a, b) => a + b, 0))

  // 手动修正只累加在 evalState.fillerWords（与 AI 检测分开计数，展示时合并）
  function incrementFiller(word: string) {
    deps.persist({ fillerWords: { ...deps.evalState.value.fillerWords, [word]: (deps.evalState.value.fillerWords[word] || 0) + 1 } })
  }

  // 仅允许删除纯手动添加的词（AI 检测的词由 AI 数据驱动，删除无意义）
  function removeFiller(word: string) {
    const next = { ...deps.evalState.value.fillerWords }
    delete next[word]
    deps.persist({ fillerWords: next })
  }

  // ---------- 赘语记录员 (Ah-Counter) ----------

  const newFiller = ref('')

  function addFiller() {
    const word = newFiller.value.trim()
    if (!word) return
    // 手动登记该词（保留当前合并计数，使其可被删除；AI 词只读）
    deps.persist({ fillerWords: { ...deps.evalState.value.fillerWords, [word]: deps.evalState.value.fillerWords[word] || 0 } })
    newFiller.value = ''
  }

  return {
    aiFillerTotals,
    fillerWords,
    fillerTotal,
    incrementFiller,
    removeFiller,
    newFiller,
    addFiller,
  }
}
