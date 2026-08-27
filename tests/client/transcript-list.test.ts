// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import TranscriptList from '@/components/hermes/meeting/TranscriptList.vue'
import type { TranscriptSentence } from '@/stores/hermes/meeting'

const baseProps = {
  sentences: [] as TranscriptSentence[],
  partialText: '',
  highlightedIndex: -1,
  isRecording: false,
  hideSpeakerDiarization: true,
}

function makeSentences(): TranscriptSentence[] {
  return [
    { text: '第一句话', timestamp: 1000, speaker: '张三', speakerId: 'spk_1', startTime: 1000 },
    { text: '第二句话', timestamp: 5000, speaker: '李四', speakerId: 'spk_2', startTime: 5000 },
    { text: '第三句话', timestamp: 9000 },
  ]
}

describe('TranscriptList', () => {
  it('renders empty state when no sentences and no partial text', () => {
    const wrapper = mount(TranscriptList, { props: baseProps })
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.findAll('.sentence-item')).toHaveLength(0)
  })

  it('renders one item per sentence', () => {
    const wrapper = mount(TranscriptList, {
      props: { ...baseProps, sentences: makeSentences() },
    })
    expect(wrapper.findAll('.sentence-item')).toHaveLength(3)
    expect(wrapper.find('.sentence-item .sentence-text').text()).toBe('第一句话')
  })

  it('emits seek with index when a clickable sentence is clicked', async () => {
    const wrapper = mount(TranscriptList, {
      props: { ...baseProps, sentences: makeSentences() },
    })
    await wrapper.findAll('.sentence-item')[0].trigger('click')
    expect(wrapper.emitted('seek')).toEqual([[0]])
  })

  it('does not emit seek while recording', async () => {
    const wrapper = mount(TranscriptList, {
      props: { ...baseProps, sentences: makeSentences(), isRecording: true },
    })
    await wrapper.findAll('.sentence-item')[0].trigger('click')
    expect(wrapper.emitted('seek')).toBeUndefined()
  })

  it('marks the highlighted sentence', () => {
    const wrapper = mount(TranscriptList, {
      props: { ...baseProps, sentences: makeSentences(), highlightedIndex: 1 },
    })
    const items = wrapper.findAll('.sentence-item')
    expect(items[1].classes()).toContain('highlighted')
    expect(items[0].classes()).not.toContain('highlighted')
  })

  it('shows partial text with indicator', () => {
    const wrapper = mount(TranscriptList, {
      props: { ...baseProps, partialText: '正在识别中…' },
    })
    expect(wrapper.find('.partial-text').exists()).toBe(true)
    expect(wrapper.find('.partial-text').text()).toContain('正在识别中…')
  })

  it('hides speaker rename when hideSpeakerDiarization=true', () => {
    const wrapper = mount(TranscriptList, {
      props: { ...baseProps, sentences: makeSentences() },
    })
    expect(wrapper.find('.sentence-speaker').exists()).toBe(false)
  })

  it('shows speaker names when diarization is enabled', () => {
    const wrapper = mount(TranscriptList, {
      props: {
        ...baseProps,
        sentences: makeSentences(),
        hideSpeakerDiarization: false,
      },
    })
    expect(wrapper.findAll('.sentence-speaker').length).toBe(2) // only items with speakerId
    expect(wrapper.find('.sentence-speaker').text()).toBe('张三')
  })

  it('emits rename after typing in the popover input', async () => {
    // NPopover teleports to <body>; mount against a real DOM node so the
    // teleported content is queryable.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(TranscriptList, {
      props: {
        ...baseProps,
        sentences: makeSentences(),
        hideSpeakerDiarization: false,
      },
      attachTo: host,
    })
    // Open the popover by clicking the speaker
    const speaker = wrapper.find('.sentence-speaker')
    await speaker.trigger('click')
    await new Promise((r) => setTimeout(r, 30))

    // NPopover renders into document.body — query there
    const input = document.body.querySelector('.speaker-rename-popover input')
    expect(input).not.toBeNull()
    ;(input as HTMLInputElement).value = '王五'
    input!.dispatchEvent(new Event('input', { bubbles: true }))

    // Click the confirm button (teleported too)
    const confirmBtn = Array.from(
      document.body.querySelectorAll('.speaker-rename-actions button'),
    ).find((b) => b.textContent?.includes('common.confirm'))
    expect(confirmBtn).toBeDefined()
    confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(wrapper.emitted('rename')).toEqual([['spk_1', '王五']])
  })
})