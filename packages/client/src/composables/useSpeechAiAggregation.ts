import { computed, type ComputedRef, type Ref } from 'vue'
import type { AnalysisRound, GoldenQuote, GrammarIssue } from '@/composables/useMeetingAssist'
import type { MeetingSession } from '@/stores/hermes/meeting'
import { buildSegmentRanges, resolveActiveSegmentSpeaker } from '@/utils/speech-segments'

/** 评分卡的固定标签映射（i18n key）。 */
export const SCORE_LABEL_MAP: Record<string, string> = {
  content: 'meeting.speechEval.scoreContent',
  structure: 'meeting.speechEval.scoreStructure',
  language: 'meeting.speechEval.scoreLanguage',
  timeControl: 'meeting.speechEval.scoreTimeControl',
  overall: 'meeting.speechEval.scoreOverall',
}

/** 轮次里赘语的最小结构（带 speaker，便于按发言人区分）。 */
interface RoundFillerWord {
  word: string
  count: number
  speaker?: string
}

/** 按演讲者分组累积的评价区（亮点/提升点/主题）；speaker 为空串表示「未标注」桶 */
export interface SpeechSpeakerSection {
  speaker: string
  highlights: string[]
  improvements: string[]
  topics: string[]
}

export interface SpeechAiAggregationDeps {
  /** AI 实时点评轮次流（调用方的 useMeetingAssist().rounds——此处不得自建连接） */
  rounds: Ref<AnalysisRound[]>
  /** 当前会议（发言人用时从转写时间戳估算） */
  session?: Ref<MeetingSession | undefined> | ComputedRef<MeetingSession | undefined>
  /**
   * 当前计时器标签（演讲者在 SpeechTimerOverlay 输入的内容）。
   * 传入后，sentence.speaker 为空时会按 [当前标签 → 已记录时间线 → fallback] 反查归属，
   * 让"走表但还没点记录本段用时"期间的句子也能计入发言人用时。
   * 不传则维持原行为（仅靠 sentence.speaker 字段）。
   */
  timerLabel?: Ref<string>
  /** 计时器是否在走表——只有 true 时 timerLabel 反查才生效（防止停止后错归） */
  timerRunning?: Ref<boolean>
}

/**
 * 演讲场景 AI 实时点评聚合（自 SpeechEvaluationPanel 抽出，行为保持一致）。
 *
 * 全部为跨轮次去重/累积的只读 computed：
 *  - 实时评分（最新一轮非空 score，更新式展示）
 *  - 增量评价：亮点/改进点/主题（AI 每轮只报新增项，这里跨轮累积去重）
 *  - 仅 hasNewPoint 的"新点评"轮次
 *  - 金句（按发言人）/语法问题（按发言人）/每日一词使用次数
 *  - 赘语按发言人汇总、发言人用时（由转写时间戳估算）
 */
