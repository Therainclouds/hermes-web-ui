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

// ── 法律沟通场景（legal）结构化字段 ──

/** 风险清单条目：level 与优先级映射（urgent→high, attention→medium, normal→low）。 */
export interface RiskItem {
  level: 'high' | 'medium' | 'low'
  text: string
  quote?: string
  lawHint?: string
}

/** 各方立场（本轮新增的主张）。 */
export interface Position {
  party: string
  stance: string
}

/** 法条/法规引用。LLM 输出一律 verified: false（需人工核实），仅核实工具可置 true。 */
export interface LawRef {
  name: string
  article?: string
  note?: string
  verified?: boolean
}

// ── 客户访谈场景（interview）结构化字段 ──

/** 洞察条目：客户访谈中实时提取的需求/痛点/机会/竞品提及。 */
export interface InsightItem {
  type: 'need' | 'pain' | 'opportunity' | 'competitor'
  text: string
  quote?: string
}

/** 客户关键引语（有场景、可指导决策的原话）。 */
export interface KeyQuote {
  quote: string
  speaker?: string
}

/** 参与度（客户关系风险信号）：urgent 语义由 Hook 白名单归一。 */
export type Engagement = 'engaged' | 'neutral' | 'distracted' | 'at_risk'

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
  // 法律沟通场景（legal）结构化字段
  riskItems?: RiskItem[]      // 风险清单（≤10 条，去重后）
  positions?: Position[]      // 各方立场（≤8 条，去重后）
  lawRefs?: LawRef[]          // 法条/法规引用（≤8 条，一律需人工核实）
  // 客户访谈场景（interview）结构化字段
  insights?: InsightItem[]    // 洞察流（≤4 条/轮，去重后）
  keyQuotes?: KeyQuote[]      // 客户关键引语（≤3 条/轮，去重后）
  followUps?: string[]        // 建议追问（≤2 条/轮）
  engagement?: Engagement     // 参与度（本轮快照）
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

// ── 客户访谈场景确定性护栏（Hook 层，I1）──

/** at_risk 白名单：仅客户关系风险语义允许（其余 distracted）。 */
const AT_RISK_RE = /不满|终止|终止合作|取消合作|换掉|失望|投诉|unhappy|churn|cancel/i

/**
 * 访谈场景确定性护栏，parse 出口统一执行（interview 字段存在时）：
 *
 *  - H-I1 洞察上限：insights ≤ 4 条（type 白名单已在 parse 阶段过滤）
 *  - H-I2 引语去重与上限：keyQuotes 按 quote 去重，≤ 3 条
 *  - H-I3 追问上限：followUps ≤ 2 条
 *  - H-I4 参与度归一：at_risk 仅限客户关系风险语义命中，否则降级 distracted
 */
export function applyInterviewGuards(round: AnalysisRound): AnalysisRound {
  let out = round

  // H-I1 洞察上限
  if (out.insights && out.insights.length > 4) out = { ...out, insights: out.insights.slice(0, 4) }

  // H-I2 引语去重与上限
  if (out.keyQuotes?.length) {
    const seen = new Set<string>()
    const deduped: KeyQuote[] = []
    for (const q of out.keyQuotes) {
      const key = q.quote.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      deduped.push(q)
      if (deduped.length >= 3) break
    }
    out = { ...out, keyQuotes: deduped }
  }

  // H-I3 追问上限
  if (out.followUps && out.followUps.length > 2) out = { ...out, followUps: out.followUps.slice(0, 2) }

  // H-I4 参与度归一
  if (out.engagement === 'at_risk' && !AT_RISK_RE.test(`${out.keyPoint} ${out.analysis} ${out.context}`)) {
    out = { ...out, engagement: 'distracted' }
  }

  return out
}

export interface ParseAnalysisOptions {
  /** 实际已发言秒数（H1 赘语阈值判定用；由 speechContext 的设置时长-当前倒计时推得） */
  speechDurationSec?: number
}

// ── 法律场景确定性护栏（Hook 层，L1） ──

/** urgent 白名单：仅时效届满/重大权利放弃/情绪失控语义允许 urgent（H-L1）。 */
const URGENT_WHITELIST_RE = /(时效|期限)[^。]{0,8}(届满|将至|临近)|放弃(权利|继承|抗辩|担保)|情绪失控|当庭|(撤销|解除)[^。]{0,6}(权|合同)/

/**
 * 法律场景确定性护栏，parse 出口执行：
 *
 *  - H-L1 urgent 白名单：不在白名单语义的 urgent 降级 attention。
 *  - H-L2 法条纪律：lawRefs 无核实来源一律 verified: false + note 追加
 *    "需人工核实"（禁编造纪律的代码保证）。
 *  - H-L3 去重：riskItems 按 text、lawRefs 按 name+article、positions 按
 *    party+stance 去重。
 */
