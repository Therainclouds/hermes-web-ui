import { describe, expect, it } from 'vitest'
import {
  buildPracticeInstructionBlock,
  buildPracticeReportMarkdown,
  composePracticeReportWithOmniAnalysis,
  encodePcm16ToWavBase64,
  formatPracticeCountdown,
  pickPracticeReportFrames,
  practiceReportFileStem,
  trimPcm16Silence,
  PRACTICE_AUDIO_SEGMENT_MAX_SECONDS,
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
    bodyLanguage: null,
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

  it('mentions the timed duration when durationMinutes is set', () => {
    const timed = buildPracticeInstructionBlock(sampleConfig({ durationMinutes: 10 }))
    expect(timed).toContain('定时 10 分钟')
    expect(timed).toContain('submit_practice_feedback')
    const untimed = buildPracticeInstructionBlock(sampleConfig({ durationMinutes: 0 }))
    expect(untimed).not.toContain('定时')
  })

  it('adds camera-driven body-language rules only when the camera is on', () => {
    const withCamera = buildPracticeInstructionBlock(sampleConfig(), { cameraOn: true })
    expect(withCamera).toContain('摄像头已开启')
    expect(withCamera).toContain('bodyLanguage')
    const withoutCamera = buildPracticeInstructionBlock(sampleConfig(), { cameraOn: false })
    expect(withoutCamera).toContain('摄像头未开启')
    expect(withoutCamera).not.toContain('摄像头已开启')
    // 默认（未传 cameraOn）等同关摄像头：不要求肢体语言维度
    const defaultBlock = buildPracticeInstructionBlock(sampleConfig())
    expect(defaultBlock).toContain('摄像头未开启')
  })

  it('enforces target-language discipline instead of mirroring the user language', () => {
    const block = buildPracticeInstructionBlock(sampleConfig())
    expect(block).toContain('语言纪律')
    expect(block).toContain('只能用英语输出')
    expect(block).toContain('请用英语再说一遍')
    expect(block).toContain('不要顺着用户的母语整段聊天')
    // 中文练习不应出现英文专用句子
    const zhBlock = buildPracticeInstructionBlock(sampleConfig({ language: 'zh' }))
    expect(zhBlock).toContain('只能用中文输出')
    expect(zhBlock).not.toContain('只能用英语输出')
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

  it('records a timed duration in the report metadata', () => {
    const md = buildPracticeReportMarkdown({
      ...baseInput,
      config: sampleConfig({ durationMinutes: 15 }),
    })
    expect(md).toContain('定时：15 分钟')
    const untimed = buildPracticeReportMarkdown({
      ...baseInput,
      config: sampleConfig({ durationMinutes: 0 }),
    })
    expect(untimed).not.toContain('定时：')
  })

  it('adds a body-language row only when a score was actually recorded', () => {
    const withBody = buildPracticeReportMarkdown({
      ...baseInput,
      feedback: [
        feedback(1, 8, { bodyLanguage: 7 }),
        feedback(2, 6),
      ],
    })
    expect(withBody).toContain('| 肢体语言 | 7/10 | 7 | 7 |')
    // 只出现在有该分数的轮次行里
    const round1 = withBody.indexOf('### 第 1 轮')
    const round2 = withBody.indexOf('### 第 2 轮')
    expect(withBody.slice(round1, round2)).toContain('肢体语言 7/10')
    expect(withBody.slice(round2)).not.toContain('肢体语言 7/10')

    const withoutBody = buildPracticeReportMarkdown({
      ...baseInput,
      feedback: [feedback(1, 8), feedback(2, 6)],
    })
    expect(withoutBody).not.toContain('肢体语言')
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

describe('formatPracticeCountdown', () => {
  it('formats minutes and seconds with zero padding', () => {
    expect(formatPracticeCountdown(10 * 60_000)).toBe('10:00')
    expect(formatPracticeCountdown(65_000)).toBe('01:05')
    expect(formatPracticeCountdown(0)).toBe('00:00')
    expect(formatPracticeCountdown(-5_000)).toBe('00:00')
  })

  it('switches to h:mm:ss beyond one hour', () => {
    expect(formatPracticeCountdown(3_661_000)).toBe('1:01:01')
    expect(formatPracticeCountdown(90 * 60_000)).toBe('1:30:00')
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

describe('encodePcm16ToWavBase64 / trimPcm16Silence', () => {
  it('encodes PCM16 into a decodable mono WAV base64', () => {
    const pcm = new Int16Array([0, 1000, -1000, 2000, 0])
    const base64 = encodePcm16ToWavBase64(pcm, 16_000)
    expect(base64.startsWith('RIFF')).toBe(false) // base64 — no plain header
    const binary = atob(base64)
    expect(binary.slice(0, 4)).toBe('RIFF')
    expect(binary.slice(8, 12)).toBe('WAVE')
    expect(binary.slice(12, 16)).toBe('fmt ')
    const view = new DataView(new Uint8Array([...binary].map(c => c.charCodeAt(0))).buffer)
    expect(view.getUint16(20, true)).toBe(1)   // PCM
    expect(view.getUint16(22, true)).toBe(1)   // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)  // bits per sample
    expect(view.getUint32(40, true)).toBe(pcm.length * 2)
    // payload bytes round-trip
    const payload = new Int16Array(view.buffer, 44, pcm.length)
    expect(Array.from(payload)).toEqual(Array.from(pcm))
  })

  it('trims leading and trailing silence but keeps a little padding', () => {
    const sampleRate = 16_000
    const silence = new Int16Array(sampleRate) // 1s of silence
    const speech = new Int16Array([...Array.from({ length: 400 }, () => 0), ...Array.from({ length: 2000 }, (_, i) => 3000 + (i % 100)), ...Array.from({ length: 400 }, () => 0)])
    const pcm = new Int16Array(silence.length + speech.length + silence.length)
    pcm.set(silence, 0)
    pcm.set(speech, silence.length)
    pcm.set(silence, silence.length + speech.length)

    const trimmed = trimPcm16Silence(pcm, { sampleRate, padMs: 100 })
    expect(trimmed.length).toBeGreaterThan(0)
    expect(trimmed.length).toBeLessThan(pcm.length)
    // padding at both ends keeps speech intact
    const abs = Array.from(trimmed, v => Math.abs(v))
    expect(abs.some(v => v >= 3000)).toBe(true)
  })

  it('returns an empty buffer for pure silence and caps at maxSeconds', () => {
    const sampleRate = 16_000
    const silent = new Int16Array(sampleRate)
    expect(trimPcm16Silence(silent, { sampleRate }).length).toBe(0)

    const long = new Int16Array(sampleRate * 10)
    long.fill(500, sampleRate, sampleRate + 100)
    const trimmed = trimPcm16Silence(long, { sampleRate, maxSeconds: 2 })
    expect(trimmed.length).toBeLessThanOrEqual(sampleRate * 2)
    expect(PRACTICE_AUDIO_SEGMENT_MAX_SECONDS).toBe(20)
  })
})

describe('pickPracticeReportFrames', () => {
  it('keeps all frames when under the cap', () => {
    const frames = ['a', 'b', 'c']
    expect(pickPracticeReportFrames(frames, 6)).toEqual(frames)
  })

  it('samples evenly and always keeps the first and last frame', () => {
    const frames = Array.from({ length: 10 }, (_, i) => `frame-${i}`)
    const picked = pickPracticeReportFrames(frames, 4)
    expect(picked).toHaveLength(4)
    expect(picked[0]).toBe('frame-0')
    expect(picked[picked.length - 1]).toBe('frame-9')
  })

  it('ignores empties and returns [] when nothing is given', () => {
    expect(pickPracticeReportFrames([])).toEqual([])
    expect(pickPracticeReportFrames(['', null as unknown as string])).toEqual([])
  })
})

describe('composePracticeReportWithOmniAnalysis', () => {
  it('appends the AI section after the base report', () => {
    const base = '# 🗣️ 口语对练分析报告\n\n正文'
    const ai = '## 四、AI 全模态深度分析（基于录音与画面的评审）\n\n语音表现…'
    const composed = composePracticeReportWithOmniAnalysis(base, ai)
    expect(composed).toBe(`${base}\n\n${ai}`)
    expect(composed.indexOf(ai)).toBeGreaterThan(composed.indexOf('正文'))
  })

  it('returns the base unchanged when the AI section is empty', () => {
    expect(composePracticeReportWithOmniAnalysis('base', '')).toBe('base')
    expect(composePracticeReportWithOmniAnalysis('base', '   \n ')).toBe('base')
  })
})
