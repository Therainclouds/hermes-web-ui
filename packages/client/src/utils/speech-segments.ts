import type { SpeechTimerRecord } from '@/stores/hermes/meeting'

/**
 * 演讲评分场景的「环节用时记录 → 演讲者归属」工具。
 *
 * 计时员每点一次「记录本段用时」，就产生一段墙钟时间区间
 * （上一条记录时刻 → 本次点击时刻），标签形如「开场介绍/燕灵」：
 * "/" 前是环节名、后是演讲者名。赘语/金句/语法问题等 AI 实时点评
 * 统一按点评轮次时间戳落入的区间来归属演讲者——让「谁的赘语/
 * 谁的语法问题」以人工记录的环节-演讲者为准，而不是仅依赖 AI
 * 自带的 speaker 字段（声纹分离出的 "说话人 1" 之类）。
 */

/** 标签分隔符：全角/半角斜杠均可 */
const LABEL_SEPARATOR_RE = /[／/]/

/** AI 点评轮次有延迟：允许归属到「区间结束后 60s 内」的最近一段 */
export const SEGMENT_MATCH_LATENCY_MS = 60_000

export interface SpeechSegmentRange {
  /** 完整标签，如「开场介绍/燕灵」 */
  label: string
  /** 演讲者名（标签无 "/" 时为空串） */
  speaker: string
  /** 环节名（标签无 "/" 时为整个标签） */
  segment: string
  /** 记录类型；旧数据（无 kind 字段）为 legacy */
  kind: 'segment' | 'transition' | 'legacy'
  /** 区间起点墙钟毫秒 */
  startMs: number
  /** 区间终点墙钟毫秒（即记录点击时刻） */
  endMs: number
}

/** 拆分「环节/演讲者」标签；无分隔符时 speaker 为空串 */
export function splitSegmentLabel(label: string): { segment: string; speaker: string } {
  const raw = (label || '').trim()
  const idx = raw.search(LABEL_SEPARATOR_RE)
  if (idx === -1) return { segment: raw, speaker: '' }
  return { segment: raw.slice(0, idx).trim(), speaker: raw.slice(idx + 1).trim() }
}

/**
 * 记录时的标签归一化：用户只输入姓名（无斜杠）时补上自动环节名前缀，
 * 统一为「环节 / 演讲者」形态。否则裸姓名会被当成环节名，演讲者归属
 * 整条链路（时间线 → 句子 speaker → LLM 点评）全部拿不到名字。
 * - raw 为空：返回 fallbackSegment（自动「环节 N」）
 * - raw 带斜杠：原样保留（用户显式指定环节 + 姓名）
 * - raw 裸姓名：`${fallbackSegment} / ${raw}`
 */
export function normalizeSegmentLabel(raw: string, fallbackSegment: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return fallbackSegment
  if (LABEL_SEPARATOR_RE.test(trimmed)) return trimmed
  return fallbackSegment ? `${fallbackSegment} / ${trimmed}` : trimmed
}

/** 把用时记录展开为墙钟区间（旧数据缺 startTs 时按上一条记录时刻/时长回推） */
export function buildSegmentRanges(records: SpeechTimerRecord[]): SpeechSegmentRange[] {
  return (records || []).map((r, i) => {
    const startMs = typeof r.startTs === 'number' && r.startTs > 0
      ? r.startTs
      : (i > 0 ? records[i - 1].timestamp : r.timestamp - Math.max(0, r.durationSec) * 1000)
    const { segment, speaker } = splitSegmentLabel(r.label)
    return {
      label: r.label,
      segment,
      speaker,
      kind: r.kind || 'legacy',
      startMs,
      endMs: r.timestamp,
    }
  })
}

/**
 * 按时间戳归属环节：优先精确落入区间；否则归到「刚结束 60s 内」
 * 的最近一段（吸收 AI 轮次的出结果延迟）。无匹配返回 null。
 */
export function resolveSegmentByTime(ranges: SpeechSegmentRange[], ts: number): SpeechSegmentRange | null {
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (ts >= ranges[i].startMs && ts <= ranges[i].endMs) return ranges[i]
  }
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (ts > ranges[i].endMs && ts - ranges[i].endMs <= SEGMENT_MATCH_LATENCY_MS) return ranges[i]
  }
  return null
}

/** 归属演讲者名：区间命中且标签带演讲者时优先用区间名，否则回退（如 AI 自带 speaker） */
export function resolveSegmentSpeaker(ranges: SpeechSegmentRange[], ts: number, fallback?: string): string {
  const hit = resolveSegmentByTime(ranges, ts)
  return hit?.speaker || (fallback || '').trim()
}

/** 是否串场记录：优先看 kind，旧数据按标签前缀识别 */
export function isTransitionRecord(record: SpeechTimerRecord, transitionLabelPrefix: string): boolean {
  if (record.kind) return record.kind === 'transition'
  return (record.label || '').startsWith(transitionLabelPrefix)
}

