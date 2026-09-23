import { describe, expect, it } from 'vitest'
import { mechanicIssues, narratorIssues } from '../../packages/server/src/services/trpg/novel-revision'

describe('TRPG rule language detector', () => {
  it('flags a check/save sentence and points at the paragraph', () => {
    const body = '他屏住呼吸。\n\nDC三十的检定压在十五的感知上，更不必提紧跟着还要扛那十六、十九的属性豁免。'
    const issues = mechanicIssues(body)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'format', source: 'mechanics' })
    expect(issues[0].detail).toContain('第 1 段')
    expect(issues[0].detail).toContain('规则用语')
    // The detail must tell the editor how to translate it, not only that it is wrong.
    expect(issues[0].detail).toContain('世界内的叙述')
  })

  it.each([
    '他掷骰决定命运。',
    '先攻顺序已经确定。',
    'AC 15 的护甲挡下了这一击。',
    '这一击造成 2d6 伤害。',
    '他的生命值只剩下 3 点。',
    '她还有两个法术位。',
  ])('flags %s', text => expect(mechanicIssues(text)).toHaveLength(1))

  it('does not flag ordinary narrative prose', () => {
    const clean = '强健的体魄与常年研读养成的直觉让他先一步察觉了危险。他侧身一让，从怪物的诅咒陷阱里脱身。\n\n她感知到暗处有东西在呼吸，优势并不在她这一边。'
    expect(mechanicIssues(clean)).toEqual([])
  })

  it('reports one finding per affected paragraph and none for clean ones', () => {
    const body = '第一段很干净。\n\n第二段有检定。\n\n第三段说 DC 20。'
    expect(mechanicIssues(body).map(issue => issue.detail.match(/第 \d+ 段/)![0])).toEqual(['第 1 段', '第 2 段'])
  })

  it('keeps narrator and mechanics findings distinct in source', () => {
    expect(narratorIssues('GM：他开始描述。')[0].source).toBe('narrator')
    expect(mechanicIssues('他进行了一次检定。')[0].source).toBe('mechanics')
  })
})
