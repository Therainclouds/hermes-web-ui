import { describe, expect, it } from 'vitest'
import {
  PRACTICE_DEFAULT_COACH_SOUL,
  PRACTICE_DEFAULT_SKILL_KEY,
  PRACTICE_SKILL_DIM_LABELS,
  aggregateOverallScore,
  buildPracticeClosingReviewPrompt,
  buildPracticeFeedbackToolFor,
  buildSkillCriteriaMarkdown,
  defaultPracticeSkill,
  findPracticeSkillEntry,
  isClosingUtteranceLike,
  isDefaultSkillRef,
  normalizePracticeSkill,
  overallModeLabel,
  resolveSkillLanguage,
  resultBandOf,
  skillDimLabel,
  skillSupportsLanguage,
  toPracticeSkillOptions,
  type PracticeSkillEntry,
  type PracticeSkillManifest,
} from '@/utils/practice-skill'

const entry = (name: string, description = '', category = 'practice') => ({
  kind: 'skill' as const,
  category,
  name,
  description,
  enabled: true,
  source: 'local',
})

describe('practice-skill 运行时', () => {
  it('默认技能 = 通用口语教练（六维兼容、1-10 平均）', () => {
    const skill = defaultPracticeSkill()
    expect(skill.kind).toBe('default')
    expect(skill.name).toBe(PRACTICE_DEFAULT_SKILL_KEY)
    expect(skill.coachSoul).toBe(PRACTICE_DEFAULT_COACH_SOUL)
    expect(skill.evaluation.scale).toEqual({ min: 1, max: 10, step: 1 })
    expect(skill.evaluation.overallMode).toBe('average')
    expect(skill.evaluation.dims.map(dim => dim.id)).toEqual(['fluency', 'pronunciation', 'grammar', 'vocabulary', 'content'])
    expect(skill.evaluation.dims[0]?.label).toBe(PRACTICE_SKILL_DIM_LABELS.fluency)
    expect(skill.targetLanguages).toEqual([])
    expect(skill.workspaceTools).toBeNull()
    expect(skill.reviewOnEnd).toBe(true)
    expect(skill.omniEnabled).toBe(true)
  })

  it('归一化自定义技能：维度/量表/权重/档位/音色/语言/工具子集', () => {
    const manifest: PracticeSkillManifest = {
      schema: 1,
      scene: 'knowledge',
      targetLanguages: ['zh'],
      directions: ['二元一次方程组'],
      entry: { label: '知识点测评教练', hint: '苏格拉底追问', voice: 'Ethan' },
      coach: {
        role: '老师',
        userRole: '学生',
        soul: '你是苏格拉底式教学教练。',
        extraRules: ['- 不直接给答案，先引导。'],
        tools: ['query_agent_memory', 'not_a_real_tool'],
      },
      evaluation: {
        scale: { min: 1, max: 5, step: 1 },
        dimensions: [
          { id: 'accuracy', label: '概念准确', rubric: '1-2 混淆；3-4 基本准确；5 严谨', weight: 0.6 },
          { id: 'reasoning', label: '推理过程', weight: 0.4 },
        ],
        overallMode: 'weighted',
        resultBands: [
          { min: 4, label: '已掌握' },
          { min: 2, label: '部分掌握', description: '需复习' },
          { min: 1, label: '未掌握' },
        ],
      },
    }
    const skill = normalizePracticeSkill(entry('knowledge-math'), manifest, '## 技能背景\n用于测评')
    expect(skill.kind).toBe('skill')
    expect(skill.scene).toBe('knowledge')
    expect(skill.voice).toBe('Ethan')
    expect(skill.role).toBe('老师')
    expect(skill.userRole).toBe('学生')
    expect(skill.extraRules).toEqual(['- 不直接给答案，先引导。'])
    expect(skill.workspaceTools).toEqual(['query_agent_memory'])
    expect(skill.targetLanguages).toEqual(['zh'])
    expect(skill.directions).toEqual(['二元一次方程组'])
    expect(skill.background).toContain('用于测评')
    expect(skill.evaluation.scale).toEqual({ min: 1, max: 5, step: 1 })
    expect(skill.evaluation.dims.map(dim => dim.id)).toEqual(['accuracy', 'reasoning'])
    expect(skill.evaluation.overallMode).toBe('weighted')
    // 权重归一化到总和 1
    expect(skill.weights.accuracy).toBeCloseTo(0.6, 5)
    expect(skill.weights.reasoning).toBeCloseTo(0.4, 5)
    // 档位按 min 降序
    expect(skill.evaluation.resultBands.map(band => band.min)).toEqual([4, 2, 1])
    expect(skill.displayName).toBe('知识点测评教练')
    expect(skill.reportConclusion).toBe(true)
  })

  it('归一化非法维度 id / 非法工具 id 被丢弃', () => {
    const manifest: PracticeSkillManifest = {
      schema: 1,
      coach: { tools: ['query_hermes_agent', '', 'overall', 'x y'] },
      evaluation: {
        dimensions: [
          { id: 'ok_dim', label: '合法维度' },
          { id: 'overall', label: '保留字段不可覆盖' },
          { id: 'bodyLanguage', label: '保留字段不可覆盖' },
          { id: 'BAD ID!', label: '非法字符' },
        ],
      },
    }
    const skill = normalizePracticeSkill(entry('weird'), manifest)
    expect(skill.evaluation.dims.map(dim => dim.id)).toEqual(['ok_dim'])
    expect(skill.workspaceTools).toEqual(['query_hermes_agent'])
  })

  it('旧式 scoring 兼容：语言类技能标签/权重进入 evaluation', () => {
    const manifest: PracticeSkillManifest = {
      schema: 1,
      targetLanguages: ['en'],
      scoring: {
        rubrics: { fluency: '1-3 停顿多；4-6 偶卡；7-10 流畅' },
        labels: { fluency: '流利' },
        weights: { fluency: 0.3, content: 0.2, grammar: 0.2, pronunciation: 0.15, vocabulary: 0.15 },
        overallMode: 'weighted',
      },
    }
    const skill = normalizePracticeSkill(entry('ielts'), manifest)
    expect(skill.evaluation.overallMode).toBe('weighted')
    expect(skill.evaluation.dims.map(dim => dim.id)).toEqual(['fluency', 'pronunciation', 'grammar', 'vocabulary', 'content'])
    expect(skill.labels.fluency).toBe('流利')
    expect(skillDimLabel(skill, 'fluency')).toBe('流利')
    const total = Object.values(skill.weights).reduce((sum, v) => sum + (v || 0), 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it('语言绑定：resolveSkillLanguage / supports / 自由选择', () => {
    const zhSkill = normalizePracticeSkill(entry('s1'), { schema: 1, targetLanguages: ['zh'] })
    expect(skillSupportsLanguage(zhSkill, 'zh')).toBe(true)
    expect(skillSupportsLanguage(zhSkill, 'en')).toBe(false)
    expect(resolveSkillLanguage(zhSkill, 'en')).toBe('zh') // 自动切换
    expect(resolveSkillLanguage(zhSkill, 'zh')).toBe('zh')
    const freeSkill = defaultPracticeSkill()
    expect(resolveSkillLanguage(freeSkill, 'en')).toBeNull()
    expect(skillSupportsLanguage(freeSkill, 'ja')).toBe(true)
  })

  it('aggregateOverallScore：average 取 overall 均值，weighted 按权重合成', () => {
    const avgSkill = normalizePracticeSkill(entry('avg'), {
      schema: 1,
      evaluation: { dimensions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], overallMode: 'average' },
    })
    const recsAvg = [
      { round: 1, overall: 2, a: 5, b: 5 },
      { round: 2, overall: 4, a: 5, b: 3 },
    ]
    expect(aggregateOverallScore(recsAvg, avgSkill)).toEqual({ value: 3, mode: 'average' })

    const weightedSkill = normalizePracticeSkill(entry('w'), {
      schema: 1,
      evaluation: {
        scale: { min: 1, max: 5 },
        dimensions: [
          { id: 'a', label: 'A', weight: 0.6 },
          { id: 'b', label: 'B', weight: 0.4 },
        ],
        overallMode: 'weighted',
      },
    })
    const recsW = [
      { round: 1, overall: 2, a: 5, b: 3 },
      { round: 2, overall: 4, a: 5, b: 5 },
    ]
    // a 均值 5 × 0.6 + b 均值 4 × 0.4 = 4.6
    expect(aggregateOverallScore(recsW, weightedSkill)).toEqual({ value: 4.6, mode: 'weighted' })
    expect(overallModeLabel(weightedSkill)).toContain('A 60%')
    // 无样本 → null
    expect(aggregateOverallScore([], weightedSkill)).toEqual({ value: null, mode: 'weighted' })
  })

  it('resultBandOf 按综合分落档（降序匹配 + 兜底最低档）', () => {
    const skill = normalizePracticeSkill(entry('bands'), {
      schema: 1,
      evaluation: {
        scale: { min: 1, max: 10 },
        resultBands: [
          { min: 8, label: '优秀' },
          { min: 5, label: '合格' },
          { min: 1, label: '待加强' },
        ],
      },
    })
    expect(resultBandOf(skill, 9)?.label).toBe('优秀')
    expect(resultBandOf(skill, 5)?.label).toBe('合格')
    expect(resultBandOf(skill, 2)?.label).toBe('待加强')
    expect(resultBandOf(skill, null)).toBeNull()
  })

  it('下拉选项：default 恒为首项 + 条目标签回退', () => {
    const entries: PracticeSkillEntry[] = [
      entry('plain', '技能简介'),
      entry('labelled', '简介', 'misc'),
    ]
    entries[1]!.manifest = { schema: 1, entry: { label: '自定义入口名', hint: 'hint' } }
    const options = toPracticeSkillOptions(entries)
    expect(options[0]?.key).toBe(PRACTICE_DEFAULT_SKILL_KEY)
    const labelled = options.find(option => option.name === 'labelled')
    expect(labelled?.label).toBe('自定义入口名')
    expect(labelled?.hint).toBe('hint')
    const plain = options.find(option => option.name === 'plain')
    expect(plain?.label).toBe('技能简介')
    // findPracticeSkillEntry 按 category/name 匹配
    expect(findPracticeSkillEntry(entries, { category: 'practice', name: 'plain' })?.name).toBe('plain')
    expect(findPracticeSkillEntry(entries, { category: 'x', name: 'missing' })).toBeNull()
    expect(findPracticeSkillEntry(entries, null)).toBeNull()
    expect(isDefaultSkillRef(undefined)).toBe(true)
  })

  it('收尾语识别（中英）', () => {
    expect(isClosingUtteranceLike('今天先到这里吧')).toBe(true)
    expect(isClosingUtteranceLike('我们结束吧')).toBe(true)
    expect(isClosingUtteranceLike("that's it for today")).toBe(true)
    expect(isClosingUtteranceLike('我想再练一轮')).toBe(false)
    expect(isClosingUtteranceLike('')).toBe(false)
  })

  it('buildPracticeFeedbackToolFor：动态维度 + 量表 + 摄像头开关', () => {
    const skill = normalizePracticeSkill(entry('sales'), {
      schema: 1,
      evaluation: {
        scale: { min: 1, max: 10 },
        dimensions: [
          { id: 'probing', label: '需求挖掘', rubric: '1-3 …；4-6 …；7-10 …' },
          { id: 'objection', label: '异议应对' },
        ],
      },
    })
    const tool = buildPracticeFeedbackToolFor(skill)
    expect(tool.name).toBe('submit_practice_feedback')
    expect(tool.parameters.properties.probing).toMatchObject({ type: 'number', minimum: 1, maximum: 10 })
    expect(String((tool.parameters.properties.probing as { description: string }).description)).toContain('需求挖掘')
    expect(tool.parameters.required).toContain('probing')
    expect(tool.parameters.required).toContain('comment')
    expect(tool.parameters.properties.bodyLanguage).toBeUndefined()
    const withCamera = buildPracticeFeedbackToolFor(skill, { camera: true })
    expect(withCamera.parameters.properties.bodyLanguage).toBeDefined()
    expect(withCamera.parameters.required).not.toContain('bodyLanguage')
    expect(withCamera.description).toContain('肢体语言')
  })

  it('收尾总评指令与报告标准段', () => {
    const skill = normalizePracticeSkill(entry('know'), {
      schema: 1,
      evaluation: {
        dimensions: [
          { id: 'accuracy', label: '概念准确', rubric: '1-3 …' },
          { id: 'apply', label: '应用迁移' },
        ],
      },
    })
    const prompt = buildPracticeClosingReviewPrompt(skill)
    expect(prompt).toContain('概念准确')
    expect(prompt).toContain('应用迁移')
    expect(prompt).toContain('round 填 0')
    const criteria = buildSkillCriteriaMarkdown(skill)
    expect(criteria).toContain('概念准确')
    expect(criteria).toContain('1-3 …')
  })
})
