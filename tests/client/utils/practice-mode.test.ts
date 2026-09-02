import { describe, expect, it } from 'vitest'
import {
  buildPracticeInstructionBlock,
  buildPracticeReportMarkdown,
  practiceReportFileStem,
  PRACTICE_DIFFICULTY_LABELS,
  PRACTICE_LANGUAGE_LABELS,
  type PracticeFeedbackRecord,
  type PracticeSessionConfig,
  type PracticeTurnRecord,
} from '@/utils/practice-mode'

function sampleConfig(overrides: Partial<PracticeSessionConfig> = {}): PracticeSessionConfig {
  return {
    language: 'en',
    direction: '求职面试自我介绍',
    difficulty: 'intermediate',
    ...overrides,
  }
}

function userTurn(text: string, timestamp: number): PracticeTurnRecord {
  return { role: 'user', text, timestamp }
}

function assistantTurn(text: string, timestamp: number): PracticeTurnRecord {
  return { role: 'assistant', text, timestamp }
}

function feedback(round: number, overall: number, extra: Partial<PracticeFeedbackRecord> = {}): PracticeFeedbackRecord {
  return {
    round,
    overall,
    fluency: overall,
    pronunciation: overall,
    grammar: overall,
    vocabulary: overall,
    content: overall,
    comment: `comment-${round}`,
    strengths: `strength-${round}`,
    improvements: `improve-${round}`,
    example: `example-${round}`,
    at: 2000 + round,
    ...extra,
  }
}

describe('buildPracticeInstructionBlock', () => {
  it('mentions the target language, direction and difficulty', () => {
    const block = buildPracticeInstructionBlock(sampleConfig())
    expect(block).toContain('英语口语陪练教练')
    expect(block).toContain('求职面试自我介绍')
    expect(block).toContain('进阶')
    expect(block).toContain('submit_practice_feedback')
  })

  it('handles an empty direction as free conversation', () => {
    const block = buildPracticeInstructionBlock(sampleConfig({ direction: '   ' }))
    expect(block).toContain('自由对话')
    expect(block).not.toContain('求职面试自我介绍')
  })

  it('keeps the agent tools available (query_hermes_agent mention)', () => {
    const block = buildPracticeInstructionBlock(sampleConfig())
    expect(block).toContain('query_hermes_agent')
  })

  it('reflects difficulty level guidance', () => {
    const beginner = buildPracticeInstructionBlock(sampleConfig({ difficulty: 'beginner' }))
    expect(beginner).toContain('入门')
    const advanced = buildPracticeInstructionBlock(sampleConfig({ difficulty: 'advanced' }))
    expect(advanced).toContain('高级')
  })
})

