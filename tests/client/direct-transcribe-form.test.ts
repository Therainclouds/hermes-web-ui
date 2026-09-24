// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => `i18n:${key}` }),
}))

import DirectTranscribeForm from '@/components/hermes/meeting/DirectTranscribeForm.vue'

function mountForm(overrides: Record<string, unknown> = {}) {
  return mount(DirectTranscribeForm, {
    props: {
      engine: 'minimax',
      diarize: true,
      speakerCount: 0,
      file: null,
      ...overrides,
    },
  })
}

describe('DirectTranscribeForm', () => {
  it('renders both engines and the diarization switch', () => {
    const wrapper = mountForm()
    expect(wrapper.text()).toContain('i18n:meeting.asrProviderMinimax')
    expect(wrapper.text()).toContain('i18n:meeting.asrProviderDashscope')
    expect(wrapper.text()).toContain('i18n:meeting.directDiarize')
    expect(wrapper.find('.n-switch').exists()).toBe(true)
    expect(wrapper.find('.n-switch--disabled').exists()).toBe(false)
    expect(wrapper.text()).toContain('i18n:meeting.directDiarizeHint')
  })

  it('prompts for a file before anything is selected', () => {
    const wrapper = mountForm()
    expect(wrapper.text()).toContain('i18n:meeting.directNoFile')
  })

  it('shows the selected file name', () => {
    const file = new File(['audio'], 'board-meeting.mp3', { type: 'audio/mpeg' })
    const wrapper = mountForm({ file })
    expect(wrapper.text()).toContain('board-meeting.mp3')
    expect(wrapper.text()).not.toContain('i18n:meeting.directNoFile')
  })

  it('disables the diarization switch for the Qwen engine and explains why', () => {
    const wrapper = mountForm({ engine: 'qwen', diarize: false })
    expect(wrapper.find('.n-switch--disabled').exists()).toBe(true)
    expect(wrapper.text()).toContain('i18n:meeting.directDiarizeUnsupported')
    // Qwen's 5-minute synchronous limit must be surfaced
    expect(wrapper.text()).toContain('i18n:meeting.directQwenLengthHint')
  })

  it('hides the speaker count picker when diarization is off', () => {
    const withDiarize = mountForm({ diarize: true })
    expect(withDiarize.text()).toContain('i18n:meeting.speakerCount')
    const withoutDiarize = mountForm({ diarize: false })
    expect(withoutDiarize.text()).not.toContain('i18n:meeting.speakerCount')
  })

  it('switching to Qwen clears the diarization flag', async () => {
    const wrapper = mountForm({ engine: 'minimax', diarize: true })
    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    await radios[1].setValue()
    expect(wrapper.emitted('update:engine')?.at(-1)).toEqual(['qwen'])
    expect(wrapper.emitted('update:diarize')?.at(-1)).toEqual([false])
  })

  it('switching back to MiniMax keeps diarization available', async () => {
    const wrapper = mountForm({ engine: 'qwen', diarize: false })
    const radios = wrapper.findAll('input[type="radio"]')
    await radios[0].setValue()
    expect(wrapper.emitted('update:engine')?.at(-1)).toEqual(['minimax'])
    expect(wrapper.find('.n-switch--disabled').exists()).toBe(false)
  })
})
