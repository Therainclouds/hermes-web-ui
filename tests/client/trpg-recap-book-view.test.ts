// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, params?: unknown) => params ? `${key} ${JSON.stringify(params)}` : key, locale: { value: 'zh' } }) }))
import ChronicleBook from '../../packages/client/src/plugins/trpg/ChronicleBook.vue'

// Long enough that the character-budget fallback (no DOM measurer in jsdom)
// must spread the chronicle across several pages, so the book can actually turn.
const body = '银月举盾挡住箭雨，火把在风中摇晃。'.repeat(24)
const markdown = [
  '# 城门',
  '',
  '## 第一章 箭雨',
  '',
  body,
  '',
  '## 第二章 长夜',
  '',
  body,
].join('\n')

function mountBook() {
  return mount(ChronicleBook, {
    props: { markdown, title: '城门', mode: 'literary', tone: 'epic', generatedAt: Date.UTC(2026, 0, 2), timeline: [{ time: '夜半', text: '城门失守' }] },
  })
}

/** Let the requestAnimationFrame that starts a turn run before settling it. */
function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

/** Turn through every spread and collect what a reader would see. Page count
 * depends on the host's layout (jsdom cannot measure height), so tests read the
 * whole book instead of assuming a fixed pagination. */
async function readWholeBook(wrapper: ReturnType<typeof mountBook>): Promise<string> {
  let text = wrapper.get('.book-stage').text()
  for (let i = 0; i < 40; i++) {
    const next = wrapper.find('[aria-label="trpg.recap.bookNext"]')
    if (!next.exists() || next.attributes('disabled') !== undefined) break
    await next.trigger('click')
    await nextFrame()
    await wrapper.get('.leaf').trigger('transitionend', { propertyName: 'transform' })
    await flushPromises()
    text += `\n${wrapper.get('.book-stage').text()}`
  }
  return text
}

describe('ChronicleBook', () => {
  it('renders the cover, chronicle pages and timeline appendix from Markdown', async () => {
    const wrapper = mountBook()
    await flushPromises()
    expect(wrapper.get('.cover-title').text()).toBe('城门')
    const text = await readWholeBook(wrapper)
    expect(text).toContain('第一章 箭雨')
    expect(text).toContain('第二章 长夜')
    expect(text).toContain('银月举盾挡住箭雨')
    // Timeline appendix heading is localized and rendered on its own page.
    expect(text).toContain('trpg.recap.bookTimeline')
    expect(text).toContain('城门失守')
    wrapper.unmount()
  })

  it('turns a physical leaf and advances the spread when the turn settles', async () => {
    const wrapper = mountBook()
    await flushPromises()
    expect(wrapper.find('.leaf').exists()).toBe(false)
    // Spread 0 is the cover plus the first chronicle page.
    expect(wrapper.get('.page--left').html()).toContain('城门')
    expect(wrapper.get('.book-position').text()).toContain('"page":1')
    await wrapper.get('[aria-label="trpg.recap.bookNext"]').trigger('click')
    await nextFrame()
    const leaf = wrapper.get('.leaf')
    expect(leaf.classes()).toContain('leaf--next')
    // The paper angle is driven by the turn progress, not a keyframe.
    expect(leaf.attributes('style')).toContain('rotateY(-180')
    await leaf.trigger('transitionend', { propertyName: 'transform' })
    await flushPromises()
    expect(wrapper.find('.leaf').exists()).toBe(false)
    // A spread advances by two page indices: the cover has turned away and the
    // spread counter moved on.
    expect(wrapper.get('.page--left').html()).not.toContain('cover-title')
    expect(wrapper.get('.book-position').text()).toContain('"page":2')
    wrapper.unmount()
  })

  it('lists every chapter in the contents drawer and jumps to its page', async () => {
    const wrapper = mountBook()
    await flushPromises()
    await wrapper.get('.book-btn--toc').trigger('click')
    const items = wrapper.findAll('.book-toc__item')
    expect(items.map(item => item.text())).toEqual([
      expect.stringContaining('第一章 箭雨'),
      expect.stringContaining('第二章 长夜'),
    ])
    await items[1].trigger('click')
    expect(wrapper.find('.book-toc').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the cover image beside the book and opens the current image on demand', async () => {
    const wrapper = mount(ChronicleBook, {
      props: {
        markdown, title: '城门', mode: 'literary', tone: 'epic',
        timeline: [{ time: '夜半', text: '城门失守' }],
        chapters: [{ id: 'c1', title: '第一章 箭雨' }, { id: 'c2', title: '第二章 长夜' }],
        images: [{ kind: 'cover', url: 'blob:cover' }, { kind: 'content', chapterId: 'c2', url: 'blob:chapter' }],
      },
    })
    await flushPromises()
    // The lightbox is teleported to <body>, so query the document rather than the wrapper.
    const lightboxImage = () => document.querySelector<HTMLImageElement>('[data-testid="book-lightbox"] img')
    // The illustration rail sits beside the book and starts on the cover image.
    expect(wrapper.get('[data-testid="book-visual"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="book-visual-frame"] img').attributes('src')).toBe('blob:cover')
    expect(lightboxImage()).toBeNull()
    // The toolbar button opens the current image full-screen.
    await wrapper.get('[data-testid="book-image-btn"]').trigger('click')
    expect(lightboxImage()?.getAttribute('src')).toBe('blob:cover')
    document.querySelector<HTMLElement>('.book-lightbox__close')?.click()
    await flushPromises()
    expect(lightboxImage()).toBeNull()
    // Turning away from the cover swaps the rail to the chapter illustration.
    await wrapper.get('[aria-label="trpg.recap.bookNext"]').trigger('click')
    await nextFrame()
    await wrapper.get('.leaf').trigger('transitionend', { propertyName: 'transform' })
    await flushPromises()
    expect(wrapper.get('[data-testid="book-visual-frame"] img').attributes('src')).toBe('blob:chapter')
    await wrapper.get('[data-testid="book-visual-frame"]').trigger('click')
    expect(lightboxImage()?.getAttribute('src')).toBe('blob:chapter')
    wrapper.unmount()
  })

  it('renders no illustration rail when the chronicle has no images', async () => {
    const wrapper = mountBook()
    await flushPromises()
    expect(wrapper.find('[data-testid="book-visual"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="book-image-btn"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
