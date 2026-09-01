// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildAllSpeakersFeedbackMarkdown,
  buildSpeakerFeedbackMarkdown,
  groupSentencesBySpeaker,
} from '@/utils/speech-export'
import type { AnalysisRound } from '@/composables/useMeetingAssist'
import type { TranscriptSentence } from '@/stores/hermes/meeting'

describe('buildSpeakerFeedbackMarkdown（单演讲者点评打包）', () => {
  it('包含评分表/亮点/提升点/主题/轮次', () => {
    const rounds: AnalysisRound[] = [
      {
        id: 'r1', context: '原文关键句', priority: 'attention', keyPoint: '节奏稳',
        analysis: '补充说明', timestamp: 1_700_000_000_000,
        fillerWords: [{ word: '呃', count: 2, speaker: '张三' }],
        goldenQuotes: [{ quote: '金句原文', speaker: '张三', reason: '有力' }],
        grammarIssues: [{ quote: '病句', issue: '语序', speaker: '张三' }],
        wotdUsed: true, timeNote: '时间把控良好',
      },
    ]
    const md = buildSpeakerFeedbackMarkdown({
      speaker: '张三',
      score: { content: 78, structure: 68, language: 80, timeControl: 85, overall: 77 },
      scoreUpdatedAt: 1_700_000_000_000,
      highlights: ['节奏好'],
      improvements: ['少用呃'],
      topics: ['曲艺'],
      rounds,
    })

    expect(md).toContain('# 🎤 张三 · 演讲点评')
    expect(md).toContain('| 内容 | 结构 | 语言表达 | 时间把控 | 总分 |')
    expect(md).toContain('| 78 | 68 | 80 | 85 | 77 |')
    expect(md).toContain('## ✨ 亮点')
    expect(md).toContain('- 节奏好')
    expect(md).toContain('## 💡 可提升的点')
    expect(md).toContain('- 少用呃')
    expect(md).toContain('## 🏷️ 主题')
    expect(md).toContain('## 🆕 点评轮次')
    expect(md).toContain('**节奏稳**')
    expect(md).toContain('> 「原文关键句」')
    expect(md).toContain('- 赘语：呃 ×2（张三）')
    expect(md).toContain('- 金句：「金句原文」—— 张三：有力')
    expect(md).toContain('- 语法：「病句」— 语序（张三）')
    expect(md).toContain('⏱️ 时间把控良好')
    expect(md).toContain('- 📖 使用了每日一词')
  })

  it('空内容输出（无）占位，不输出空 section 列表', () => {
    const md = buildSpeakerFeedbackMarkdown({
      speaker: '李四', highlights: [], improvements: [], topics: [], rounds: [],
    })
    expect(md).toContain('# 🎤 李四 · 演讲点评')
    expect(md).toContain('-（无）')
    expect(md).not.toContain('## 🆕 点评轮次')
  })
})

describe('buildAllSpeakersFeedbackMarkdown（整体导出）', () => {
  it('按演讲者分段并以分隔线连接，含汇总标题', () => {
    const md = buildAllSpeakersFeedbackMarkdown([
      { speaker: '张三', highlights: ['a'], improvements: [], topics: [], rounds: [] },
      { speaker: '李四', highlights: ['b'], improvements: [], topics: [], rounds: [] },
    ])
    expect(md).toContain('# 演讲点评汇总')
    expect(md).toContain('# 🎤 张三 · 演讲点评')
    expect(md).toContain('# 🎤 李四 · 演讲点评')
    expect(md.match(/\n---\n/g)?.length ?? md.match(/^---$/gm)?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('groupSentencesBySpeaker（逐字稿按人分组）', () => {
  const base: Omit<TranscriptSentence, 'text' | 'timestamp'> = {}

  it('按句子自带 speaker 分组并保持首次出现顺序', () => {
    const sentences: TranscriptSentence[] = [
      { ...base, text: '你好', timestamp: 1000, speaker: '张三' },
      { ...base, text: 'hello', timestamp: 2000, speaker: '李四' },
      { ...base, text: '继续', timestamp: 3000, speaker: '张三' },
    ]
    const groups = groupSentencesBySpeaker(sentences)
    expect(groups.map(g => g.speaker)).toEqual(['张三', '李四'])
    expect(groups[0].sentences.map(s => s.text)).toEqual(['你好', '继续'])
    expect(groups[1].sentences.map(s => s.text)).toEqual(['hello'])
  })

  it('无 speaker 的句子经时间线兜底归属', () => {
    const sentences: TranscriptSentence[] = [
      { ...base, text: '无标注句', timestamp: 150_000 },
    ]
    const ranges = [
      { label: '环节 1/张三', segment: '环节 1', speaker: '张三', kind: 'segment' as const, startMs: 100_000, endMs: 200_000 },
    ]
    const groups = groupSentencesBySpeaker(sentences, ranges)
    expect(groups).toHaveLength(1)
    expect(groups[0].speaker).toBe('张三')
  })

  it('完全无归属时进入未标注桶（空串）', () => {
    const sentences: TranscriptSentence[] = [
      { ...base, text: '谁说的？', timestamp: 999_999 },
    ]
    const groups = groupSentencesBySpeaker(sentences)
    expect(groups).toHaveLength(1)
    expect(groups[0].speaker).toBe('')
  })
})
