import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { getSceneTemplate } from '../../packages/server/src/services/meeting-asr/scene-templates'
import { parseAnalysisResponse } from '../../packages/server/src/services/meeting-asr/realtime-assist'

// S8 提示词 Skill 化：方法论细则（发言人区分/赘语宽容/金句定义/方言/肢体/3+1）
// 已迁入内置技能 meeting-speech-coach，systemPrompt 保留输出契约骨架。
const SKILL = readFileSync(
  'packages/skills/meeting-speech-coach/SKILL.md',
  'utf8',
)

describe('speech scene templates (演讲评分 AI 评价优化)', () => {
  const speech = getSceneTemplate('speech')

  it('speech scene template exists', () => {
    expect(speech).toBeDefined()
  })

  describe('实时点评 systemPrompt', () => {
    const p = speech!.systemPrompt

    it('人设是温暖的陪伴型成长教练，说人话、多鼓励', () => {
      expect(p).toContain('陪伴型成长教练')
      expect(p).toContain('说人话')
      expect(p).toContain('多鼓励')
      expect(p).toContain('先肯定再给方向')
    })

    it('方言/口音导致的问题不作语法错误报出（可过滤）', () => {
      expect(SKILL).toContain('方言')
      expect(SKILL).toContain('口音')
      expect(SKILL).toContain('当作语法问题报出')
    })

    it('赘语按发言人区分，明确赘语有哪些，且 3 分钟 10 个以下不算问题', () => {
      expect(SKILL).toContain('按发言人区分')
      expect(SKILL).toContain('呃')
      expect(SKILL).toContain('那个')
      expect(SKILL).toContain('3 分钟 10 个以下')
      expect(SKILL).toContain('宽容判定')
      expect(p).toContain('speaker')
    })

    it('金句有明确定义（有观点、有感染力、能让人记住、可单独引用）', () => {
      expect(SKILL).toContain('金句定义')
      expect(SKILL).toContain('有观点、有感染力、能让人记住、可单独引用')
      expect(p).toContain('goldenQuotes')
    })

    it('3+1 反馈：亮点最多 3 条，提升点最多 1 条且可落地', () => {
      expect(SKILL).toContain('最多 3 条')
      expect(SKILL).toContain('只给 1 条')
      expect(SKILL).toContain('可落地执行')
    })

    it('肢体语言：AI 看不到画面，不得编造观察', () => {
      expect(SKILL).toContain('看不到表情、动作、肢体语言')
      expect(SKILL).toContain('严禁编造')
    })

    it('串场计时纳入时间把控点评', () => {
      expect(p).toContain('串场')
      expect(p).toContain('timeNote')
      expect(p).toContain('timeControl')
    })

    it('设备/主持人串场词不作为演讲内容评价（不是多一个设备官）', () => {
      expect(SKILL).toContain('设备播报')
      expect(SKILL).toContain('不作为演讲内容评分')
    })

    it('保持增量评价原则（不重复输出、不硬凑）', () => {
      expect(p).toContain('hasNewPoint')
      expect(p).toContain('不要为了"有内容"而硬凑')
    })
  })

  describe('报告 reportPrompt（公众号风格，不是正式文档）', () => {
    const p = speech!.reportPrompt

    it('公众号风格，不是正式文档/工作汇报', () => {
      expect(p).toContain('公众号风格')
      expect(p).toContain('不是正式文档')
      expect(p).toContain('不是工作汇报')
    })

    it('去掉了"计时员汇报/语法官汇报"式官方栏目（只以否定形式提及）', () => {
      expect(p).toContain('不是"计时员汇报/语法官汇报"式的官方栏目堆砌')
      expect(p).not.toContain('## 计时员汇报')
      expect(p).not.toContain('## 语法官汇报')
    })

    it('按发言人区分：金句注明出处、赘语/时间按发言人说明', () => {
      expect(p).toContain('按发言人区分')
      expect(p).toContain('金句摘录')
    })

    it('只给 1 个最重要的可落地提升点', () => {
      expect(p).toContain('最重要的一个提升点')
      expect(p).toContain('只给 1 个')
    })

    it('包含肢体语言与台风、数据小卡片、结尾鼓励', () => {
      expect(p).toContain('肢体语言与台风')
      expect(p).toContain('数据小卡片')
      expect(p).toContain('结尾鼓励')
      expect(p).toContain('有温度的鼓励')
    })

    it('数据核实：缺失时标注 AI 推断，不编造次数', () => {
      expect(p).toContain('AI 推断')
      expect(p).toContain('绝不允许编造具体次数或数据')
    })
  })
})

