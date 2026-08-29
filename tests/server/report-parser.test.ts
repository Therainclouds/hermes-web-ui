import { describe, expect, it } from 'vitest'
import { parseAnalysisRound } from '../../packages/server/src/services/meeting-asr/report-parser'

describe('parseAnalysisRound', () => {
  it('parses a plain JSON round with the core fields', () => {
    const round = parseAnalysisRound(JSON.stringify({
      keyPoint: '  需求确认  ',
      analysis: '团队对齐了交付时间',
      context: ' kickoff ',
      priority: 'attention',
    }))

    expect(round).not.toBeNull()
    expect(round!.keyPoint).toBe('需求确认')
    expect(round!.analysis).toBe('团队对齐了交付时间')
    // context 只截断不 trim（与拆分前行为一致）
    expect(round!.context).toBe(' kickoff ')
    expect(round!.priority).toBe('attention')
    expect(round!.id).toMatch(/^round-\d+$/)
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n{"keyPoint":"kp","analysis":"an"}\n```'
    const round = parseAnalysisRound(raw)
    expect(round).not.toBeNull()
    expect(round!.keyPoint).toBe('kp')
  })

  it('returns null for non-JSON output', () => {
    expect(parseAnalysisRound('这不是 JSON')).toBeNull()
    expect(parseAnalysisRound('')).toBeNull()
  })

  it('returns null when the round has no usable content (speech fields included)', () => {
    expect(parseAnalysisRound('{}')).toBeNull()
    expect(parseAnalysisRound(JSON.stringify({ context: '只有上下文' }))).toBeNull()
  })

  it('keeps a speech round that only carries score/filler data', () => {
    const round = parseAnalysisRound(JSON.stringify({
      fillerWords: [{ word: '然后', count: 3 }],
    }))
    expect(round).not.toBeNull()
    expect(round!.fillerWords).toEqual([{ word: '然后', count: 3 }])
  })

  it('normalizes an unknown priority back to normal', () => {
    const round = parseAnalysisRound(JSON.stringify({ keyPoint: 'kp', priority: 'catastrophic' }))
    expect(round!.priority).toBe('normal')
  })

  it('filters and clamps filler word entries', () => {
    const round = parseAnalysisRound(JSON.stringify({
      keyPoint: 'kp',
      fillerWords: [
        { word: 'ok', count: 2.7 },        // rounds to 3
        { word: 'bad', count: 'x' },       // dropped (non-finite)
        { nope: true },                    // dropped (missing word)
        { word: 'x'.repeat(50), count: -5 }, // word truncated to 30, count clamped to 0
      ],
    }))
    expect(round!.fillerWords).toEqual([
      { word: 'ok', count: 3 },
      { word: 'x'.repeat(30), count: 0 },
    ])
  })

  it('clamps score values into [0, 100] and truncates keys', () => {
    const longKey = 'k'.repeat(30)
    const round = parseAnalysisRound(JSON.stringify({
      keyPoint: 'kp',
      score: { clarity: 120, pace: -3, structure: 66.4, [longKey]: 50, bad: 'x' },
    }))
    expect(round!.score).toEqual({
      clarity: 100,
      pace: 0,
      structure: 66,
      ['k'.repeat(20)]: 50,
    })
  })

  it('truncates long analysis/keyPoint/context to their caps', () => {
    const round = parseAnalysisRound(JSON.stringify({
      keyPoint: 'k'.repeat(300),
      analysis: 'a'.repeat(1000),
      context: 'c'.repeat(500),
      timeNote: 't'.repeat(400),
    }))
    expect(round!.keyPoint).toHaveLength(120)
    expect(round!.analysis).toHaveLength(500)
    expect(round!.context).toHaveLength(200)
    expect(round!.timeNote).toHaveLength(200)
  })

  it('keeps grammarIssues and normalizes legacy goodPhrases into goldenQuotes with their caps', () => {
    const round = parseAnalysisRound(JSON.stringify({
      keyPoint: 'kp',
      goodPhrases: ['g'.repeat(200), 42],
      grammarIssues: [
        { quote: 'q'.repeat(300), issue: 'i'.repeat(500) },
        { quote: 7 },
      ],
    }))
    // 旧字段 goodPhrases 归一化为金句 goldenQuotes（字符串条目保留，非字符串丢弃）
    expect(round!.goldenQuotes).toEqual([{ quote: 'g'.repeat(120) }])
    expect(round!.grammarIssues).toEqual([{ quote: 'q'.repeat(120), issue: 'i'.repeat(200) }])
  })

  it('passes through wotdUsed only when boolean', () => {
    expect(parseAnalysisRound(JSON.stringify({ keyPoint: 'kp', wotdUsed: true }))!.wotdUsed).toBe(true)
    expect(parseAnalysisRound(JSON.stringify({ keyPoint: 'kp', wotdUsed: 'yes' }))!.wotdUsed).toBeUndefined()
  })
})
