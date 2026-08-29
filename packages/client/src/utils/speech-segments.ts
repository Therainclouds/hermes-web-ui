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
