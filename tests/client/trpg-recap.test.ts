// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), list: vi.fn(), remote: vi.fn(), push: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (s: string) => s }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push, resolve: (target: any) => ({ href: `#/hermes/session/${target.params.sessionId}` }) }) }))
vi.mock('@/api/hermes/sessions', () => ({ createSessionServer: mocks.remote }))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'table' }))
vi.mock('@/api/hermes/meetings', () => ({ listRecaps: mocks.list, prepareRecap: mocks.prepare, deleteRecap: vi.fn(), listNovelJobs: vi.fn().mockResolvedValue({ jobs: [] }), startNovelJob: vi.fn(), resumeNovelJob: vi.fn(), cancelNovelJob: vi.fn() }))
import RecapSection from '../../packages/client/src/plugins/trpg/RecapSection.vue'

it('opens the recap chat in a new tab and leaves the recording tab on the meeting', async () => {
  mocks.list.mockResolvedValue({ recaps: [] })
  mocks.prepare.mockResolvedValue({ requestId: 'snapshot' })
  mocks.remote.mockResolvedValue({ ok: true, id: 'created', profile: 'table' })
  const tab = { location: { replace: vi.fn() }, close: vi.fn(), opener: {} }
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
  localStorage.clear()
  const wrapper = mount(RecapSection, { props: { meetingId: 'meeting', sentences: [{ text: '举盾' }], characters: [{ id: 'elf', name: '银月', player: '小林', card: 'SECRET', appearance: '', image: new Blob() }], setting: '城门', style: '' } })
  await flushPromises()
  await wrapper.find('button.primary').trigger('click')
  await flushPromises()

  // The tab is reserved synchronously inside the click gesture (popup-safe).
  expect(open).toHaveBeenCalledWith('about:blank', '_blank')
  expect(tab.opener).toBeNull()
  // The server session is created, then the reserved tab is navigated to the chat.
  const payload = mocks.remote.mock.calls[0][0]
  expect(payload).toMatchObject({ source: 'trpg_recap', agent: 'hermes', profile: 'table', title: 'trpg.recap.title' })
  expect(tab.location.replace).toHaveBeenCalledWith(expect.stringContaining(`#/hermes/session/${payload.id}`))
  expect(mocks.remote.mock.invocationCallOrder[0]).toBeLessThan(tab.location.replace.mock.invocationCallOrder[0])
  // The instruction is queued for the new tab, not sent from the recording tab.
  const queued = JSON.parse(localStorage.getItem(`hermes.pending_chat_prompt.${payload.id}`) || 'null')
  expect(queued.content).toContain('trpg-recap')
  expect(queued.content).toContain('snapshot')
  expect(queued.content).toContain('epic')
  expect(queued.content).not.toContain('SECRET')
  expect(JSON.stringify(mocks.prepare.mock.calls)).not.toContain('image')
  expect(JSON.stringify(mocks.prepare.mock.calls)).not.toContain('SECRET')
  // The recording tab itself never routes to the chat.
  expect(mocks.push).not.toHaveBeenCalled()
  open.mockRestore()
  wrapper.unmount()
})

it('links each saved chronicle to the standalone ancient-book page in a new tab', async () => {
  mocks.list.mockResolvedValue({ recaps: [{ id: 'recap-1', title: '城门', mode: 'literary', tone: 'epic', chapters: [], timeline: [] }] })
  const wrapper = mount(RecapSection, { props: { meetingId: 'meeting', sentences: [], characters: [], setting: '', style: '' } })
  await flushPromises()
  const link = wrapper.get('a.recap-open')
  // A separate document, not a Hermes SPA route: /recap-book.html with query params.
  expect(link.attributes('href')).toBe('/recap-book.html?meetingId=meeting&recapId=recap-1')
  expect(link.attributes('target')).toBe('_blank')
  expect(link.attributes('rel')).toContain('noopener')
  wrapper.unmount()
})

it.each(['literary', 'documentary', 'journal'])('uses the shared model for %s chat sessions', async (mode) => {
  mocks.list.mockResolvedValue({ recaps: [] }); mocks.prepare.mockResolvedValue({ requestId: 'snapshot' }); mocks.remote.mockResolvedValue({ ok: true })
  const open = vi.spyOn(window, 'open').mockReturnValue({ location: { replace: vi.fn() }, close: vi.fn(), opener: null } as unknown as Window)
  const writingSettings = { defaultModel: { provider: 'custom', model: 'writer' }, stages: { review: { provider: 'judge', model: 'audit' } } }
  const wrapper = mount(RecapSection, { props: { meetingId: 'meeting', sentences: [{ text: '举盾' }], characters: [], setting: '', style: '', writingSettings } })
  await flushPromises(); await wrapper.find('select').setValue(mode)
  await wrapper.find('button.primary').trigger('click'); await flushPromises()
  expect(mocks.remote.mock.calls.at(-1)?.[0]).toMatchObject({ provider: 'custom', model: 'writer', profile: 'table' })
  expect(mocks.prepare.mock.calls.at(-1)?.[0]).toMatchObject({ mode, writing: writingSettings })
  wrapper.unmount(); open.mockRestore()
})
