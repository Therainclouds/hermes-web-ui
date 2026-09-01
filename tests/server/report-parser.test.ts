import { describe, expect, it } from 'vitest'
import {
  annotateTranscriptSpeakers,
  applyLegalGuards,
  applySpeechGuards,
  parseAnalysisRound,
  resolveDominantSpeaker,
  resolveTimelineSpeaker,
  TIMELINE_MATCH_LATENCY_MS,
  type AnalysisRound,
  type SpeakerTimelineEntry,
} from '../../packages/server/src/services/meeting-asr/report-parser'

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

describe('applySpeechGuards（Hook 层：确定性护栏）', () => {
  const base: AnalysisRound = {
    id: 'r1',
    context: '',
    priority: 'normal',
    keyPoint: 'kp',
    analysis: 'an',
    timestamp: 1,
  }

  it('H3 设备官过滤：剔除 speaker 为设备/系统/播报的条目', () => {
    const round: AnalysisRound = {
      ...base,
      fillerWords: [
        { word: '呃', count: 2 },
        { word: '那个', count: 1, speaker: '设备播报' },
        { word: '嗯', count: 3, speaker: '张三' },
      ],
      goldenQuotes: [
        { quote: '好句', speaker: '张三' },
        { quote: '系统提示', speaker: '系统' },
      ],
      grammarIssues: [
        { quote: '真实问题', issue: 'x', speaker: '李四' },
        { quote: '播报词', issue: 'y', speaker: 'device' },
      ],
    }
    const out = applySpeechGuards(round)
    expect(out.fillerWords).toHaveLength(2)
    expect(out.goldenQuotes).toHaveLength(1)
    expect(out.grammarIssues).toHaveLength(1)
  })

  it('H1 阈值：实际发言 3 分钟内 10 个以下赘语 → 清空且不标 attention', () => {
    const round: AnalysisRound = {
      ...base,
      priority: 'attention',
      fillerWords: [
        { word: '呃', count: 4 },
        { word: '那个', count: 3 },
        { word: '然后', count: 3 },
      ], // 共 10 个 / 180s = 恰好达标（≤10）
    }
    const out = applySpeechGuards(round, 180)
    expect(out.fillerWords).toBeUndefined()
    expect(out.priority).toBe('normal')
  })

  it('H1 阈值：明显高频（超 10 个/3min）保留赘语与 attention', () => {
    const round: AnalysisRound = {
      ...base,
      priority: 'attention',
      fillerWords: [{ word: '呃', count: 25 }],
    }
    const out = applySpeechGuards(round, 180)
    expect(out.fillerWords).toHaveLength(1)
    expect(out.priority).toBe('attention')
  })

  it('H1 阈值：按时长折算（90 秒允许 5 个）', () => {
    const atLimit: AnalysisRound = { ...base, fillerWords: [{ word: '呃', count: 5 }] }
    expect(applySpeechGuards(atLimit, 90).fillerWords).toBeUndefined()

    const over: AnalysisRound = { ...base, fillerWords: [{ word: '呃', count: 6 }] }
    expect(applySpeechGuards(over, 90).fillerWords).toHaveLength(1)
  })

  it('H1 阈值：未提供时长或缺时长样本（<60s）不启用', () => {
    const round: AnalysisRound = { ...base, fillerWords: [{ word: '呃', count: 8 }] }
    expect(applySpeechGuards(round).fillerWords).toHaveLength(1)
    expect(applySpeechGuards(round, 30).fillerWords).toHaveLength(1)
  })

  it('H2 3+1 强制：highlights 截 3、improvements 截 1', () => {
    const round: AnalysisRound = {
      ...base,
      highlights: ['a', 'b', 'c', 'd', 'e'],
      improvements: ['最重要', '次重要'],
    }
    const out = applySpeechGuards(round)
    expect(out.highlights).toEqual(['a', 'b', 'c'])
    expect(out.improvements).toEqual(['最重要'])
  })

  it('parseAnalysisRound 出口执行护栏（经 options 传时长）', () => {
    const raw = JSON.stringify({
      keyPoint: 'kp',
      fillerWords: [
        { word: '呃', count: 2, speaker: '设备播报' },
        { word: '那个', count: 3 },
      ],
    })
    // 180s 内共 5 个（设备播报的 2 个先被 H3 剔除后仅 3 个）→ H1 清空
    const round = parseAnalysisRound(raw, { speechDurationSec: 180 })
    expect(round!.fillerWords).toBeUndefined()
  })
})

