// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MeetingRightPanel from '@/components/hermes/meeting/MeetingRightPanel.vue'

/**
 * Right-panel shell: header + resize handle + 3-slot dispatch.
 *   speech (isSpeechScene) > agent (showAgentPanel) > analysis (default)
 * Toolbar slot only renders in analysis mode (matches parent wiring).
 *
 * Tests guard:
 * - visibility gate (renders aside only when visible=true)
 * - title text per dispatch mode (t('meeting.scene.speech' | 'meeting.agentChat' | 'meeting.analysis'))
 * - close emit
 * - resize-start emit with pointer event
 * - toolbar slot presence (analysis only)
 * - dispatch: which slot is mounted
 */
describe('MeetingRightPanel', () => {
  const baseProps = {
    visible: true,
    isSpeechScene: false,
    showAgentPanel: false,
    resizeStyle: { width: '360px' },
  }

  it('renders nothing when visible=false', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, visible: false },
    })
    expect(wrapper.find('.right-panel').exists()).toBe(false)
  })

  it('renders the panel chrome when visible=true', () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    expect(wrapper.find('.right-panel').exists()).toBe(true)
    expect(wrapper.find('.right-panel-resize-handle').exists()).toBe(true)
    expect(wrapper.find('.right-panel-header').exists()).toBe(true)
    expect(wrapper.find('.panel-close-btn').exists()).toBe(true)
  })

  it('shows analysis title by default', () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    expect(wrapper.find('h2').text()).toBe('meeting.analysis')
  })

  it('shows agent title when showAgentPanel=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showAgentPanel: true },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.agentChat')
  })

  it('shows speech title when isSpeechScene=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, isSpeechScene: true },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.scene.speech')
  })

  it('prefers speech over agent (dispatch priority)', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: {
        ...baseProps,
        isSpeechScene: true,
        showAgentPanel: true,
      },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.scene.speech')
  })

  it('emits close when the close button is clicked', async () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    await wrapper.find('.panel-close-btn').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('emits resize-start with the pointer event when handle is pressed', async () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    // Note: passing the PointerEvent directly trips @vue/test-utils' event
    // builder (jsdom's PointerEvent has read-only isTrusted). Trigger with
    // an empty options bag and rely on the wrapper's emitted[0][0] being
    // the synthetic PointerEvent — that's enough to prove the event payload
    // round-trips through emit().
    await wrapper.find('.right-panel-resize-handle').trigger('pointerdown')
    expect(wrapper.emitted('resize-start')).toBeTruthy()
    expect(wrapper.emitted('resize-start')).toHaveLength(1)
    const payload = wrapper.emitted('resize-start')![0][0] as Event
    expect(payload).toBeInstanceOf(PointerEvent)
    expect(payload.type).toBe('pointerdown')
  })

  it('renders toolbar slot only in analysis mode', () => {
    const analysisWrapper = mount(MeetingRightPanel, {
      props: baseProps,
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(analysisWrapper.find('.custom-tool').exists()).toBe(true)

    const agentWrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showAgentPanel: true },
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(agentWrapper.find('.right-panel-toolbar').exists()).toBe(false)
    expect(agentWrapper.find('.custom-tool').exists()).toBe(false)

    const speechWrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, isSpeechScene: true },
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(speechWrapper.find('.right-panel-toolbar').exists()).toBe(false)
  })

  it('mounts analysis slot content in default mode', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: baseProps,
      slots: { analysis: '<div class="analysis-marker">analysis-body</div>' },
    })
    expect(wrapper.find('.analysis-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').text()).toBe('analysis-body')
  })

  it('mounts agent slot content when showAgentPanel=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showAgentPanel: true },
      slots: { agent: '<div class="agent-marker">agent-body</div>' },
    })
    expect(wrapper.find('.agent-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('mounts speech slot content when isSpeechScene=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, isSpeechScene: true },
      slots: { speech: '<div class="speech-marker">speech-body</div>' },
    })
    expect(wrapper.find('.speech-marker').exists()).toBe(true)
    expect(wrapper.find('.agent-marker').exists()).toBe(false)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('renders resizeStyle on the aside element', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, resizeStyle: { width: '420px' } },
    })
    const aside = wrapper.find('.right-panel')
    expect((aside.element as HTMLElement).style.width).toBe('420px')
  })
})