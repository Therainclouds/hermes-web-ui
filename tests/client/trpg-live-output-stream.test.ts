// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import LiveOutputStream from '../../packages/client/src/plugins/trpg/LiveOutputStream.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (s: string, params?: Record<string, unknown>) => {
      if (!params) return s
      return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s)
    },
  }),
}))

const label = (s: string) => s

describe('LiveOutputStream visual coverage', () => {
  it('renders a complete review output with body, continuity, warnings, coverage and tool badge', () => {
    const json = JSON.stringify({
      body: '甘棠收起奥法数据终端的动作还没做完，嘴角那抹嘲弄却已经挂了回去。\n\n【甘棠·Sylvan】"我们奥法逻辑里最不够精密的一种职业——"\n\n她的声音不大，却刚好能送到身后那条黑龙的耳朵里。',
      continuity: '时间：午后，雨势减弱但未散，浓雾未散。\n地点：从积灰小路推进至沙漠古堡前方约百步的开阔土路。',
      warnings: ['原文 ASR 噪声较多，row 133「我感觉我真的把文本输偷了」属场外/断裂句'],
      coverage: [
        { eventId: 's7-e0', paragraph: 0, quote: '甘棠收起奥法数据终端' },
        { eventId: 's7-e1', paragraph: 5, quote: '甘棠嘲讽法师' },
        { eventId: 's7-e2', paragraph: 8, quote: '塞勒斯提议去看古堡' },
      ],
      covered: [131, 132, 134, 135, 136, 137, 138, 139, 141, 142, 143, 144],
    })
    const wrapper = mount(LiveOutputStream, {
      props: { output: { step: 'review-8', updatedAt: 1, text: '```json\n' + json + '\n```' }, label },
    })
    expect(wrapper.find('.tool-badge.tone-review').exists()).toBe(true)
    expect(wrapper.find('.stream-prose p').exists()).toBe(true)
    expect(wrapper.text()).toContain('甘棠收起奥法数据终端')
    expect(wrapper.text()).toContain('s7-e0')
    expect(wrapper.text()).toContain('131, 132, 134')
    expect(wrapper.text()).toContain('原文 ASR 噪声较多')
    expect(wrapper.find('.stream-warnings li').exists()).toBe(true)
  })

  it('renders a complete consistency report with fail status, issues, suggestions and coverage', () => {
    const json = JSON.stringify({
      passed: false,
      coverage: [
        { eventId: 's7-e0', paragraph: 0, quote: '甘棠收起奥法数据终端' },
        { eventId: 's7-e2', paragraph: 5, quote: '塞勒斯提议去看' },
      ],
      issues: [
        { detail: '原文 ASR 噪声 row 133 与正文无对应，疑似场外/断裂句，需在生成中剔除' },
        { detail: '正文遗漏了「卡进沙地」的关键事实，应在修订中补足' },
      ],
      suggestions: [
        { detail: '可补一笔井口光线，不影响事实验收' },
        { detail: '可在开头加入甘棠的内心独白铺垫情绪' },
      ],
    })
    const wrapper = mount(LiveOutputStream, {
      props: { output: { step: 'check-8', updatedAt: 1, text: '```json\n' + json + '\n```' }, label },
    })
    expect(wrapper.find('.tool-badge.tone-check').exists()).toBe(true)
    expect(wrapper.find('.stream-status.failed').exists()).toBe(true)
    expect(wrapper.text()).toContain('正文遗漏了')
    expect(wrapper.text()).toContain('可补一笔井口光线')
    expect(wrapper.findAll('.stream-coverage li')).toHaveLength(2)
    expect(wrapper.findAll('.stream-issues li')).toHaveLength(2)
    expect(wrapper.findAll('.stream-suggestions li')).toHaveLength(2)
  })
})