describe('applyLegalGuards（Hook 层：法律场景确定性护栏）', () => {
  const base: AnalysisRound = {
    id: 'l1',
    context: '对方要求签约后七日内付全款',
    priority: 'normal',
    keyPoint: '付款节奏风险',
    analysis: '全款要求偏离行业惯例',
    timestamp: 1,
  }

  it('H-L1 urgent 白名单：时效届满语义允许 urgent', () => {
    const round: AnalysisRound = { ...base, priority: 'urgent', keyPoint: '诉讼时效即将届满' }
    expect(applyLegalGuards(round).priority).toBe('urgent')
  })

  it('H-L1 urgent 白名单：普通争议 urgent 降级 attention', () => {
    const round: AnalysisRound = { ...base, priority: 'urgent', keyPoint: '对方情绪激动争执激烈' }
    expect(applyLegalGuards(round).priority).toBe('attention')
  })

  it('H-L2 法条纪律：LLM 引用一律标注需人工核实', () => {
    const round: AnalysisRound = {
      ...base,
      lawRefs: [
        { name: '民法典', article: '第585条', note: '违约金调整' },
        { name: '劳动法' },
      ],
    }
    const out = applyLegalGuards(round)
    expect(out.lawRefs!.every(l => l.verified === false)).toBe(true)
    expect(out.lawRefs![0].note).toContain('需人工核实')
    expect(out.lawRefs![1].note).toContain('需人工核实')
  })

  it('H-L3 去重：riskItems 按 text、positions 按 party+stance、lawRefs 按 name+article', () => {
    const round: AnalysisRound = {
      ...base,
      riskItems: [
        { level: 'high', text: '违约金过高' },
        { level: 'low', text: '违约金过高' },
      ],
      positions: [
        { party: '对方', stance: '要求全款' },
        { party: '对方', stance: '要求全款' },
        { party: '对方', stance: '要求分期' },
      ],
      lawRefs: [
        { name: '民法典', article: '第585条' },
        { name: '民法典', article: '第585条' },
      ],
    }
    const out = applyLegalGuards(round)
    expect(out.riskItems).toHaveLength(1)
    expect(out.positions).toHaveLength(2)
    expect(out.lawRefs).toHaveLength(1)
  })

  it('parseAnalysisRound 出口执行法律护栏', () => {
    const raw = JSON.stringify({
      keyPoint: '付款节奏风险',
      riskItems: [
        { level: 'high', text: '违约金过高' },
        { level: 'invalid', text: '应被过滤' },
        { level: 'medium', text: '违约金过高' },
      ],
      lawRefs: [{ name: '民法典', article: '第585条' }],
    })
    const round = parseAnalysisRound(raw)
    expect(round!.riskItems).toHaveLength(1)
    expect(round!.riskItems![0].level).toBe('high')
    expect(round!.lawRefs![0].note).toContain('需人工核实')
  })
})

describe('resolveTimelineSpeaker（按墙钟归属环节演讲者）', () => {
  const timeline: SpeakerTimelineEntry[] = [
    { speaker: '燕灵', segment: '开场介绍', startMs: 1000, endMs: 5000 },
    { speaker: 'UU', segment: '小组共创', startMs: 6000, endMs: 12000 },
  ]

  it('空 timeline / 空 ts 返回空串', () => {
    expect(resolveTimelineSpeaker(undefined, 2000)).toBe('')
    expect(resolveTimelineSpeaker([], 2000)).toBe('')
    expect(resolveTimelineSpeaker(timeline, undefined)).toBe('')
    expect(resolveTimelineSpeaker(timeline, NaN)).toBe('')
  })

  it('精确命中区间返回对应 speaker', () => {
    expect(resolveTimelineSpeaker(timeline, 2000)).toBe('燕灵')
    expect(resolveTimelineSpeaker(timeline, 6000)).toBe('UU') // 边界 = 起点
    expect(resolveTimelineSpeaker(timeline, 12000)).toBe('UU') // 边界 = 终点
  })

  it('超出区间但在 60s 延迟窗内，归到最近一段（吸收 AI 轮次出结果延迟）', () => {
    expect(resolveTimelineSpeaker(timeline, 12000 + 1_000)).toBe('UU') // 刚出区间 1s
    expect(resolveTimelineSpeaker(timeline, 12000 + TIMELINE_MATCH_LATENCY_MS)).toBe('UU') // 边界 = 60s 仍归到 UU
    expect(resolveTimelineSpeaker(timeline, 12000 + TIMELINE_MATCH_LATENCY_MS + 1)).toBe('') // 超过 60s 不归
  })

  it('多个区间取最后一个（按顺序遍历，reverse 命中最近段）', () => {
    const overlapping: SpeakerTimelineEntry[] = [
      { speaker: 'A', startMs: 1000, endMs: 5000 },
      { speaker: 'B', startMs: 3000, endMs: 7000 },
    ]
    // 5000 在 A 区间内、也在 B 区间 [3000,7000] 内，按 reverse 应取 B
    expect(resolveTimelineSpeaker(overlapping, 5000)).toBe('B')
  })

  it('区间起点前的 ts 不算命中（精确命中区间闭区间但起点前不计）', () => {
    expect(resolveTimelineSpeaker(timeline, 500)).toBe('') // 在第一段前
  })
})

