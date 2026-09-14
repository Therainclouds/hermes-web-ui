// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMeetingTranscriptMarkdown,
  buildTranscriptFileName,
  downloadMeetingTranscriptMarkdown,
  sanitizeTranscriptFileName,
} from '@/utils/meeting-transcript-markdown'
import type { MeetingSession } from '@/stores/hermes/meeting'

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: 'm1',
    title: '季度复盘会',
    createdAt: new Date('2026-03-01T09:00:00').getTime(),
    updatedAt: new Date('2026-03-01T09:30:00').getTime(),
    useDiarize: true,
    sentences: [
      { text: '大家好，开始今天的复盘', timestamp: new Date('2026-03-01T09:00:05').getTime(), startTime: 0, endTime: 2500, speaker: '张三' },
      { text: '先看上个季度的数据', timestamp: new Date('2026-03-01T09:00:10').getTime(), startTime: 2500, endTime: 5200, speaker: '张三' },
      { text: '我补充一点风险', timestamp: new Date('2026-03-01T09:01:00').getTime(), startTime: 60000, endTime: 62000, speaker: '李四' },
    ],
    analysisResult: {
      meeting_type: '复盘',
      summary: '回顾上季度并规划下季度。',
      key_points: ['营收增长', '成本控制'],
      action_items: [{ task: '输出季度报告', assignee: '张三', deadline: '周五' }],
      decisions: ['下季度聚焦华东'],
      risks: ['供应链延迟'],
      learnings: ['提前对齐数据口径'],
      topics: ['复盘', '规划'],
      people_mentioned: ['王五'],
      feedback: { positive: ['讨论高效'], negative: ['时间略超'] },
      relationships: [{ source: '张三', target: '李四', relation: '协作' }],
    },
    htmlContent: '<html></html>',
    speakerMap: { S1: '张三' },
    speakers: [{ id: 'S1', displayName: '张三' }, { id: 'S2', displayName: '李四' }],
    status: 'completed',
    asrModel: 'paraformer-realtime-v2',
    analysisMode: 'hermes',
    hermesProfile: 'default',
    sceneTemplate: 'business',
    analysisRounds: [
      {
        id: 'r1',
        context: '营收增长',
        priority: 'attention',
        keyPoint: '关注营收结构',
        analysis: '需要拆分新老客户。',
        timestamp: new Date('2026-03-01T09:00:30').getTime(),
      },
    ],
    analysisTriggerMode: 'sentences',
    analysisIntervalSentences: 5,
    analysisIntervalSeconds: 60,
    audioDuration: 1800,
    agentMessages: [],
    agentStatus: 'idle',
    agentConfig: { agentType: 'hermes' },
    ...overrides,
  }
}

describe('buildMeetingTranscriptMarkdown', () => {
  it('includes meeting info, scene label and speakers', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession())
    expect(md).toContain('# 季度复盘会')
    expect(md).toContain('## 一、会议信息')
    expect(md).toContain('| 会议场景 | 商务谈判 |')
    expect(md).toContain('| 录音时长 | 30:00 |')
    expect(md).toContain('| ASR 模型 | paraformer-realtime-v2 |')
    expect(md).toContain('## 二、说话人')
    expect(md).toContain('张三')
    expect(md).toContain('李四')
  })

  it('renders timestamped transcript with relative range and wall clock', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession())
    expect(md).toContain('## 三、逐字稿（含时间戳）')
    expect(md).toContain('**[00:00–00:02 · 09:00:05]** **张三：** 大家好，开始今天的复盘')
    expect(md).toContain('**[01:00–01:02 · 09:01:00]** **李四：** 我补充一点风险')
  })

  it('includes the plain full-text section grouped by speaker', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession())
    expect(md).toContain('## 四、全文（无时间戳，便于复制）')
    expect(md).toContain('**张三：**')
  })

  it('includes AI analysis details', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession())
    expect(md).toContain('## 五、AI 分析结果')
    expect(md).toContain('### 摘要')
    expect(md).toContain('回顾上季度并规划下季度。')
    expect(md).toContain('### 待办事项')
    expect(md).toContain('- [ ] 输出季度报告 · 负责人：张三 · 截止：周五')
    expect(md).toContain('### 人物关系')
  })

  it('includes realtime analysis rounds', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession())
    expect(md).toContain('## 六、实时分析记录')
    expect(md).toContain('关注营收结构')
    expect(md).toContain('「营收增长」')
  })

  it('includes speech eval data when present', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession({
      sceneTemplate: 'speech',
      speechEval: {
        timerDurationSec: 300,
        yellowAtSec: 60,
        redAtSec: 30,
        timerRecords: [{ label: '开场/张三', durationSec: 120, overtimeSec: 0, timestamp: 1000 }],
        fillerWords: { 那个: 3 },
        wordOfTheDay: '复盘',
        wotdUsedCount: 2,
        goodPhrases: ['数据会说话'],
        grammarNotes: ['句子过长'],
        bodyNotes: ['眼神交流好'],
        voiceAlert: false,
      },
    }))
    expect(md).toContain('## 七、演讲评分数据')
    expect(md).toContain('### 计时记录')
    expect(md).toContain('### 赘语统计')
    expect(md).toContain('### 每日一词')
    expect(md).toContain('数据会说话')
  })

  it('falls back to a placeholder when there is no transcript', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession({ sentences: [], analysisResult: null, analysisRounds: [] }))
    expect(md).toContain('（无转写内容）')
    expect(md).not.toContain('## 五、AI 分析结果')
    expect(md).not.toContain('## 七、演讲评分数据')
  })

  it('accepts a scene label override', () => {
    const md = buildMeetingTranscriptMarkdown(makeSession({ sceneTemplate: 'custom-plugin' }), { sceneLabel: '跑团' })
    expect(md).toContain('| 会议场景 | 跑团 |')
  })
})

describe('transcript file name', () => {
  it('sanitizes illegal characters', () => {
    expect(sanitizeTranscriptFileName('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi')
    expect(sanitizeTranscriptFileName('')).toBe('会议文字')
  })

  it('builds a .md file name with date stamp', () => {
    const name = buildTranscriptFileName(makeSession(), new Date('2026-03-01T09:30:05'))
    expect(name).toBe('季度复盘会_会议文字_20260301-0930.md')
  })
})

describe('downloadMeetingTranscriptMarkdown', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('triggers a .md blob download named after the meeting', () => {
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL

    const anchors: HTMLAnchorElement[] = []
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const el = originalCreateElement(tagName)
      if (tagName === 'a') anchors.push(el as HTMLAnchorElement)
      return el
    }) as typeof document.createElement)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadMeetingTranscriptMarkdown(makeSession())

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
    expect(anchors).toHaveLength(1)
    expect(anchors[0].download).toMatch(/_会议文字_\d{8}-\d{4}\.md$/)
  })
})
