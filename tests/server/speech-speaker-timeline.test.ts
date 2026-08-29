import { describe, expect, it } from 'vitest'
import {
  annotateTranscriptSpeakers,
  resolveTimelineSpeaker,
  type SpeakerTimelineEntry,
} from '../../packages/server/src/services/meeting-asr/report-parser'

// 环节-演讲者时间线：开场介绍/燕灵 10:00-11:00，小组共创/UU 11:00-12:00（墙钟 ms）
const timeline: SpeakerTimelineEntry[] = [
  { speaker: '燕灵', segment: '开场介绍', startMs: 1_800_000_000_000, endMs: 1_800_000_060_000 },
  { speaker: 'UU', segment: '小组共创', startMs: 1_800_000_060_000, endMs: 1_800_000_120_000 },
]

describe('resolveTimelineSpeaker（按时间归属环节演讲者）', () => {
  it('attributes to the covering segment', () => {
    expect(resolveTimelineSpeaker(timeline, 1_800_000_030_000)).toBe('燕灵')
    expect(resolveTimelineSpeaker(timeline, 1_800_000_090_000)).toBe('UU')
  })

  it('absorbs AI round latency within 60s after the last segment', () => {
    expect(resolveTimelineSpeaker(timeline, 1_800_000_120_000 + 59_999)).toBe('UU')
    expect(resolveTimelineSpeaker(timeline, 1_800_000_120_000 + 60_001)).toBe('')
  })

  it('returns empty string without timeline or timestamp', () => {
    expect(resolveTimelineSpeaker(undefined, 1_800_000_030_000)).toBe('')
    expect(resolveTimelineSpeaker(timeline, undefined)).toBe('')
    expect(resolveTimelineSpeaker([], 1_800_000_030_000)).toBe('')
  })
})

describe('annotateTranscriptSpeakers（转写句子按时间线标注姓名）', () => {
  it('replaces diarization names with the recorded speaker name', () => {
    const sentences = [
      { speaker: '说话人1', text: '大家好', timestamp: 1_800_000_030_000 },
      { speaker: '说话人2', text: '开始共创', timestamp: 1_800_000_090_000 },
    ]
    expect(annotateTranscriptSpeakers(sentences, timeline)).toEqual([
      { speaker: '燕灵', text: '大家好' },
      { speaker: 'UU', text: '开始共创' },
    ])
  })

  it('keeps the original speaker when no timeline entry matches', () => {
    const sentences = [
      { speaker: '说话人1', text: '大家好', timestamp: 1_800_000_030_000 },
      { speaker: '说话人9', text: '散会', timestamp: 1_800_000_900_000 },
      { speaker: '说话人8', text: '无时间戳' },
    ]
    expect(annotateTranscriptSpeakers(sentences, timeline)).toEqual([
      { speaker: '燕灵', text: '大家好' },
      { speaker: '说话人9', text: '散会' },
      { speaker: '说话人8', text: '无时间戳' },
    ])
  })
})
