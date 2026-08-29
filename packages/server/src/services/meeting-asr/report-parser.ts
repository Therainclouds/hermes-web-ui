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

// ── 确定性护栏（Hook 层，S7）：提示词管意图，代码管保证 ──

/** 设备/系统播报不算发言人（"不是多一个设备官"）。 */
const DEVICE_SPEAKER_RE = /设备|系统|播报|device|assistant/i

/**
 * 演讲场景确定性护栏，parse 出口统一执行：
 *
 *  - H3 设备官过滤：speaker 命中设备播报正则的赘语/金句/语法条目剔除。
 *  - H1 赘语阈值（仅提供 speechDurationSec ≥ 60s 时启用）：总赘语数
 *    ≤ 10 个/3 分钟（按实际发言时长折算）时清空 fillerWords，
 *    且不因赘语标 attention（宽容判定不靠 AI 自觉）。
 *  - H2 3+1 强制：highlights 截 3 条、improvements 截 1 条。
 */
export function applySpeechGuards(round: AnalysisRound, speechDurationSec?: number): AnalysisRound {
  let out = round

  // H3 设备官过滤
  const isDevice = (sp?: string) => !!sp && DEVICE_SPEAKER_RE.test(sp)
  if (out.fillerWords?.length) out = { ...out, fillerWords: out.fillerWords.filter(f => !isDevice(f.speaker)) }
  if (out.goldenQuotes?.length) out = { ...out, goldenQuotes: out.goldenQuotes.filter(q => !isDevice(q.speaker)) }
  if (out.grammarIssues?.length) out = { ...out, grammarIssues: out.grammarIssues.filter(g => !isDevice(g.speaker)) }

  // H1 赘语阈值（宽容判定）
  if (out.fillerWords?.length && speechDurationSec && speechDurationSec >= 60) {
    const allowed = 10 * (speechDurationSec / 180)
    const total = out.fillerWords.reduce((a, f) => a + f.count, 0)
    if (total <= allowed) {
      out = { ...out, fillerWords: undefined }
      if (out.priority === 'attention') out = { ...out, priority: 'normal' }
    }
  }

  // H2 3+1 强制
  if (out.highlights && out.highlights.length > 3) out = { ...out, highlights: out.highlights.slice(0, 3) }
  if (out.improvements && out.improvements.length > 1) out = { ...out, improvements: out.improvements.slice(0, 1) }

  return out
}

export interface ParseAnalysisOptions {
  /** 实际已发言秒数（H1 赘语阈值判定用；由 speechContext 的设置时长-当前倒计时推得） */
  speechDurationSec?: number
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
export function parseAnalysisRound(raw: string, options?: ParseAnalysisOptions): AnalysisRound | null {
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
    const round: AnalysisRound = {
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
      // Hook 层：设备官过滤 / 赘语阈值 / 3+1 强制
      return applySpeechGuards(round, options?.speechDurationSec)
  } catch {
    logger.warn('[meeting-assist] failed to parse LLM response as JSON: %s', raw.slice(0, 100))
    return null
  }
}
