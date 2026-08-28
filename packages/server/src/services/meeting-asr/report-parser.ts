import { logger } from '../logger'

export interface AnalysisRound {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  keyPoint: string
  analysis: string
  timestamp: number
  // 演讲评分场景（Toastmasters 风格）附加字段
  fillerWords?: Array<{ word: string; count: number }>
  goodPhrases?: string[]
  grammarIssues?: Array<{ quote: string; issue: string }>
  wotdUsed?: boolean
  score?: Record<string, number>
  timeNote?: string
  // 增量评价模式：AI 判断本段是否出现新的评价点
  hasNewPoint?: boolean
  highlights?: string[]       // 新增亮点（仅 hasNewPoint 时可能非空）
  improvements?: string[]     // 新增可提升的点（仅 hasNewPoint 时可能非空）
  topics?: string[]           // 新增主题（仅 hasNewPoint 时可能非空）
}

/** 演讲评分场景的评估上下文：随分析批次注入提示词，供 AI 实时点评/评分。 */
export interface SpeechContext {
  wordOfTheDay?: string
  timerDurationSec?: number
  yellowAtSec?: number
  redAtSec?: number
  timerRecords?: Array<{ label: string; durationSec: number; overtimeSec: number }>
  currentRemainingSec?: number
  currentPhase?: 'green' | 'yellow' | 'red'
}

/**
 * 把 LLM 返回的原始文本解析成 AnalysisRound（拆分自 realtime-assist.ts，行为保持一致）。
 *
 * 兼容 markdown 代码围栏包裹的 JSON；对演讲评分场景的多余字段做长度/数值
 * 裁剪；任何解析失败都返回 null 并打 warn（不抛错——分析是尽力而为的旁路）。
 */
export function parseAnalysisRound(raw: string): AnalysisRound | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
    const parsed = JSON.parse(cleaned)

    const keyPoint = typeof parsed.keyPoint === 'string' ? parsed.keyPoint.trim() : ''
    const analysis = typeof parsed.analysis === 'string' ? parsed.analysis.trim() : ''
    const fillerWords = Array.isArray(parsed.fillerWords)
      ? parsed.fillerWords
          .filter((f: any) => f && typeof f.word === 'string' && Number.isFinite(Number(f.count)))
          .slice(0, 20)
          .map((f: any) => ({ word: f.word.slice(0, 30), count: Math.max(0, Math.round(Number(f.count))) }))
      : undefined
    const goodPhrases = Array.isArray(parsed.goodPhrases)
      ? parsed.goodPhrases.filter((p: any) => typeof p === 'string').slice(0, 10).map((p: string) => p.slice(0, 120))
      : undefined
    const grammarIssues = Array.isArray(parsed.grammarIssues)
      ? parsed.grammarIssues
          .filter((g: any) => g && typeof g.quote === 'string')
          .slice(0, 10)
          .map((g: any) => ({ quote: g.quote.slice(0, 120), issue: typeof g.issue === 'string' ? g.issue.slice(0, 200) : '' }))
      : undefined
    const score = parsed.score && typeof parsed.score === 'object' && !Array.isArray(parsed.score)
      ? Object.fromEntries(
          Object.entries(parsed.score)
            .filter(([, v]) => Number.isFinite(Number(v)))
            .map(([k, v]) => [k.slice(0, 20), Math.max(0, Math.min(100, Math.round(Number(v))))]),
        )
      : undefined
    const hasNewPoint = typeof parsed.hasNewPoint === 'boolean' ? parsed.hasNewPoint : undefined
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights.filter((h: any) => typeof h === 'string').slice(0, 8).map((h: string) => h.slice(0, 120))
      : undefined
    const improvements = Array.isArray(parsed.improvements)
      ? parsed.improvements.filter((i: any) => typeof i === 'string').slice(0, 8).map((i: string) => i.slice(0, 120))
      : undefined
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.filter((tp: any) => typeof tp === 'string').slice(0, 8).map((tp: string) => tp.slice(0, 80))
      : undefined

    // 演讲评分场景：只要有任何一项内容就保留该轮（评分/赘语/好词好句/新评价点也算）。
    const hasSpeechContent = !!keyPoint || !!analysis || !!fillerWords?.length || !!goodPhrases?.length
      || !!grammarIssues?.length || !!score || !!highlights?.length || !!improvements?.length || !!topics?.length || hasNewPoint === true
    if (!parsed || !hasSpeechContent) {
      return null
    }

    const now = Date.now()
    return {
      id: `round-${now}`,
      context: typeof parsed.context === 'string' ? parsed.context.slice(0, 200) : '',
      priority: (['normal', 'attention', 'urgent'].includes(parsed.priority) ? parsed.priority : 'normal') as AnalysisRound['priority'],
      keyPoint: keyPoint.slice(0, 120),
      analysis: analysis.slice(0, 500),
      timestamp: now,
      ...(fillerWords ? { fillerWords } : {}),
      ...(goodPhrases ? { goodPhrases } : {}),
      ...(grammarIssues ? { grammarIssues } : {}),
        ...(typeof parsed.wotdUsed === 'boolean' ? { wotdUsed: parsed.wotdUsed } : {}),
        ...(score ? { score } : {}),
        ...(typeof parsed.timeNote === 'string' ? { timeNote: parsed.timeNote.slice(0, 200) } : {}),
        ...(hasNewPoint !== undefined ? { hasNewPoint } : {}),
        ...(highlights ? { highlights } : {}),
        ...(improvements ? { improvements } : {}),
        ...(topics ? { topics } : {}),
      }
  } catch {
    logger.warn('[meeting-assist] failed to parse LLM response as JSON: %s', raw.slice(0, 100))
    return null
  }
}
