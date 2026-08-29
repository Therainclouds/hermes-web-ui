import { logger } from '../logger'

/** 演讲场景中的填充词/赘语（尽量带 speaker，便于按发言人区分）。 */
export interface FillerWord {
  word: string
  count: number
  /** 说话人（转写带 [姓名] 标注时尽量带上，做到按发言人区分） */
  speaker?: string
}

/**
 * 金句——有观点、有感染力、能让人记住、可单独引用的一句话。
 * （替代早期 goodPhrases 字段，保留归一化兼容。）
 */
export interface GoldenQuote {
  /** 金句原文 */
  quote: string
  /** 说话人 */
  speaker?: string
  /** 入选理由（一句话即可） */
  reason?: string
}

/** 演讲场景中的语法/用词问题（带说话人，便于按发言人区分）。 */
export interface GrammarIssue {
  quote: string
  issue: string
  speaker?: string
}

export interface AnalysisRound {
  id: string
  context: string
  priority: 'normal' | 'attention' | 'urgent'
  keyPoint: string
  analysis: string
  timestamp: number
  // 演讲评分场景（Toastmasters 风格）附加字段
  fillerWords?: FillerWord[]
  /** 金句（替代早期 goodPhrases；归一化时仍兼容旧字段）。 */
  goldenQuotes?: GoldenQuote[]
  grammarIssues?: GrammarIssue[]
  wotdUsed?: boolean
  score?: Record<string, number>
  timeNote?: string
  // 增量评价模式：AI 判断本段是否出现新的评价点
  hasNewPoint?: boolean
  highlights?: string[]       // 新增亮点（仅 hasNewPoint 时可能非空；最多 3 条）
  improvements?: string[]     // 新增可提升的点（最多 1 条：最重要且可落地）
  topics?: string[]           // 新增主题（仅 hasNewPoint 时可能非空）
}

/** 环节与发言人时间线条目：由客户端计时员用时记录展开（墙钟毫秒区间）。 */
export interface SpeakerTimelineEntry {
  /** 演讲者姓名（标签"/"后的名字） */
  speaker: string
  /** 环节名（标签"/"前的部分） */
  segment?: string
  startMs: number
  endMs: number
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
  /** 环节-演讲者时间线：句子/点评按时间归属到人工记录的演讲者姓名 */
  speakerTimeline?: SpeakerTimelineEntry[]
}

/** AI 点评轮次有延迟：允许归属到「区间结束后 60s 内」的最近一段（与客户端一致）。 */
export const TIMELINE_MATCH_LATENCY_MS = 60_000

/** 按墙钟时间戳归属环节演讲者名：精确命中优先，其次吸收 60s 延迟；无匹配返回空串。 */
export function resolveTimelineSpeaker(timeline: SpeakerTimelineEntry[] | undefined, tsMs?: number): string {
  if (!timeline || timeline.length === 0 || typeof tsMs !== 'number' || !Number.isFinite(tsMs)) return ''
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (tsMs >= e.startMs && tsMs <= e.endMs) return e.speaker
  }
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    if (tsMs > e.endMs && tsMs - e.endMs <= TIMELINE_MATCH_LATENCY_MS) return e.speaker
  }
  return ''
}

/**
 * 用环节-演讲者时间线标注转写句子：时间戳落入区间的句子把声纹名
 * （"说话人1"）替换为人工记录的真实姓名，让 LLM 直接按姓名归属
 * 赘语/金句/语法问题。未命中区间的句子保留原 speaker。
 */
export function annotateTranscriptSpeakers<T extends { speaker?: string; text: string; timestamp?: number }>(
  sentences: T[],
  timeline?: SpeakerTimelineEntry[],
): Array<{ speaker?: string; text: string }> {
  return (sentences || []).map(s => {
    const name = resolveTimelineSpeaker(timeline, s.timestamp)
    if (name) return { speaker: name, text: s.text }
    return { speaker: s.speaker, text: s.text }
  })
}

/**
 * 归一化金句列表：兼容 string[] 与 {quote, speaker?, reason?}[] 两种模型输出。
 * （合并自 realtime-assist.ts 的 normalizeGoldenQuotes。）
 */
export function normalizeGoldenQuotes(raw: unknown): GoldenQuote[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: GoldenQuote[] = []
  for (const q of raw) {
    if (typeof q === 'string') {
      const s = q.trim()
      if (s) out.push({ quote: s.slice(0, 120) })
    } else if (q && typeof q === 'object' && typeof q.quote === 'string') {
      const quote = q.quote.trim().slice(0, 120)
      if (!quote) continue
      out.push({
        quote,
        ...(typeof q.speaker === 'string' && q.speaker.trim() ? { speaker: q.speaker.trim().slice(0, 30) } : {}),
        ...(typeof q.reason === 'string' && q.reason.trim() ? { reason: q.reason.trim().slice(0, 120) } : {}),
      })
    }
    if (out.length >= 10) break
  }
  return out.length ? out : undefined
}

/**
 * 把 LLM 返回的原始文本解析成 AnalysisRound（拆分自 realtime-assist.ts，行为保持一致）。
 *
 * 兼容 markdown 代码围栏包裹的 JSON；对演讲评分场景的多余字段做长度/数值
 * 裁剪；任何解析失败都返回 null 并打 warn（不抛错——分析是尽力而为的旁路）。
 *
 * 归一化：
 * - goldenQuotes 同时支持新字段与旧字段 goodPhrases（string[] 或对象数组）；
 * - fillerWords / grammarIssues 上的 speaker 字段（按发言人区分）。
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
          .map((f: any) => ({
            word: f.word.slice(0, 30),
            count: Math.max(0, Math.round(Number(f.count))),
            ...(typeof f.speaker === 'string' && f.speaker.trim() ? { speaker: f.speaker.trim().slice(0, 30) } : {}),
          }))
      : undefined
    // 金句：归一化（兼容旧字段 goodPhrases）
    const goldenQuotes = normalizeGoldenQuotes(parsed.goldenQuotes ?? parsed.goodPhrases)
    const grammarIssues = Array.isArray(parsed.grammarIssues)
      ? parsed.grammarIssues
          .filter((g: any) => g && typeof g.quote === 'string')
          .slice(0, 10)
          .map((g: any) => ({
            quote: g.quote.slice(0, 120),
            issue: typeof g.issue === 'string' ? g.issue.slice(0, 200) : '',
            ...(typeof g.speaker === 'string' && g.speaker.trim() ? { speaker: g.speaker.trim().slice(0, 30) } : {}),
          }))
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

    // 演讲评分场景：只要有任何一项内容就保留该轮（评分/赘语/金句/语法/新评价点也算）。
    const hasSpeechContent = !!keyPoint || !!analysis || !!fillerWords?.length || !!goldenQuotes?.length
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
      ...(goldenQuotes ? { goldenQuotes } : {}),
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
