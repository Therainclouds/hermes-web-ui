// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ref, type Ref } from 'vue'
import { useSpeechAiAggregation, type SpeechAiAggregationDeps } from '@/composables/useSpeechAiAggregation'
import type { AnalysisRound } from '@/composables/useMeetingAssist'
import type { MeetingSession } from '@/stores/hermes/meeting'

function makeRounds(rounds: AnalysisRound[]): Ref<AnalysisRound[]> {
  return ref(rounds)
}

function makeSession(session?: Partial<MeetingSession>): Ref<MeetingSession | undefined> {
  return ref(session ? ({ sentences: [], ...session } as MeetingSession) : undefined)
}

function useAggregation(rounds: AnalysisRound[], session?: Partial<MeetingSession>) {
  const deps: SpeechAiAggregationDeps = {
    rounds: makeRounds(rounds),
    session: makeSession(session),
  }
  return useSpeechAiAggregation(deps)
}

describe('useSpeechAiAggregation · speakerScores（按演讲者的最新评分）', () => {
  it('每位演讲者取其最新一轮评分，按时间升序', () => {
    const { speakerScores } = useAggregation([
      { id: 'r1', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 1000, speaker: '张三', score: { overall: 70 } },
      { id: 'r2', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 2000, speaker: '李四', score: { overall: 80 } },
      { id: 'r3', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 3000, speaker: '张三', score: { overall: 75 } },
    ])
    expect(speakerScores.value).toEqual([
      { speaker: '李四', score: { overall: 80 }, updatedAt: 2000 },
      { speaker: '张三', score: { overall: 75 }, updatedAt: 3000 },
    ])
  })

  it('无 speaker 或无 score 的轮次不产生记分牌', () => {
    const { speakerScores } = useAggregation([
      { id: 'r1', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 1000, score: { overall: 70 } },
      { id: 'r2', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 2000, speaker: '张三' },
    ])
    expect(speakerScores.value).toEqual([])
  })
})

describe('useSpeechAiAggregation · speakerSections（按演讲者分组评价）', () => {
  it('亮点/提升点/主题按 speaker 分桶累积去重', () => {
    const { speakerSections } = useAggregation([
      {
        id: 'r1', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 1000, speaker: '张三',
        highlights: ['节奏好', '意象新'], improvements: ['少用呃'], topics: ['曲艺'],
      },
      {
        id: 'r2', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 2000, speaker: '李四',
        highlights: ['钩子强'], topics: ['社会学'],
      },
      {
        id: 'r3', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 3000, speaker: '张三',
        highlights: ['节奏好'], // 重复项不重复累积
        improvements: ['停顿更稳'],
      },
    ])
    expect(speakerSections.value).toEqual([
      { speaker: '张三', highlights: ['节奏好', '意象新'], improvements: ['少用呃', '停顿更稳'], topics: ['曲艺'] },
      { speaker: '李四', highlights: ['钩子强'], improvements: [], topics: ['社会学'] },
    ])
  })

  it('无 speaker 的轮次归入未标注桶（空串）', () => {
    const { speakerSections } = useAggregation([
      { id: 'r1', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 1000, highlights: ['节奏好'] },
    ])
    expect(speakerSections.value).toEqual([
      { speaker: '', highlights: ['节奏好'], improvements: [], topics: [] },
    ])
  })

  it('平铺聚合（highlights）不受分组影响，仍跨轮去重', () => {
    const { highlights } = useAggregation([
      { id: 'r1', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 1000, speaker: '张三', highlights: ['a'] },
      { id: 'r2', context: '', priority: 'normal', keyPoint: '', analysis: '', timestamp: 2000, speaker: '李四', highlights: ['a', 'b'] },
    ])
    expect(highlights.value).toEqual(['a', 'b'])
  })
})
