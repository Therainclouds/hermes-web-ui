// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MeetingSidebar, {
  type SidebarSession,
} from '@/components/hermes/meeting/MeetingSidebar.vue'

// PageSidebarNav / PageSidebarFooter 是 layout 通用组件，jsdom 下 mount 无副作用。
function makeSessions(): SidebarSession[] {
  return [
    {
      id: 's1',
      title: '项目同步会',
      updatedAt: Date.UTC(2026, 7, 26, 9, 0),
      sentencesCount: 12,
      hasAnalysis: true,
    },
    {
      id: 's2',
      title: '产品评审',
      updatedAt: Date.UTC(2026, 7, 27, 14, 30),
      sentencesCount: 3,
      hasAnalysis: false,
    },
  ]
}

describe('MeetingSidebar', () => {
  it('renders empty-state placeholder when sessions is empty', () => {
    const wrapper = mount(MeetingSidebar, {
      props: { expanded: true, sessions: [], activeId: null },
    })
    expect(wrapper.find('.meeting-list-empty').exists()).toBe(true)
    expect(wrapper.findAll('.meeting-list-item')).toHaveLength(0)
  })

  it('renders one button per session and marks the active one', () => {
    const wrapper = mount(MeetingSidebar, {
      props: {
        expanded: true,
        sessions: makeSessions(),
        activeId: 's2',
      },
    })
    const items = wrapper.findAll('.meeting-list-item')
    expect(items).toHaveLength(2)

    const activeItems = items.filter((i) => i.classes().includes('active'))
    expect(activeItems).toHaveLength(1)
    expect(activeItems[0].text()).toContain('产品评审')

    // hasAnalysis 触发 AI badge
    expect(wrapper.text()).toContain('AI')
  })

  it('emits select with the clicked session id', async () => {
    const wrapper = mount(MeetingSidebar, {
      props: { expanded: true, sessions: makeSessions(), activeId: null },
    })
    await wrapper.findAll('.meeting-list-item')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['s2']])
  })

  it('emits create when the primary nav button is clicked', async () => {
    const wrapper = mount(MeetingSidebar, {
      props: { expanded: true, sessions: [], activeId: null },
    })
    // PageSidebarNav emits 'primary' — fire it on the inner component
    await wrapper.findComponent({ name: 'PageSidebarNav' }).vm.$emit('primary')
    expect(wrapper.emitted('create')).toBeTruthy()
  })

  it('emits update:expanded=false when the backdrop is clicked', async () => {
    const wrapper = mount(MeetingSidebar, {
      props: { expanded: true, sessions: [], activeId: null },
    })
    await wrapper.find('.sidebar-backdrop').trigger('click')
    expect(wrapper.emitted('update:expanded')).toEqual([[false]])
  })

  it('hides list and footer when expanded=false (collapsed)', () => {
    const wrapper = mount(MeetingSidebar, {
      props: { expanded: false, sessions: makeSessions(), activeId: null },
    })
    expect(wrapper.find('.page-sidebar-top').exists()).toBe(false)
    expect(wrapper.findAll('.meeting-list-item')).toHaveLength(0)
    // Aside carries .collapsed
    expect(wrapper.find('aside.meeting-sidebar').classes()).toContain('collapsed')
  })

  it('exposes item-actions slot scoped data (session)', () => {
    const wrapper = mount(MeetingSidebar, {
      props: { expanded: true, sessions: makeSessions(), activeId: null },
      slots: {
        'item-actions': '<button class="custom-delete">×</button>',
      },
    })
    const buttons = wrapper.findAll('button.custom-delete')
    expect(buttons).toHaveLength(2)
  })
})