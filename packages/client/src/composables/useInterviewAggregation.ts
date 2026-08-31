import { computed, type Ref } from 'vue'
import type { AnalysisRound } from '@/composables/useMeetingAssist'

export type InsightType = 'need' | 'pain' | 'opportunity' | 'competitor'
export type Engagement = 'engaged' | 'neutral' | 'distracted' | 'at_risk'

/** 洞察条目（跨轮次按 type+text 去重累积后）。 */
export interface InterviewInsight {
  type: InsightType
  text: string
  quote?: string
  timestamp: number
}

/** 客户关键引语（跨轮次按 quote 去重累积后）。 */
export interface InterviewKeyQuote {
  quote: string
  speaker?: string
  timestamp: number
}

/** 参与度快照（最新一轮的 engagement）。 */
export type EngagementSnapshot = Engagement | undefined

export interface InterviewSummary {
  needCount: number
  painCount: number
  opportunityCount: number
  competitorCount: number
  quoteCount: number
  followUpCount: number
  engagement: EngagementSnapshot
}

export interface UseInterviewAggregationDeps {
  /** AI 实时点评轮次流（调用方的 useMeetingAssist().rounds——此处不得自建连接） */
  rounds: Ref<AnalysisRound[]>
}

/** 纯函数：跨轮次汇总（状态条等非组合体场景复用）。 */
export function summarizeInterviewRounds(rounds: AnalysisRound[]): InterviewSummary {
  const insights = summarizeInsights(rounds)
  const quoteSeen = new Set<string>()
  let quoteCount = 0
  let followUpCount = 0
  let engagement: EngagementSnapshot
  for (const r of rounds) {
    for (const q of r.keyQuotes || []) {
      const key = q.quote?.trim()
      if (!key || quoteSeen.has(key)) continue
      quoteSeen.add(key)
      quoteCount++
    }
    followUpCount += r.followUps?.length || 0
    if (r.engagement) engagement = r.engagement
  }
  return {
    needCount: insights.filter(i => i.type === 'need').length,
    painCount: insights.filter(i => i.type === 'pain').length,
    opportunityCount: insights.filter(i => i.type === 'opportunity').length,
    competitorCount: insights.filter(i => i.type === 'competitor').length,
    quoteCount,
    followUpCount,
    engagement,
  }
}

function summarizeInsights(rounds: AnalysisRound[]): InterviewInsight[] {
  const seen = new Set<string>()
  const out: InterviewInsight[] = []
  for (const r of rounds) {
    for (const i of r.insights || []) {
      const key = `${i.type}|${i.text?.trim()}`
      if (!i.text?.trim() || seen.has(key)) continue
      seen.add(key)
      out.push({ type: i.type, text: i.text, ...(i.quote ? { quote: i.quote } : {}), timestamp: r.timestamp })
    }
  }
  return out
}

/**
 * 客户访谈场景 AI 轮次聚合（纯累积去重，与 legal 聚合同构）。
 */
export function useInterviewAggregation(deps: UseInterviewAggregationDeps) {
  const roundsRef = deps.rounds

  const insights = computed<InterviewInsight[]>(() => summarizeInsights(roundsRef.value))

  const keyQuotes = computed<InterviewKeyQuote[]>(() => {
    const seen = new Set<string>()
    const out: InterviewKeyQuote[] = []
    for (const r of roundsRef.value) {
      for (const q of r.keyQuotes || []) {
        const key = q.quote?.trim()
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push({ quote: q.quote, ...(q.speaker ? { speaker: q.speaker } : {}), timestamp: r.timestamp })
      }
    }
    return out
  })

  // 追问建议只展示最新一轮的（旧建议随对话推进即失效）
  const latestFollowUps = computed<string[]>(() => {
    for (let i = roundsRef.value.length - 1; i >= 0; i--) {
      const f = roundsRef.value[i].followUps
      if (f && f.length > 0) return f
    }
    return []
  })

  const engagement = computed<EngagementSnapshot>(() => {
    for (let i = roundsRef.value.length - 1; i >= 0; i--) {
      if (roundsRef.value[i].engagement) return roundsRef.value[i].engagement
    }
    return undefined
  })

  const summary = computed<InterviewSummary>(() => summarizeInterviewRounds(roundsRef.value))

  return {
    insights,
    keyQuotes,
    latestFollowUps,
    engagement,
    summary,
  }
}