export function applyLegalGuards(round: AnalysisRound): AnalysisRound {
  let out = round

  // H-L1 urgent 白名单
  if (out.priority === 'urgent') {
    const text = `${out.keyPoint} ${out.analysis} ${out.context}`
    if (!URGENT_WHITELIST_RE.test(text)) {
      out = { ...out, priority: 'attention' }
    }
  }

  // H-L3 去重 + H-L2 法条纪律
  if (out.riskItems?.length) {
    const seen = new Set<string>()
    out = { ...out, riskItems: out.riskItems.filter(r => {
      const key = r.text?.trim()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 10) }
  }
  if (out.positions?.length) {
    const seen = new Set<string>()
    out = { ...out, positions: out.positions.filter(p => {
      const key = `${p.party?.trim()}|${p.stance?.trim()}`
      if (!p.party?.trim() || seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 8) }
  }
  if (out.lawRefs?.length) {
    const seen = new Set<string>()
    out = { ...out, lawRefs: out.lawRefs.filter(l => {
      const key = `${l.name?.trim()}|${l.article?.trim()}`
      if (!l.name?.trim() || seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 8).map(l => l.verified
      ? l
      : { ...l, verified: false, note: l.note ? `${l.note}（需人工核实）` : '需人工核实' }) }
  }

  return out
}

/** legal 场景结构化字段的解析钳制（来自 LLM 的原始数组）。 */
function parseLegalFields(parsed: any): {
  riskItems?: RiskItem[]
  positions?: Position[]
  lawRefs?: LawRef[]
} {
  const riskItems = Array.isArray(parsed.riskItems)
    ? parsed.riskItems
        .filter((r: any) => r && typeof r.text === 'string' && ['high', 'medium', 'low'].includes(r.level))
        .slice(0, 12)
        .map((r: any) => ({
          level: r.level,
          text: r.text.slice(0, 200),
          ...(typeof r.quote === 'string' && r.quote ? { quote: r.quote.slice(0, 200) } : {}),
          ...(typeof r.lawHint === 'string' && r.lawHint ? { lawHint: r.lawHint.slice(0, 120) } : {}),
        }))
    : undefined
  const positions = Array.isArray(parsed.positions)
    ? parsed.positions
        .filter((p: any) => p && typeof p.party === 'string' && typeof p.stance === 'string')
        .slice(0, 10)
        .map((p: any) => ({ party: p.party.slice(0, 60), stance: p.stance.slice(0, 200) }))
    : undefined
  const lawRefs = Array.isArray(parsed.lawRefs)
    ? parsed.lawRefs
        .filter((l: any) => l && typeof l.name === 'string')
        .slice(0, 10)
        .map((l: any) => ({
          name: l.name.slice(0, 120),
          ...(typeof l.article === 'string' && l.article ? { article: l.article.slice(0, 120) } : {}),
          ...(typeof l.note === 'string' && l.note ? { note: l.note.slice(0, 200) } : {}),
        }))
    : undefined
  return {
    ...(riskItems?.length ? { riskItems } : {}),
    ...(positions?.length ? { positions } : {}),
    ...(lawRefs?.length ? { lawRefs } : {}),
  }
}

// ── 客户访谈场景（interview）字段解析 ──

const INSIGHT_TYPES = ['need', 'pain', 'opportunity', 'competitor'] as const

function parseInterviewFields(parsed: any): {
  insights?: InsightItem[]
  keyQuotes?: KeyQuote[]
  followUps?: string[]
  engagement?: Engagement
} {
  const insights = Array.isArray(parsed.insights)
    ? parsed.insights
        .filter((i: any) => i && typeof i.text === 'string' && (INSIGHT_TYPES as readonly string[]).includes(i.type))
        .slice(0, 6)
        .map((i: any) => ({
          type: i.type,
          text: i.text.slice(0, 200),
          ...(typeof i.quote === 'string' && i.quote ? { quote: i.quote.slice(0, 200) } : {}),
        }))
    : undefined
  const keyQuotes = Array.isArray(parsed.keyQuotes)
    ? parsed.keyQuotes
        .filter((q: any) => q && typeof q.quote === 'string')
        .slice(0, 5)
        .map((q: any) => ({
          quote: q.quote.slice(0, 200),
          ...(typeof q.speaker === 'string' && q.speaker ? { speaker: q.speaker.slice(0, 60) } : {}),
        }))
    : undefined
  const followUps = Array.isArray(parsed.followUps)
    ? parsed.followUps.filter((f: any) => typeof f === 'string' && f.trim()).slice(0, 4).map((f: string) => f.slice(0, 150))
    : undefined
  const engagement = ['engaged', 'neutral', 'distracted', 'at_risk'].includes(parsed.engagement)
    ? (parsed.engagement as Engagement)
    : undefined
  return {
    ...(insights?.length ? { insights } : {}),
    ...(keyQuotes?.length ? { keyQuotes } : {}),
    ...(followUps?.length ? { followUps } : {}),
    ...(engagement ? { engagement } : {}),
  }
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
  /** 用户手动记录（语法官/肢体语言观察），随上下文注入让 AI 结合点评 */
  manualNotes?: {
    goodPhrases?: string[]
    grammarNotes?: string[]
    bodyNotes?: string[]
  }
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
      // 法律场景结构化字段（存在即视为 legal 轮次，应用法律护栏）
      const legalFields = parseLegalFields(parsed)
      const withLegal = { ...round, ...legalFields }
      const guarded = applyLegalGuards(withLegal)

      // 访谈场景结构化字段（存在即视为 interview 轮次，应用访谈护栏）
      const interviewFields = parseInterviewFields(parsed)
      const withInterview = { ...guarded, ...interviewFields }
      const interviewGuarded = applyInterviewGuards(withInterview)

      // Hook 层：设备官过滤 / 赘语阈值 / 3+1 强制
      return applySpeechGuards(interviewGuarded, options?.speechDurationSec)
  } catch {
    logger.warn('[meeting-assist] failed to parse LLM response as JSON: %s', raw.slice(0, 100))
    return null
  }
}
