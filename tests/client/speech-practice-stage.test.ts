// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ omni: null as any, options: null as any, save: vi.fn(), analysis: vi.fn() }))
vi.mock('@/composables/useOmniRealtime', () => ({ useOmniRealtime: (options: any) => { state.options = options; return state.omni } }))
vi.mock('@/stores/hermes/chat', () => ({ uid: () => 'test-id', useChatStore: () => ({ sessions: [], activeSessionId: null }) }))
vi.mock('@/stores/hermes/meeting', () => ({ useMeetingStore: () => ({ asrConfig: {} }) }))
vi.mock('@/stores/hermes/realtime-model', () => ({ useRealtimeModelStore: () => ({ config: {}, limits: { audioTurns: 80 } }) }))
vi.mock('@/api/hermes/omni-tools', () => ({ executeOmniTool: vi.fn(), OMNI_REALTIME_TOOLS: [] }))
vi.mock('@/api/hermes/skills', () => ({ fetchPracticeSkills: vi.fn() }))
vi.mock('@/api/hermes/practice-report', () => ({ savePracticeReport: state.save, streamOmniPracticeAnalysis: state.analysis }))
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: () => '/report.md' }))
vi.mock('@/utils/meeting-asr-api', () => ({ meetingASRApi: { getStatus: async () => ({ isRunning: true }) } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/hermes/chat/OmniVisualizer.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({ default: { props: ['content'], template: '<div>{{ content }}</div>' } }))
import Stage from '@/components/hermes/chat/SpeechPracticeStage.vue'
const score = { overall: 7, fluency: 7, pronunciation: 7, grammar: 7, vocabulary: 7, content: 7, comment: 'Clear answer', strengths: '“It depends on the context” is precise.', improvements: '“He go” needs subject agreement.', example: 'He goes.' }
function mountStage() {
  return mount(Stage, { props: { hasDashscopeKey: true, config: { language: 'en', direction: '', difficulty: 'intermediate' } }, global: { stubs: { NSelect: true, NSwitch: true, NAlert: true } } })
}
beforeEach(() => {
  vi.clearAllMocks()
  state.save.mockResolvedValue({ ok: true, path: '/report.md', fileName: 'report.md' })
  state.omni = {
    phase: ref('ready'), turns: ref([{ role: 'user', text: 'It depends on the context. He go.', id: 'u1' }]), toolCalls: ref([]),
    liveAssistantText: ref(''), liveUserText: ref(''), errorMessage: ref(''),
    inputLevel: ref(0), outputLevel: ref(0), isOutputPlaying: ref(false), isPushing: ref(true),
    connect: vi.fn().mockResolvedValue(undefined), prearmPlayback: vi.fn(), setMicStreaming: vi.fn(), setTools: vi.fn(), disconnect: vi.fn(),
    drainOutput: vi.fn().mockResolvedValue(undefined), askText: vi.fn(), sendImage: vi.fn(),
  }
})
describe('practice tool-driven UI and closing review', () => {
  it('shows expressions and replaces repeat feedback for the same user turn', async () => {
    const wrapper = mountStage()
    await state.options.onToolCall('submit_practice_feedback', JSON.stringify(score))
    await flushPromises()
    expect(wrapper.get('[data-testid="speech-practice-latest-feedback"]').text()).toContain(score.strengths)
    expect(wrapper.text()).toContain(score.improvements)
    await state.options.onToolCall('submit_practice_feedback', JSON.stringify({ ...score, overall: 8 }))
    await flushPromises()
    expect(wrapper.find('.practice-stage__scores-count').text()).toBe('1')
    expect(wrapper.text()).toContain('8/10')
    wrapper.unmount()
  })
  it('saves the same-session function-call assessment without offline re-analysis', async () => {
    const wrapper = mountStage()
    state.omni.askText.mockImplementation(async () => {
      await state.options.onToolCall('submit_practice_feedback', JSON.stringify({ ...score, round: 0, reportMarkdown: '## Session review\nActual speech evidence and next steps.' }))
      return 'A short closing summary.'
    })
    await wrapper.get('[data-testid="speech-practice-end"]').trigger('click')
    await flushPromises()
    expect(state.save).toHaveBeenCalled()
    expect(state.save.mock.calls[0]![0]).toContain('Actual speech evidence')
    expect(state.analysis).not.toHaveBeenCalled()
    expect(state.omni.disconnect).toHaveBeenCalled()
    wrapper.unmount()
  })
  it('retries a failed report save without re-running the paid offline analysis', async () => {
    const wrapper = mountStage()
    state.save.mockRejectedValueOnce({ ok: false, error: 'disk full' })
    state.omni.askText.mockImplementation(async () => {
      await state.options.onToolCall('submit_practice_feedback', JSON.stringify({ ...score, round: 0, reportMarkdown: '## Session review\nActual speech evidence and next steps.' }))
      return 'A short closing summary.'
    })
    await wrapper.get('[data-testid="speech-practice-end"]').trigger('click')
    await flushPromises()
    // First write fails: the review is already complete (same-session function
    // call), so no offline Omni request may have happened.
    expect(state.analysis).not.toHaveBeenCalled()
    expect(state.save).toHaveBeenCalledTimes(1)
    // Retry button is available after the failed save…
    expect(wrapper.find('[data-testid="speech-practice-save-report"]').exists()).toBe(true)
    await wrapper.get('[data-testid="speech-practice-save-report"]').trigger('click')
    await flushPromises()
    // …and the retry reuses the completed review instead of re-charging analysis.
    expect(state.analysis).not.toHaveBeenCalled()
    expect(state.save).toHaveBeenCalledTimes(2)
    expect(state.save.mock.calls[1]![0]).toContain('Actual speech evidence')
    wrapper.unmount()
  })
})

describe('camera lifecycle on slower devices', () => {
  it('stops a late permission result without connecting after the stage is closed', async () => {
    state.omni.phase.value = 'idle'
    let grant: (stream: unknown) => void = () => {}
    const stop = vi.fn()
    const getUserMedia = vi.fn(() => new Promise(resolve => { grant = resolve }))
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const wrapper = mountStage()
    wrapper.getComponent('[data-testid="speech-practice-camera"]').vm.$emit('update:value', true)
    await flushPromises()
    await wrapper.get('[data-testid="speech-practice-start"]').trigger('click')
    await flushPromises()
    expect(getUserMedia).toHaveBeenCalledOnce()
    wrapper.unmount()
    grant({ getTracks: () => [{ stop }] })
    await flushPromises()
    expect(stop).toHaveBeenCalledOnce()
    expect(state.omni.connect).not.toHaveBeenCalled()
  })

  it('retries unsupported camera constraints without stopping audio practice', async () => {
    state.omni.phase.value = 'idle'
    const stop = vi.fn()
    const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException('unsupported', 'OverconstrainedError'))
      .mockResolvedValueOnce({ getTracks: () => [{ stop }] })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const wrapper = mountStage()
    wrapper.getComponent('[data-testid="speech-practice-camera"]').vm.$emit('update:value', true)
    await flushPromises()
    await wrapper.get('[data-testid="speech-practice-start"]').trigger('click')
    await flushPromises()
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: true, audio: false })
    expect(state.omni.connect).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })
})
