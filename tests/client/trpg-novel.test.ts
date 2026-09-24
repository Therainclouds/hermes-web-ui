// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const api = vi.hoisted(() => ({ prepare: vi.fn(), start: vi.fn(), list: vi.fn(), resume: vi.fn(), cancel: vi.fn(), remote: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (s: string) => s }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ resolve: vi.fn() }) }))
vi.mock('@/api/hermes/sessions', () => ({ createSessionServer: api.remote }))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'table' }))
vi.mock('@/api/hermes/meetings', () => ({ listRecaps: vi.fn().mockResolvedValue({ recaps: [] }), prepareRecap: api.prepare, deleteRecap: vi.fn(), listNovelJobs: api.list, startNovelJob: api.start, resumeNovelJob: api.resume, cancelNovelJob: api.cancel }))
import RecapSection from '../../packages/client/src/plugins/trpg/RecapSection.vue'
const job = { id: 'snapshot', status: 'running', stage: 'extracting', chunks: 3, extracted: 1, chapters: 0, planned: 0, scenes: 0, written: 0, reviewed: 0, warnings: [], outputChars: 0, processedSentences: 5, totalSentences: 12 }
const props = { meetingId: 'meeting', sentences: Array.from({ length: 12 }, (_, i) => ({ text: `句${i}`, timestamp: i })), characters: [{ id: 'elf', name: '银月', player: '小林', appearance: '银发', card: 'SECRET' }], setting: '城门', style: '', asrScope: { mode: 'recent' as const, recentCount: 1, segments: [] } }
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers()
  api.list.mockResolvedValue({ jobs: [] }); api.prepare.mockResolvedValue({ requestId: 'snapshot' }); api.start.mockResolvedValue({ job })
})
afterEach(() => vi.useRealTimers())
it('starts long novels with every sentence and public appearance without opening chat', async () => {
  const open = vi.spyOn(window, 'open')
  const wrapper = mount(RecapSection, { props })
  await flushPromises()
  await wrapper.findAll('select')[0].setValue('long_novel')
  await wrapper.get('button.primary').trigger('click'); await flushPromises()
  expect(api.prepare.mock.calls[0][0]).toMatchObject({ mode: 'long_novel', targetChars: 20000, sentences: props.sentences, characters: [{ id: 'elf', name: '银月', player: '小林', appearance: '银发' }] })
  expect(JSON.stringify(api.prepare.mock.calls)).not.toContain('SECRET')
  expect(api.start).toHaveBeenCalledWith('meeting', 'snapshot')
  expect(api.remote).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  expect(wrapper.find('[data-testid="novel-job"]').exists()).toBe(true)
  wrapper.unmount(); open.mockRestore()
  const polls = api.list.mock.calls.length
  await vi.advanceTimersByTimeAsync(15000)
  expect(api.list).toHaveBeenCalledTimes(polls)
})
it('reuses the prepared snapshot after an uncertain start response', async () => {
  api.start.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ job })
  const wrapper = mount(RecapSection, { props }); await flushPromises()
  await wrapper.findAll('select')[0].setValue('long_novel')
  await wrapper.get('button.primary').trigger('click'); await flushPromises()
  await wrapper.get('button.primary').trigger('click'); await flushPromises()
  expect(api.prepare).toHaveBeenCalledTimes(1)
  expect(api.start).toHaveBeenCalledTimes(2)
  wrapper.unmount()
})
it('loads a paused job after remount and resumes from its durable id', async () => {
  api.list.mockResolvedValue({ jobs: [{ ...job, status: 'paused' }] }); api.resume.mockResolvedValue({ job })
  const wrapper = mount(RecapSection, { props }); await flushPromises()
  await wrapper.get('[data-testid="novel-job"] button').trigger('click'); await flushPromises()
  expect(api.resume).toHaveBeenCalledWith('meeting', 'snapshot')
  expect(wrapper.get('[data-testid="novel-job"] strong').text()).toContain('running')
  wrapper.unmount()
})