/**
 * 服务端 SpeakerTimelineEntry 同形条目：{ speaker, segment?, startMs, endMs }。
 * 由客户端把"已记录环节用时 + 当前走表中的标签"展开，供：
 *   1) ASR final 反查给 sentence.speaker 写入（前端立即生效）
 *   2) buildSpeechContext 推给服务端 annotateTranscriptSpeakers
 *   3) 前端聚合层 speakerDurations / aiFillerBySpeaker 兜底
 * endMs 缺省为 Number.MAX_SAFE_INTEGER（"open 段"）：对所有未来 ts 都精确命中，
 * 让用户开始走表但还没点"记录本段用时"期间的 ASR 句子也能归属到当前标签。
 */
export interface SpeakerTimelineEntry {
  speaker: string
  segment?: string
  startMs: number
  endMs: number
}

/** buildSpeakerTimeline 的可选参数：用于把"当前走表中的标签"展开成 open 段 */
export interface BuildSpeakerTimelineOptions {
  /** 当前计时器输入框（timerLabel）的内容：形如 "环节 / 演讲者" */
  timerLabel?: string
  /** 计时器是否在走表；只有 true 时 open 段才生效（避免 stop 后还把句子错归到当前标签） */
  timerRunning?: boolean
  /** 当前墙钟毫秒；不传则用 Date.now() */
  now?: number
  /** open 段的起点；不传则用 now（开始走表的瞬间） */
  openStartMs?: number
}

/**
 * 把已记录的 SpeechTimerRecord + 当前走表中的标签展开为完整 speakerTimeline。
 *
 * 行为：
 * - 已记录记录：直接展成 [startTs, timestamp] 区间
 * - timerRunning + timerLabel 非空：追加一条 open 段 [openStartMs ?? now, +∞)，speaker 取自标签
 * - timerLabel 没有斜杠（split 后 speaker 空）：open 段的 speaker 为空串，
 *   下游 resolveActiveSegmentSpeaker 会回退到 fallback —— 这是有意设计：
 *   "用户没填名字就别让 LLM 瞎编"
 */
export function buildSpeakerTimeline(
  records: SpeechTimerRecord[] | undefined,
  options: BuildSpeakerTimelineOptions = {},
): SpeakerTimelineEntry[] {
  const ranges = buildSegmentRanges(records || [])
  const out: SpeakerTimelineEntry[] = []
  let lastEndMs = 0
  for (const r of ranges) {
    if (!r.speaker) continue // 跳过无演讲者名的记录（避免空串污染时间线）
    out.push({
      speaker: r.speaker,
      segment: r.segment,
      startMs: r.startMs,
      endMs: r.endMs,
    })
    if (r.endMs > lastEndMs) lastEndMs = r.endMs
  }

  const timerRunning = !!options.timerRunning
  const timerLabel = (options.timerLabel || '').trim()
  if (timerRunning && timerLabel) {
    let speaker: string
    let segment: string | undefined
    if (LABEL_SEPARATOR_RE.test(timerLabel)) {
      const parts = splitSegmentLabel(timerLabel)
      speaker = parts.speaker
      segment = parts.segment || undefined
    } else {
      // 裸姓名（无斜杠）：用户直接输入演讲者名，整体作为 speaker
      speaker = timerLabel
    }
    if (speaker) {
      const now = typeof options.now === 'number' ? options.now : Date.now()
      // open 段起点：优先用传入的 openStartMs（用于精确测试），否则用 max(now, lastEndMs)
      const startMs = typeof options.openStartMs === 'number'
        ? options.openStartMs
        : Math.max(now, lastEndMs)
      out.push({
        speaker,
        segment,
        startMs,
        endMs: Number.MAX_SAFE_INTEGER,
      })
    }
  }
  return out
}

/**
 * 给聚合层（speakerDurations）用：按 ts 反查 speaker。
 * 优先级：timerLabel 实时展开（如果运行中）> 时间线区间 > fallback。
 *
 * 注意：调用方负责保证 ranges 是当前最新的（用 buildSegmentRanges 或 buildSpeakerTimeline）。
 * 当 timerLabel 为空或 timerRunning=false 时，本函数退化为 resolveSegmentSpeaker(ranges, ts, fallback)。
 */
export function resolveActiveSegmentSpeaker(
  timerLabel: string | undefined,
  ranges: SpeechSegmentRange[] | undefined,
  ts: number,
  fallback?: string,
): string {
  const trimmed = (timerLabel || '').trim()
  if (trimmed) {
    if (LABEL_SEPARATOR_RE.test(trimmed)) {
      // 「环节 / 姓名」形态：取斜杠后的姓名；姓名为空（如"环节 1/"）则落到时间线
      const { speaker } = splitSegmentLabel(trimmed)
      if (speaker) return speaker
    } else {
      // 裸姓名：用户直接输入的就是演讲者名（timerLabel 只由用户键入，自动编号不会进入这里）
      return trimmed
    }
  }
  return resolveSegmentSpeaker(ranges || [], ts, fallback)
}