describe('annotateTranscriptSpeakers（用时间线标注转写）', () => {
  const timeline: SpeakerTimelineEntry[] = [
    { speaker: '燕灵', segment: '开场介绍', startMs: 1000, endMs: 5000 },
    { speaker: 'UU', segment: '小组共创', startMs: 6000, endMs: 12000 },
  ]

  it('时间线命中时用 timeline 名覆盖原 speaker', () => {
    const annotated = annotateTranscriptSpeakers(
      [{ speaker: '说话人1', text: '大家好', timestamp: 2000 }],
      timeline,
    )
    expect(annotated).toEqual([{ speaker: '燕灵', text: '大家好' }])
  })

  it('时间线未命中时保留原 speaker', () => {
    const annotated = annotateTranscriptSpeakers(
      [{ speaker: '说话人1', text: '未来时', timestamp: 999_999 }],
      timeline,
    )
    expect(annotated).toEqual([{ speaker: '说话人1', text: '未来时' }])
  })

  it('时间线为空时保留原 speaker（不丢字段）', () => {
    const annotated = annotateTranscriptSpeakers(
      [{ speaker: '说话人1', text: 'hi', timestamp: 2000 }],
      undefined,
    )
    expect(annotated).toEqual([{ speaker: '说话人1', text: 'hi' }])
  })

  it('原 speaker 缺省时，时间线命中会补上 speaker 字段', () => {
    const annotated = annotateTranscriptSpeakers(
      [{ text: 'hi', timestamp: 2000 }],
      timeline,
    )
    expect(annotated).toEqual([{ speaker: '燕灵', text: 'hi' }])
  })

  it('60s 延迟窗内的句子仍归属到刚结束的段（吸收 AI 延迟）', () => {
    const annotated = annotateTranscriptSpeakers(
      [{ text: '...', timestamp: 12000 + 30_000 }], // 距最后一段 30s
      timeline,
    )
    expect(annotated).toEqual([{ speaker: 'UU', text: '...' }])
  })
})

describe('resolveDominantSpeaker（批次主导演讲者推导）', () => {
  it('按句子计数取最多者', () => {
    const annotated = [
      { speaker: '张三' }, { speaker: '张三' }, { speaker: '李四' },
    ]
    expect(resolveDominantSpeaker(annotated)).toBe('张三')
  })

  it('并列时取先出现者', () => {
    const annotated = [
      { speaker: '李四' }, { speaker: '张三' }, { speaker: '李四' }, { speaker: '张三' },
    ]
    expect(resolveDominantSpeaker(annotated)).toBe('李四')
  })

  it('空名与设备播报不计入', () => {
    const annotated = [
      { speaker: '' }, { speaker: '系统播报' }, { speaker: 'device' },
      { speaker: '张三' }, { speaker: undefined },
    ]
    expect(resolveDominantSpeaker(annotated)).toBe('张三')
  })

  it('全部无有效姓名时返回空串', () => {
    expect(resolveDominantSpeaker([{ speaker: '' }, {}])).toBe('')
    expect(resolveDominantSpeaker([])).toBe('')
  })

  it('名字首尾空白被 trim', () => {
    expect(resolveDominantSpeaker([{ speaker: '  张三  ' }])).toBe('张三')
  })
})