export function useSpeechAiAggregation(deps: SpeechAiAggregationDeps) {
  const roundsRef = deps.rounds
  const sessionRef = deps.session as ComputedRef<MeetingSession | undefined> | undefined

  // 赘语按发言人汇总（跨轮次累计）
  const aiFillerBySpeaker = computed(() => {
    const map = new Map<string, { speaker: string; totals: Record<string, number>; total: number }>()
    for (const r of roundsRef.value) {
      for (const f of (r as AnalysisRound & { fillerWords?: RoundFillerWord[] }).fillerWords || []) {
        const sp = f.speaker?.trim() || ''
        if (!sp) continue
        let entry = map.get(sp)
        if (!entry) {
          entry = { speaker: sp, totals: {}, total: 0 }
          map.set(sp, entry)
        }
        entry.totals[f.word] = (entry.totals[f.word] || 0) + f.count
        entry.total += f.count
      }
    }
    return [...map.entries()].map(([speaker, v]) => ({ speaker, totals: v.totals, total: v.total }))
  })

  // 金句（定义：有观点、有感染力、能让人记住、可单独引用的一句话），按发言人区分
  const aiGoldenQuotes = computed<GoldenQuote[]>(() => {
    const seen = new Set<string>()
    const out: GoldenQuote[] = []
    for (const r of roundsRef.value) {
      for (const q of r.goldenQuotes || []) {
        if (!q?.quote) continue
        if (!seen.has(q.quote)) { seen.add(q.quote); out.push(q) }
      }
    }
    return out
  })

  const aiGrammarIssues = computed<GrammarIssue[]>(() => {
    const seen = new Set<string>()
    const out: GrammarIssue[] = []
    for (const r of roundsRef.value) {
      for (const g of r.grammarIssues || []) {
        const key = `${g.quote}|${g.issue}`
        if (!seen.has(key)) { seen.add(key); out.push(g) }
      }
    }
    return out
  })

  const aiWotdUsedCount = computed(() => roundsRef.value.filter(r => r.wotdUsed).length)

  // 只有 AI 判断出现新的评价点（hasNewPoint === true）的轮次才作为"新点评"弹出
  const newPointRounds = computed(() => roundsRef.value.filter(r => r.hasNewPoint === true))

  // 最新一轮评分：评分不弹出新卡，而是作为"更新中的数值"实时刷新
  const liveScore = computed<Record<string, number> | undefined>(() => {
    for (let i = roundsRef.value.length - 1; i >= 0; i--) {
      const s = roundsRef.value[i].score
      if (s && Object.keys(s).length > 0) return s
    }
    return undefined
  })

  const scoreUpdatedAt = computed(() => {
    for (let i = roundsRef.value.length - 1; i >= 0; i--) {
      const s = roundsRef.value[i].score
      if (s && Object.keys(s).length > 0) return roundsRef.value[i].timestamp
    }
    return undefined
  })

  // 亮点 / 改进点 / 主题：跨轮次累积并去重（AI 每轮只报新增项）
  function uniqueStrings(items: string[] | undefined): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const it of items || []) {
      const s = it?.trim()
      if (s && !seen.has(s)) { seen.add(s); out.push(s) }
    }
    return out
  }

  const highlights = computed(() => uniqueStrings(roundsRef.value.flatMap(r => r.highlights || [])))
  const improvements = computed(() => uniqueStrings(roundsRef.value.flatMap(r => r.improvements || [])))
  const topics = computed(() => uniqueStrings(roundsRef.value.flatMap(r => r.topics || [])))

  // ── 按演讲者分组（多演讲者场景：评分/评价独立记分牌） ──

  /** 每位演讲者的最新评分（round.speaker 由服务端按批次句子确定性推导） */
  const speakerScores = computed<Array<{ speaker: string; score: Record<string, number>; updatedAt: number }>>(() => {
    const bySpeaker = new Map<string, { speaker: string; score: Record<string, number>; updatedAt: number }>()
    for (const r of roundsRef.value) {
      const sp = r.speaker?.trim()
      if (!sp) continue
      const s = r.score
      if (!s || Object.keys(s).length === 0) continue
      bySpeaker.set(sp, { speaker: sp, score: s, updatedAt: r.timestamp })
    }
    return [...bySpeaker.values()].sort((a, b) => a.updatedAt - b.updatedAt)
  })

  /** 按演讲者分组累积亮点/提升点/主题（round.speaker 为空的轮次归入「未标注」桶 ''） */
  const speakerSections = computed<SpeechSpeakerSection[]>(() => {
    const bySpeaker = new Map<string, SpeechSpeakerSection>()
    for (const r of roundsRef.value) {
      const sp = r.speaker?.trim() || ''
      let section = bySpeaker.get(sp)
      if (!section) {
        section = { speaker: sp, highlights: [], improvements: [], topics: [] }
        bySpeaker.set(sp, section)
      }
      pushUnique(section.highlights, r.highlights)
      pushUnique(section.improvements, r.improvements)
      pushUnique(section.topics, r.topics)
    }
    return [...bySpeaker.values()]
  })

  function pushUnique(target: string[], items: string[] | undefined) {
    for (const item of items || []) {
      const s = item?.trim()
      if (s && !target.includes(s)) target.push(s)
    }
  }

  // 发言人用时（由转写时间戳估算，用于时间把控/串场分析）
  // 设备/系统播报不算发言人（"不是多一个设备官"）
  const DEVICE_SPEAKER_RE = /设备|系统|device|assistant|播报/i

  const speakerDurations = computed<Array<{ speaker: string; durationSec: number }>>(() => {
    const sentences = sessionRef?.value?.sentences || []
    // 计时器标签反查所需的"已记录区间"：仅在调用方传了 timerLabel/timerRunning 时才构建。
    // 在响应式闭包里读取 deps.timerRunning.value 以保证依赖被追踪。
    const ranges = (deps.timerLabel || deps.timerRunning)
      ? buildSegmentRanges(sessionRef?.value?.speechEval?.timerRecords || [])
      : []
    const useActiveResolver = !!deps.timerLabel && !!deps.timerRunning

    const bySpeaker: Record<string, number> = {}
    const order: string[] = []
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i]
      let sp = (s.speaker || '').trim()
      // speaker 缺失时按 [当前标签（仅走表） → 已记录时间线] 反查
      if (!sp && useActiveResolver) {
        sp = resolveActiveSegmentSpeaker(
          deps.timerLabel!.value,
          ranges,
          s.timestamp,
          '',
        )
      }
      if (!sp || DEVICE_SPEAKER_RE.test(sp)) continue
      let durMs = 0
      if (typeof s.startTime === 'number' && typeof s.endTime === 'number') {
        durMs = s.endTime - s.startTime
      } else if (typeof s.timestamp === 'number') {
        const next = sentences[i + 1]?.timestamp
        durMs = typeof next === 'number' && next > s.timestamp ? next - s.timestamp : 0
      }
      // 单句上限 30s：避免录音暂停等大间隔把时长撑爆
      durMs = Math.min(Math.max(0, durMs), 30_000)
      if (!(sp in bySpeaker)) order.push(sp)
      bySpeaker[sp] = (bySpeaker[sp] || 0) + durMs
    }
    return order
      .map(sp => ({ speaker: sp, durationSec: Math.round(bySpeaker[sp] / 1000) }))
      .filter(d => d.durationSec > 0)
  })

  return {
    rounds: roundsRef,
    aiFillerBySpeaker,
    aiGoldenQuotes,
    aiGrammarIssues,
    aiWotdUsedCount,
    newPointRounds,
    liveScore,
    scoreUpdatedAt,
    highlights,
    improvements,
    topics,
    speakerScores,
    speakerSections,
    speakerDurations,
  }
}
