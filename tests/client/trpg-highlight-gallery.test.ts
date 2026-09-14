// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
// The modal is not the subject here; a stub keeps naive-ui out of the test run.
vi.mock('naive-ui', () => ({
  NModal: { name: 'NModal', props: { show: Boolean }, template: '<div v-if="show" class="n-modal-stub"><slot /></div>' },
}))
import HighlightGallery from '../../packages/client/src/plugins/trpg/HighlightGallery.vue'
import type { Highlight } from '../../packages/client/src/plugins/trpg/storage'

function highlight(index: number): Highlight {
  return { id: `h${index}`, prompt: 'p', createdAt: index, transcript: '', actions: [] }
}
function list(count: number): Highlight[] {
  return Array.from({ length: count }, (_, i) => highlight(i))
}

describe('highlight gallery history', () => {
  it('shows the newest 30 and expands every earlier highlight on demand', async () => {
    const wrapper = mount(HighlightGallery, { props: { highlights: list(35), images: {}, busy: false, direct: false } })

    expect(wrapper.findAll('.highlight-card')).toHaveLength(30)
    expect(wrapper.get('.count').text()).toBe('30 / 35')

    await wrapper.get('.gallery-more').trigger('click')

    expect(wrapper.findAll('.highlight-card')).toHaveLength(35)
    expect(wrapper.findAll('.highlight-card.older')).toHaveLength(5)
    wrapper.unmount()
  })

  it('hides the expand control when there is nothing older to show', () => {
    const wrapper = mount(HighlightGallery, { props: { highlights: list(30), images: {}, busy: false, direct: false } })
    expect(wrapper.find('.gallery-more').exists()).toBe(false)
    wrapper.unmount()
  })

  it('links to the highlight manager and keeps older cards switchable and uploadable', async () => {
    const wrapper = mount(HighlightGallery, {
      props: { highlights: list(31), images: {}, busy: false, direct: false, manageHref: '/recap-book.html?workspace=highlights&meetingId=m' },
    })
    expect(wrapper.get('.gallery-manage').attributes('href')).toContain('workspace=highlights')

    await wrapper.get('.gallery-more').trigger('click')
    const older = wrapper.findAll('.highlight-card')[30]
    expect(older.classes()).toContain('older')
    expect(older.get('.scene-manage').attributes('href')).toContain('highlight=h30')

    const file = new File(['x'], 'old.png', { type: 'image/png' })
    const input = older.get('input[type=file]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')

    const emitted = wrapper.emitted('upload')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ file, highlight: expect.objectContaining({ id: 'h30' }) })
    wrapper.unmount()
  })
})
