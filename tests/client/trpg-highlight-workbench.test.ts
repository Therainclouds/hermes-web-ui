// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ campaignStorage: vi.fn(), writingRequest: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../../packages/client/src/plugins/trpg/storage', () => ({
  HIGHLIGHT_RECENT_LIMIT: 30,
  campaignStorage: mocks.campaignStorage,
  snapshotCampaign: (value: unknown) => value,
}))
vi.mock('../../packages/client/src/plugins/trpg/bookApi', () => ({
  campaignStorageKey: () => 'campaign-key',
  writingRequest: mocks.writingRequest,
}))
vi.mock('../../packages/client/src/plugins/trpg/image-io', async importOriginal => ({ ...await importOriginal<typeof import('../../packages/client/src/plugins/trpg/image-io')>(), imageDataUri: vi.fn().mockResolvedValue('data:image/jpeg;base64,cGl4ZWxz') }))
import HighlightWorkbench from '../../packages/client/src/plugins/trpg/HighlightWorkbench.vue'
import type { Campaign, Highlight } from '../../packages/client/src/plugins/trpg/storage'

function campaign(highlights: Highlight[]): Campaign {
  return { characters: [], setting: '', style: '', highlights }
}
function highlight(index: number, overrides: Partial<Highlight> = {}): Highlight {
  return { id: `h${index}`, prompt: 'p', createdAt: index, transcript: '', actions: [], ...overrides }
}

beforeEach(() => {
  mocks.campaignStorage.mockReset()
  mocks.writingRequest.mockReset()
  vi.stubGlobal('crypto', { randomUUID: () => 'generated-id' })
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
})

describe('highlight workbench', () => {
  it('lists the newest 30 and expands every earlier highlight without dropping it', async () => {
    mocks.campaignStorage.mockResolvedValue(campaign(Array.from({ length: 32 }, (_, i) => highlight(i))))
    const wrapper = mount(HighlightWorkbench, { props: { meetingId: 'm', profile: 'default' } })
    await flushPromises()

    expect(wrapper.findAll('.hw-card')).toHaveLength(30)
    expect(wrapper.get('.hw-list-head').text()).toContain('30 / 32')

    await wrapper.get('.hw-more').trigger('click')
    expect(wrapper.findAll('.hw-card')).toHaveLength(32)
    expect(wrapper.findAll('.hw-card.older')).toHaveLength(2)
    wrapper.unmount()
  })

  it('creates a highlight from text alone and persists it to the shared campaign', async () => {
    mocks.campaignStorage.mockResolvedValue(campaign([]))
    const wrapper = mount(HighlightWorkbench, { props: { meetingId: 'm', profile: 'default' } })
    await flushPromises()

    await wrapper.get('.hw-create input').setValue('断桥崩塌')
    await wrapper.get('.hw-create textarea').setValue('你们来到断桥边，桥面已经塌了一半。')
    await wrapper.get('.hw-create .primary').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.hw-card')).toHaveLength(1)
    const [, saved] = mocks.campaignStorage.mock.calls.at(-1)!
    expect(saved.highlights[0]).toMatchObject({ id: 'generated-id', title: '断桥崩塌', transcript: '你们来到断桥边，桥面已经塌了一半。', source: 'manual' })
    expect(mocks.campaignStorage.mock.calls.at(-1)![0]).toBe('campaign-key')
    wrapper.unmount()
  })

  it('attaches an uploaded image to an older highlight and rewrites the record', async () => {
    mocks.campaignStorage.mockResolvedValue(campaign([highlight(0)]))
    const wrapper = mount(HighlightWorkbench, { props: { meetingId: 'm', profile: 'default' } })
    await flushPromises()

    const file = new File(['x'], 'scene.png', { type: 'image/png' })
    const input = wrapper.get('.hw-upload input[type=file]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()

    const [, saved] = mocks.campaignStorage.mock.calls.at(-1)!
    expect(saved.highlights[0]).toMatchObject({ image: file, imageName: 'scene.png', imageModel: 'trpg.manualUpload' })
    wrapper.unmount()
  })

  it('scores a highlight against the selected novel chapter', async () => {
    const line = '你们来到断桥边，桥面已经塌了一半。'
    mocks.campaignStorage.mockResolvedValue(campaign([highlight(0, { transcript: line, image: new Blob(['x'], { type: 'image/png' }), prompt: '薄雾笼罩断桥' })]))
    mocks.writingRequest.mockImplementation((path: string) => {
      if (path.endsWith('/workbench')) {
        return Promise.resolve({ job: { recapId: '' }, layout: [{ index: 0, scenes: [{ index: 0, from: 0, to: 0, title: '断桥' }] }], artifacts: [], events: [], controls: {} })
      }
      if (path.endsWith('/visual-match')) return Promise.resolve({ description: '薄雾笼罩断桥', uncertainties: ['不能确认人物身份'], matches: [{ chapter: 0, scene: 0, title: '断桥', score: 0.8, reason: '桥面断裂相符', evidence: [{ index: 0, quote: line }] }], sceneCount: 1, candidateCount: 1 })
      if (path.includes('/evidence')) return Promise.resolve({ rows: [{ index: 0, text: line, speaker: 'GM' }] })
      return Promise.resolve({})
    })
    const wrapper = mount(HighlightWorkbench, { props: { meetingId: 'm', profile: 'default', jobId: 'job-1', embedded: true } })
    await flushPromises()

    const analyze = wrapper.findAll('button').find(button => button.text() === 'trpg.highlights.analyze')
    expect(analyze).toBeTruthy()
    await analyze!.trigger('click')
    await flushPromises()

    expect(mocks.writingRequest.mock.calls.some(call => String(call[0]).endsWith('/visual-match') && call[3].image.startsWith('data:image/'))).toBe(true)
    expect(wrapper.get('.hw-vision').text()).toContain('薄雾笼罩断桥')
    await wrapper.findAll('button').find(b => b.text() === 'trpg.harness.useVisual')!.trigger('click'); await flushPromises()
    expect(wrapper.emitted('useForWriting')?.[0]?.[0]).toEqual({ chapter: 0, reference: { id: 'h0', description: '薄雾笼罩断桥', evidence: [{ index: 0, quote: line }] } })
    expect(mocks.writingRequest.mock.calls.filter(call => String(call[0]).endsWith('/visual-match'))).toHaveLength(1)
    wrapper.unmount()
  })
})