describe('buildPracticeReportMarkdown', () => {
  const baseInput = {
    config: sampleConfig(),
    startedAt: 1000,
    endedAt: 9000,
    turns: [
      userTurn('Hello, my name is Tom.', 2000),
      assistantTurn('Nice to meet you, Tom! Tell me about your job.', 3000),
      userTurn('I work as an engineer.', 4000),
      assistantTurn('Great! What do you like about it?', 5000),
    ],
    feedback: [
      feedback(1, 8, { fluency: 7, comment: 'Good start', at: 3500 }),
      feedback(2, 6, { pronunciation: 5, comment: 'Work on pronunciation', at: 5500 }),
    ],
  }

  it('emits the expected section headers', () => {
    const md = buildPracticeReportMarkdown(baseInput)
    expect(md).toContain('# 🗣️ 口语对练分析报告')
    expect(md).toContain('## 一、综合评分')
    expect(md).toContain('## 二、逐轮点评')
    expect(md).toContain('## 三、对话记录')
  })

  it('puts the config in the header blockquote', () => {
    const md = buildPracticeReportMarkdown(baseInput)
    expect(md).toContain('练习语言：英语')
    expect(md).toContain('练习方向：求职面试自我介绍')
    expect(md).toContain('难度：进阶')
  })

  it('builds a score table with averages', () => {
    const md = buildPracticeReportMarkdown(baseInput)
    // overall 8 & 6 → avg 7
    expect(md).toContain('| 总分 | 7/10 | 8 | 6 |')
    // fluency has samples [7, 6] → 6.5
    expect(md).toContain('| 流利度 | 6.5/10 | 7 | 6 |')
    // pronunciation samples [8, 5] → 6.5
    expect(md).toContain('| 发音语调 | 6.5/10 | 8 | 5 |')
  })

  it('attributes each feedback to its own round with user text', () => {
    const md = buildPracticeReportMarkdown(baseInput)
    const round1 = md.indexOf('### 第 1 轮')
    const round2 = md.indexOf('### 第 2 轮')
    expect(round1).toBeGreaterThan(-1)
    expect(round2).toBeGreaterThan(round1)
    expect(md.slice(round1, round2)).toContain('总分 8/10')
    expect(md.slice(round1, round2)).toContain('Good start')
    expect(md.slice(round1, round2)).toContain('Hello, my name is Tom.')
    expect(md.slice(round2)).toContain('总分 6/10')
    expect(md.slice(round2)).toContain('I work as an engineer.')
    // assistant replies follow their user turns in the per-round section
    expect(md.slice(round1, round2)).toContain('Nice to meet you, Tom!')
  })

  it('reports a session without feedback gracefully', () => {
    const md = buildPracticeReportMarkdown({
      ...baseInput,
      feedback: [],
      turns: [userTurn('Just a test.', 2000)],
    })
    expect(md).toContain('## 备注')
    expect(md).toContain('没有产生评分')
    // no per-round score table
    expect(md).not.toContain('| 总分 |')
  })

  it('keeps unattached (round 0) feedback in a dedicated section', () => {
    const md = buildPracticeReportMarkdown({
      ...baseInput,
      feedback: [feedback(0, 9, { comment: 'overall impression' })],
    })
    expect(md).toContain('补充点评（未归属轮次）')
    expect(md).toContain('overall impression')
  })

  it('includes the full transcript in section three', () => {
    const md = buildPracticeReportMarkdown(baseInput)
    const sectionThree = md.indexOf('## 三、对话记录')
    expect(sectionThree).toBeGreaterThan(-1)
    // each utterance also appears in section two (per-round), so look at the
    // LAST occurrence to assert the transcript section carries it again
    expect(md.lastIndexOf('I work as an engineer.')).toBeGreaterThan(sectionThree)
    expect(md.lastIndexOf('What do you like about it?')).toBeGreaterThan(sectionThree)
  })

  it('falls back language / difficulty labels when the config uses unknown values (runtime safety)', () => {
    const md = buildPracticeReportMarkdown({
      ...baseInput,
      config: { language: 'xx' as PracticeSessionConfig['language'], direction: '', difficulty: 'xx' as PracticeSessionConfig['difficulty'] },
    })
    expect(md).toContain('练习语言：xx')
    expect(md).toContain('难度：xx')
    expect(md).toContain('自由对话')
  })
})

describe('practiceReportFileStem', () => {
  it('builds a timestamped, separator-free stem', () => {
    const stem = practiceReportFileStem(sampleConfig(), new Date(2024, 7, 25, 9, 30).getTime())
    expect(stem).toBe('口语对练-英语-求职面试自我介绍-20240825-0930')
    expect(stem).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('collapses path separators from the direction into dashes', () => {
    const stem = practiceReportFileStem(sampleConfig({ direction: 'a/b\\c' }), new Date(2024, 0, 1).getTime())
    expect(stem).not.toContain('/')
    expect(stem).not.toContain('\\')
    expect(stem).toContain('-a-b-c-')
  })
})

describe('label maps', () => {
  it('covers every supported language & difficulty', () => {
    expect(PRACTICE_LANGUAGE_LABELS).toEqual({
      zh: '中文', en: '英语', ja: '日语', ko: '韩语',
    })
    expect(PRACTICE_DIFFICULTY_LABELS).toEqual({
      beginner: '入门', intermediate: '进阶', advanced: '高级',
    })
  })
})
