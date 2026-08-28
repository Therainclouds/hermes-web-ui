// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MeetingTopBar from '@/components/hermes/meeting/MeetingTopBar.vue'

const baseProps = {
  sidebarExpanded: true,
  showAgentPanel: false,
  showRealtimeDialog: false,
  useDiarize: false,
  saveMode: false,
  speakerCount: 0,
  speakerCountOptions: [
    { label: 'Auto', value: 0 },
    { label: '2', value: 2 },
    { label: '3', value: 3 },
  ],
  isRecording: false,
  hasSentences: true,
  hideSpeakerDiarization: true,
}

describe('MeetingTopBar', () => {
  it('renders header with title', () => {
    const wrapper = mount(MeetingTopBar, { props: baseProps })
    expect(wrapper.find('.meeting-header').exists()).toBe(true)
    expect(wrapper.find('h1').text()).toContain('meeting.title')
  })

  it('emits toggle-sidebar when the avatar toggle is clicked', async () => {
    const wrapper = mount(MeetingTopBar, { props: baseProps })
    await wrapper.find('.header-avatar-toggle').trigger('click')
    expect(wrapper.emitted('toggle-sidebar')).toBeTruthy()
  })

  it('emits toggle-agent-panel when the agent button is clicked', async () => {
    const wrapper = mount(MeetingTopBar, { props: baseProps })
    const buttons = wrapper.findAll('button')
    const agentBtn = buttons.find((b) => b.text().includes('meeting.agentChat'))
    expect(agentBtn).toBeDefined()
    await agentBtn!.trigger('click')
    expect(wrapper.emitted('toggle-agent-panel')).toBeTruthy()
  })

  it('emits clear-transcript when the clear button is clicked', async () => {
    const wrapper = mount(MeetingTopBar, { props: baseProps })
    const buttons = wrapper.findAll('button')
    const clearBtn = buttons.find((b) => b.text().includes('meeting.clear'))
    expect(clearBtn).toBeDefined()
    await clearBtn!.trigger('click')
    expect(wrapper.emitted('clear-transcript')).toBeTruthy()
  })

  it('disables clear button when hasSentences=false', () => {
    const wrapper = mount(MeetingTopBar, {
      props: { ...baseProps, hasSentences: false },
    })
    const buttons = wrapper.findAll('button')
    const clearBtn = buttons.find((b) => b.text().includes('meeting.clear'))
    expect(clearBtn).toBeDefined()
    expect((clearBtn!.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables clear button when isRecording=true', () => {
    const wrapper = mount(MeetingTopBar, {
      props: { ...baseProps, isRecording: true },
    })
    const buttons = wrapper.findAll('button')
    const clearBtn = buttons.find((b) => b.text().includes('meeting.clear'))
    expect((clearBtn!.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides diarize controls when hideSpeakerDiarization=true', () => {
    const wrapper = mount(MeetingTopBar, { props: baseProps })
    expect(wrapper.text()).not.toContain('meeting.diarize')
  })

  it('shows diarize controls when hideSpeakerDiarization=false', () => {
    const wrapper = mount(MeetingTopBar, {
      props: { ...baseProps, hideSpeakerDiarization: false },
    })
    expect(wrapper.text()).toContain('meeting.diarize')
  })
})