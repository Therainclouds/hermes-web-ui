// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildSegmentRanges,
  isTransitionRecord,
  resolveSegmentByTime,
  resolveSegmentSpeaker,
  splitSegmentLabel,
} from '@/utils/speech-segments'
import type { SpeechTimerRecord } from '@/stores/hermes/meeting'

describe('splitSegmentLabel（环节/演讲者标签拆分）', () => {
  it('splits on half-width slash', () => {
    expect(splitSegmentLabel('开场介绍/燕灵')).toEqual({ segment: '开场介绍', speaker: '燕灵' })
  })

  it('splits on full-width slash', () => {
    expect(splitSegmentLabel('小组共创／UU')).toEqual({ segment: '小组共创', speaker: 'UU' })
  })

  it('returns empty speaker when no separator (bare name)', () => {
    expect(splitSegmentLabel('燕灵')).toEqual({ segment: '燕灵', speaker: '' })
    expect(splitSegmentLabel('')).toEqual({ segment: '', speaker: '' })
  })
})

describe('buildSegmentRanges（用时记录 → 墙钟区间）', () => {
  it('uses startTs when present', () => {
    const records: SpeechTimerRecord[] = [
      { label: '开场介绍/燕灵', durationSec: 60, overtimeSec: 0, timestamp: 120_000, startTs: 60_000, kind: 'segment' },
    ]
    expect(buildSegmentRanges(records)).toEqual([
      { label: '开场介绍/燕灵', segment: '开场介绍', speaker: '燕灵', kind: 'segment', startMs: 60_000, endMs: 120_000 },
    ])
  })

  it('infers legacy ranges from the previous record timestamp', () => {
    const records: SpeechTimerRecord[] = [
      { label: '环节 1', durationSec: 30, overtimeSec: 0, timestamp: 100_000 },
      { label: '环节 2', durationSec: 50, overtimeSec: 0, timestamp: 200_000 },
    ]
    const ranges = buildSegmentRanges(records)
    expect(ranges[0].startMs).toBe(70_000) // 首条：timestamp - duration 回推
    expect(ranges[1].startMs).toBe(100_000) // 后续：上一条记录时刻
    expect(ranges[0].kind).toBe('legacy')
  })
})

describe('resolveSegmentByTime / resolveSegmentSpeaker（按时间归属演讲者）', () => {
  const ranges = buildSegmentRanges([
    { label: '开场介绍/燕灵', durationSec: 100, overtimeSec: 0, timestamp: 200_000, startTs: 100_000, kind: 'segment' },
    { label: '小组共创/UU', durationSec: 100, overtimeSec: 0, timestamp: 400_000, startTs: 200_000, kind: 'segment' },
  ])

  it('attributes to the covering segment', () => {
    expect(resolveSegmentByTime(ranges, 150_000)?.speaker).toBe('燕灵')
    expect(resolveSegmentByTime(ranges, 300_000)?.speaker).toBe('UU')
  })

  it('absorbs AI round latency within 60s after the last segment ends', () => {
    expect(resolveSegmentByTime(ranges, 400_000 + 59_999)?.speaker).toBe('UU')
    expect(resolveSegmentByTime(ranges, 400_000 + 60_001)).toBeNull()
  })

  it('prefers the segment speaker over the AI-provided speaker', () => {
    expect(resolveSegmentSpeaker(ranges, 150_000, '说话人 1')).toBe('燕灵')
  })

  it('falls back to the AI speaker when the label has no speaker part', () => {
    const bare = buildSegmentRanges([
      { label: '环节 1', durationSec: 30, overtimeSec: 0, timestamp: 200_000, startTs: 100_000 },
    ])
    expect(resolveSegmentSpeaker(bare, 150_000, '说话人 1')).toBe('说话人 1')
    expect(resolveSegmentSpeaker(bare, 150_000, '')).toBe('')
  })

  it('returns empty string when nothing matches', () => {
    expect(resolveSegmentSpeaker(ranges, 900_000, '说话人 1')).toBe('说话人 1')
    expect(resolveSegmentSpeaker(ranges, 900_000)).toBe('')
  })
})

describe('isTransitionRecord（串场记录识别）', () => {
  it('uses kind when present', () => {
    expect(isTransitionRecord({ label: '串场 1', durationSec: 5, overtimeSec: 0, timestamp: 1, kind: 'transition' }, '串场')).toBe(true)
    expect(isTransitionRecord({ label: '串场 1', durationSec: 5, overtimeSec: 0, timestamp: 1, kind: 'segment' }, '串场')).toBe(false)
  })

  it('falls back to the label prefix for legacy records', () => {
    expect(isTransitionRecord({ label: '串场 2', durationSec: 5, overtimeSec: 0, timestamp: 1 }, '串场')).toBe(true)
    expect(isTransitionRecord({ label: '开场介绍/燕灵', durationSec: 5, overtimeSec: 0, timestamp: 1 }, '串场')).toBe(false)
  })
})
