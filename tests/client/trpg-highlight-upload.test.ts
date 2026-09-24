// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
// The modal is not the subject here; a stub keeps naive-ui out of the test run.
vi.mock('naive-ui', () => ({
  NModal: { name: 'NModal', props: { show: Boolean }, template: '<div v-if="show" class="n-modal-stub"><slot /></div>' },
}))
import HighlightGallery from '../../packages/client/src/plugins/trpg/HighlightGallery.vue'
import { IMAGE_MIMES, MAX_IMAGE_BYTES, isSupportedImage } from '../../packages/client/src/plugins/trpg/image-io'
import type { Highlight } from '../../packages/client/src/plugins/trpg/storage'

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return { id: 'h1', prompt: 'p', createdAt: 0, transcript: '', actions: [], ...overrides }
}

async function pickFile(wrapper: ReturnType<typeof mount>, file: File, index = 0) {
  const input = wrapper.findAll('input[type=file]')[index]
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  return input.trigger('change')
}

describe('highlight gallery manual upload', () => {
  it('emits the picked file so the panel can validate, store and persist it', async () => {
    const wrapper = mount(HighlightGallery, {
      props: { highlights: [highlight()], images: {}, busy: false, direct: false },
    })
    const file = new File(['x'], 'manual.png', { type: 'image/png' })

    await pickFile(wrapper, file)

    const emitted = wrapper.emitted('upload')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ file, highlight: expect.objectContaining({ id: 'h1' }) })
    wrapper.unmount()
  })

  it('offers upload on an empty card and replace once an image exists', async () => {
    const empty = mount(HighlightGallery, { props: { highlights: [highlight()], images: {}, busy: false, direct: false } })
    expect(empty.get('.scene-upload').text()).toContain('trpg.uploadImage')
    empty.unmount()

    const filled = mount(HighlightGallery, {
      props: {
        highlights: [highlight({ image: new Blob(), imageModel: 'trpg.manualUpload', imageName: 'dragon.png' })],
        images: { h1: 'blob:x' }, busy: false, direct: false,
      },
    })
    expect(filled.get('.scene-footer').text()).toContain('dragon.png')
    expect(filled.get('.scene-upload').text()).toContain('trpg.replaceImage')
    filled.unmount()
  })
})

describe('isSupportedImage', () => {
  it('accepts only storable image types within the size bound', () => {
    expect(isSupportedImage({ type: 'image/png', size: 10 })).toBe(true)
    expect(isSupportedImage({ type: 'image/jpeg', size: MAX_IMAGE_BYTES })).toBe(true)
    expect(isSupportedImage({ type: 'image/gif', size: 10 })).toBe(false)
    expect(isSupportedImage({ type: 'image/png', size: 0 })).toBe(false)
    expect(isSupportedImage({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toBe(false)
    expect(IMAGE_MIMES).toContain('image/webp')
  })
})
