// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildSegmentRanges,
  buildSpeakerTimeline,
  isTransitionRecord,
  normalizeSegmentLabel,
  resolveActiveSegmentSpeaker,
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

describe('normalizeSegmentLabel（记录时标签归一化）', () => {
  it('裸姓名补上自动环节名前缀', () => {
    expect(normalizeSegmentLabel('燕灵', '环节 1')).toBe('环节 1 / 燕灵')
    expect(normalizeSegmentLabel('  燕灵  ', '环节 2')).toBe('环节 2 / 燕灵')
  })

  it('带斜杠的标签原样保留', () => {
    expect(normalizeSegmentLabel('开场介绍/燕灵', '环节 1')).toBe('开场介绍/燕灵')
    expect(normalizeSegmentLabel('开场介绍 / 燕灵', '环节 1')).toBe('开场介绍 / 燕灵')
  })

  it('空标签回退到自动环节名', () => {
    expect(normalizeSegmentLabel('', '环节 3')).toBe('环节 3')
    expect(normalizeSegmentLabel('   ', '环节 3')).toBe('环节 3')
  })
})

describe('buildSpeakerTimeline（用时记录 + 当前标签 → 服务端 speakerTimeline）', () => {
  it('converts recorded ranges into timeline entries and drops records without a speaker', () => {
    const records: SpeechTimerRecord[] = [
      { label: '开场介绍/燕灵', durationSec: 60, overtimeSec: 0, timestamp: 200_000, startTs: 100_000, kind: 'segment' },
      { label: '环节 2', durationSec: 50, overtimeSec: 0, timestamp: 400_000, startTs: 200_000, kind: 'segment' }, // 无 speaker，应被过滤
      { label: '小组共创/UU', durationSec: 100, overtimeSec: 0, timestamp: 600_000, startTs: 400_000, kind: 'segment' },
    ]
    const timeline = buildSpeakerTimeline(records)
    expect(timeline).toEqual([
      { speaker: '燕灵', segment: '开场介绍', startMs: 100_000, endMs: 200_000 },
      { speaker: 'UU', segment: '小组共创', startMs: 400_000, endMs: 600_000 },
    ])
  })

  it('appends an open segment while the timer is running and the label has a speaker', () => {
    const records: SpeechTimerRecord[] = [
      { label: '开场介绍/燕灵', durationSec: 60, overtimeSec: 0, timestamp: 200_000, startTs: 100_000, kind: 'segment' },
    ]
    const timeline = buildSpeakerTimeline(records, {
      timerRunning: true,
      timerLabel: '小组共创 / UU',
      now: 250_000,
      openStartMs: 250_000,
    })
    expect(timeline).toEqual([
      { speaker: '燕灵', segment: '开场介绍', startMs: 100_000, endMs: 200_000 },
      { speaker: 'UU', segment: '小组共创', startMs: 250_000, endMs: Number.MAX_SAFE_INTEGER },
    ])
  })

  it('does NOT append an open segment when timer is not running (防止停止后错归)', () => {
    const timeline = buildSpeakerTimeline([], {
      timerRunning: false,
      timerLabel: '小组共创 / UU',
      now: 1000,
    })
    expect(timeline).toEqual([])
  })

  it('does NOT append an open segment when timerLabel has no speaker part', () => {
    // 「环节 1 /」（斜杠后为空）→ speaker 为空 → 不加入时间线
    const timeline = buildSpeakerTimeline([], {
      timerRunning: true,
      timerLabel: '环节 1 /',
      now: 1000,
    })
    expect(timeline).toEqual([])
  })

  it('裸姓名（无斜杠）的 open 段整体作为 speaker', () => {
    const timeline = buildSpeakerTimeline([], {
      timerRunning: true,
      timerLabel: '张三',
      now: 1000,
    })
    expect(timeline).toEqual([
      { speaker: '张三', segment: undefined, startMs: 1000, endMs: Number.MAX_SAFE_INTEGER },
    ])
  })

  it('open 段起点取 max(now, lastEndMs)，避免回退到已记录区间内', () => {
    const records: SpeechTimerRecord[] = [
      { label: '开场介绍/燕灵', durationSec: 60, overtimeSec: 0, timestamp: 200_000, startTs: 100_000, kind: 'segment' },
    ]
    // now < lastEndMs 应该被钳到 lastEndMs
    const timeline = buildSpeakerTimeline(records, {
      timerRunning: true,
      timerLabel: '小组共创 / UU',
      now: 150_000, // 早于 lastEndMs=200_000
    })
    expect(timeline[1].startMs).toBe(200_000)
  })

  it('transition 记录同样进入时间线（串场人也是"speaker"）', () => {
    const records: SpeechTimerRecord[] = [
      { label: '主持人串场/李主持', durationSec: 30, overtimeSec: 0, timestamp: 100_000, startTs: 70_000, kind: 'transition' },
    ]
    const timeline = buildSpeakerTimeline(records)
    expect(timeline).toEqual([
      { speaker: '李主持', segment: '主持人串场', startMs: 70_000, endMs: 100_000 },
    ])
  })
})

describe('resolveActiveSegmentSpeaker（聚合层反查：当前标签 > 时间线 > fallback）', () => {
  const ranges = buildSegmentRanges([
    { label: '开场介绍/燕灵', durationSec: 100, overtimeSec: 0, timestamp: 200_000, startTs: 100_000, kind: 'segment' },
  ])

  it('当前 timerLabel 有名字时直接返回（不查时间线，假设调用方在走表中才传）', () => {
    expect(resolveActiveSegmentSpeaker('小组共创 / UU', ranges, 150_000, '说话人 1')).toBe('UU')
  })

  it('裸姓名（无斜杠）整体作为演讲者名返回', () => {
    expect(resolveActiveSegmentSpeaker('张三', ranges, 150_000, '说话人 1')).toBe('张三')
  })

  it('斜杠后姓名为空（如「环节 1 /」）时回退到时间线', () => {
    expect(resolveActiveSegmentSpeaker('环节 1 /', ranges, 150_000, '说话人 1')).toBe('燕灵')
  })

  it('当前 timerLabel 为空时回退到时间线', () => {
    expect(resolveActiveSegmentSpeaker('', ranges, 150_000, '说话人 1')).toBe('燕灵')
  })

  it('时间线也没命中且无 fallback 时返回空串', () => {
    expect(resolveActiveSegmentSpeaker('', ranges, 999_000)).toBe('')
  })

  it('fallback 是空串时也按空处理（不让 LLM 拿到"说话人 1"这种东西）', () => {
    expect(resolveActiveSegmentSpeaker('', ranges, 999_000, '')).toBe('')
  })

  it('timerLabel 为 undefined 时安全回退', () => {
    expect(resolveActiveSegmentSpeaker(undefined, ranges, 150_000, '说话人 1')).toBe('燕灵')
  })
})