describe('parseAnalysisResponse（演讲评分 JSON 解析）', () => {
  it('解析 goldenQuotes（含 speaker/reason）与带 speaker 的赘语/语法问题', () => {
    const round = parseAnalysisResponse(JSON.stringify({
      context: '原文',
      priority: 'normal',
      keyPoint: '开头很棒',
      analysis: '继续加油',
      hasNewPoint: true,
      highlights: ['新亮点'],
      improvements: ['最重要的一个提升点'],
      topics: ['新主题'],
      fillerWords: [{ word: '呃', count: 2, speaker: '张三' }],
      goldenQuotes: [{ quote: '行动是治愈恐惧的良药', speaker: '李四', reason: '有观点、有感染力' }],
      grammarIssues: [{ quote: '我不小心', issue: '用词问题', speaker: '王五' }],
      wotdUsed: true,
      score: { content: 85, overall: 83 },
      timeNote: '时间把控良好',
    }))

    expect(round).not.toBeNull()
    expect(round!.goldenQuotes).toEqual([
      { quote: '行动是治愈恐惧的良药', speaker: '李四', reason: '有观点、有感染力' },
    ])
    expect(round!.fillerWords).toEqual([{ word: '呃', count: 2, speaker: '张三' }])
    expect(round!.grammarIssues).toEqual([{ quote: '我不小心', issue: '用词问题', speaker: '王五' }])
    expect(round!.highlights).toEqual(['新亮点'])
    expect(round!.improvements).toEqual(['最重要的一个提升点'])
    expect(round!.wotdUsed).toBe(true)
    expect(round!.score).toEqual({ content: 85, overall: 83 })
  })

  it('兼容旧版 goodPhrases（string[]）输出，归一化为 goldenQuotes', () => {
    const round = parseAnalysisResponse(JSON.stringify({
      hasNewPoint: true,
      highlights: ['亮点'],
      goodPhrases: ['好句一', '好句二'],
    }))
    expect(round).not.toBeNull()
    expect(round!.goldenQuotes).toEqual([{ quote: '好句一' }, { quote: '好句二' }])
  })

  it('兼容旧版 goodPhrases（对象数组）输出', () => {
    const round = parseAnalysisResponse(JSON.stringify({
      hasNewPoint: true,
      highlights: ['亮点'],
      goodPhrases: [{ quote: '对象金句', speaker: '赵六' }],
    }))
    expect(round!.goldenQuotes).toEqual([{ quote: '对象金句', speaker: '赵六' }])
  })

  it('无新评价点但检测到赘语时仍保留该轮', () => {
    const round = parseAnalysisResponse(JSON.stringify({
      context: '',
      priority: 'normal',
      keyPoint: '',
      analysis: '',
      hasNewPoint: false,
      fillerWords: [{ word: '然后', count: 1, speaker: '张三' }],
    }))
    expect(round).not.toBeNull()
    expect(round!.hasNewPoint).toBe(false)
    expect(round!.fillerWords).toEqual([{ word: '然后', count: 1, speaker: '张三' }])
  })

  it('空内容返回 null', () => {
    expect(parseAnalysisResponse(JSON.stringify({ hasNewPoint: false }))).toBeNull()
    expect(parseAnalysisResponse('不是 JSON')).toBeNull()
  })

  it('容忍 markdown 代码围栏包裹的 JSON', () => {
    const round = parseAnalysisResponse('```json\n{"hasNewPoint":true,"highlights":["亮点"]}\n```')
    expect(round!.highlights).toEqual(['亮点'])
  })
})
