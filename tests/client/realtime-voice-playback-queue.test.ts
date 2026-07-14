// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  store: null as any,
  requests: [] as Array<{
    text: string
    resolve: (value: { audio: Blob; engine: string; provider: string }) => void
  }>,
  activeRequests: 0,
  maxActiveRequests: 0,
  audioInstances: [] as MockAudio[],
  recognitionStopResult: '',
  browserRecognition: null as any,
  recorder: null as any,
  sttSettingsResponse: { providers: [], activeProvider: 'browser' } as any,
  transcribeSpeech: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/hermes/chat', async () => {
  const { reactive } = await import('vue')
  testState.store = reactive({
    activeSessionId: 'voice-session',
    activeSession: { id: 'voice-session', title: 'Voice', agent: 'codex', messages: [] },
    messages: [] as any[],
    isStreaming: true,
    isSessionLive: () => false,
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
  })
  return { useChatStore: () => testState.store }
})

vi.mock('@/composables/useBrowserSpeechRecognition', async () => {
  const { ref } = await import('vue')
  return {
    useBrowserSpeechRecognition: () => (testState.browserRecognition = {
      transcript: ref(''),
      partialTranscript: ref(''),
      error: ref<Error | null>(null),
      errorCode: ref<string | null>(null),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(async () => testState.recognitionStopResult),
      cancel: vi.fn(),
      clearError: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useMicRecorder', async () => {
  const { ref, shallowRef } = await import('vue')
  return {
    useMicRecorder: () => (testState.recorder = {
      state: ref({ status: 'idle', error: null, startedAt: null, mimeType: null }),
      stream: shallowRef(null),
      start: vi.fn().mockImplementation(async () => {
        testState.recorder.state.value = { status: 'recording', error: null, startedAt: Date.now(), mimeType: 'audio/webm' }
      }),
      stop: vi.fn().mockImplementation(async () => {
        testState.recorder.state.value = { status: 'idle', error: null, startedAt: null, mimeType: null }
        return new Blob(['fallback audio'], { type: 'audio/webm' })
      }),
      cancel: vi.fn().mockImplementation(() => {
        testState.recorder.state.value = { status: 'idle', error: null, startedAt: null, mimeType: null }
      }),
    }),
  }
})

vi.mock('@/api/hermes/stt-settings', () => ({
  fetchSttSettings: vi.fn(async () => testState.sttSettingsResponse),
}))

vi.mock('@/api/hermes/stt', () => ({
  transcribeSpeech: testState.transcribeSpeech,
}))

vi.mock('@/composables/useSttSettings', async () => {
  const { ref } = await import('vue')
  return {
    useSttSettings: () => ({
      openaiLanguage: ref('zh-CN'),
      customLanguage: ref(''),
    }),
  }
})

vi.mock('@/composables/useVoiceSettings', async () => {
  const { ref } = await import('vue')
  return {
    useVoiceSettings: () => ({
      provider: ref('edge'),
      webspeechVoice: ref(''),
      openaiApiKey: ref(''),
      openaiBaseUrl: ref(''),
      openaiModel: ref('tts-1'),
      openaiVoice: ref('alloy'),
      customUrl: ref(''),
      customApiKey: ref(''),
      edgeUrl: ref(''),
      edgeVoice: ref('zh-CN-XiaoxiaoNeural'),
      edgeRate: ref(1),
      edgePitchHz: ref(0),
      mimoApiKey: ref(''),
      mimoAuthMode: ref('bearer'),
      mimoBaseUrl: ref(''),
      mimoModel: ref('mimo-v2.5-tts'),
      mimoVoice: ref(''),
      mimoVoiceDesignDesc: ref(''),
      mimoVoiceCloneDataUri: ref(''),
      mimoVoiceCloneFormat: ref('wav'),
      mimoStylePrompt: ref(''),
      doubaoBaseUrl: ref(''),
      doubaoModel: ref(''),
      doubaoVoice: ref(''),
      doubaoStylePrompt: ref(''),
    }),
  }
})

vi.mock('@/composables/useSpeech', async () => {
  const { ref } = await import('vue')
  return {
    useGlobalSpeech: () => ({
      isPlaying: ref(false),
      isCustomPlaying: ref(false),
      isSupported: ref(false),
      stop: vi.fn(),
      extractReadableText: (text: string) => text,
      speakViaBrowser: vi.fn(),
    }),
  }
})

vi.mock('@/api/hermes/tts', () => ({
  synthesizeSpeech: vi.fn(({ text }: { text: string }) => {
    testState.activeRequests += 1
    testState.maxActiveRequests = Math.max(testState.maxActiveRequests, testState.activeRequests)
    return new Promise((resolve) => {
      testState.requests.push({
        text,
        resolve: (value) => {
          testState.activeRequests -= 1
          resolve(value)
        },
      })
    })
  }),
}))

class MockAudio {
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()

  constructor(src = '') {
    this.src = src
    testState.audioInstances.push(this)
  }
}

import RealtimeVoiceStage from '@/components/hermes/chat/RealtimeVoiceStage.vue'

async function settle() {
  await nextTick()
  await flushPromises()
  await nextTick()
}

function resolveRequest(index: number) {
  testState.requests[index].resolve({
    audio: new Blob([testState.requests[index].text], { type: 'audio/mpeg' }),
    engine: 'edge',
    provider: 'edge',
  })
}

describe('RealtimeVoiceStage prepared playback queue', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    testState.requests = []
    testState.activeRequests = 0
    testState.maxActiveRequests = 0
    testState.audioInstances = []
    testState.recognitionStopResult = ''
    testState.browserRecognition = null
    testState.recorder = null
    testState.sttSettingsResponse = { providers: [], activeProvider: 'browser' }
    testState.transcribeSpeech.mockReset()
    testState.transcribeSpeech.mockResolvedValue({
      text: '备用识别文本',
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      durationMs: 10,
    })
    vi.stubGlobal('Audio', MockAudio)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => `blob:voice-${blob.size}-${Math.random()}`),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('prepares at most five segments concurrently but always plays and captions FIFO', async () => {
    const wrapper = mount(RealtimeVoiceStage)
    expect(wrapper.find('.voice-stage__controls').exists()).toBe(false)
    expect(wrapper.find('.voice-stage__back').exists()).toBe(true)
    expect(wrapper.get('.voice-stage__identity span').text()).toBe('Codex')
    testState.store.messages.push({
      id: 'assistant-stream',
      role: 'assistant',
      content: '第一句。第二句。第三句。第四句。第五句。第六句。',
      timestamp: Date.now(),
      isStreaming: true,
    })
    await settle()

    expect(testState.requests.map(request => request.text)).toEqual([
      '第一句。',
      '第二句。',
      '第三句。',
      '第四句。',
      '第五句。',
    ])
    expect(testState.maxActiveRequests).toBe(5)

    resolveRequest(4)
    await settle()
    expect(testState.requests[5].text).toBe('第六句。')
    expect(testState.maxActiveRequests).toBe(5)
    expect(testState.audioInstances).toHaveLength(0)

    resolveRequest(1)
    resolveRequest(0)
    await settle()

    expect(testState.audioInstances).toHaveLength(1)
    expect(wrapper.get('[data-testid="realtime-voice-caption"]').text()).toBe('第一句。')

    testState.audioInstances[0].onended?.()
    await settle()

    expect(testState.audioInstances).toHaveLength(2)
    expect(wrapper.get('[data-testid="realtime-voice-caption"]').text()).toBe('第二句。')

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()
    expect(testState.store.stopStreaming).toHaveBeenCalledTimes(1)
    expect(testState.audioInstances[1].pause).toHaveBeenCalledTimes(1)
    expect(wrapper.classes()).toContain('voice-stage--idle')
    wrapper.unmount()
  })

  it('stops the active model turn when the animation is clicked while thinking', async () => {
    const wrapper = mount(RealtimeVoiceStage)
    testState.recognitionStopResult = '执行一个任务'

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.store.sendMessage).toHaveBeenCalledWith('执行一个任务')
    expect(wrapper.classes()).toContain('voice-stage--thinking')

    for (let index = 1; index <= 5; index += 1) {
      testState.store.messages.push({
        id: `tool-${index}`,
        role: 'tool',
        content: '',
        toolName: `tool-${index}`,
        toolStatus: index === 5 ? 'running' : 'done',
        timestamp: Date.now() + index,
      })
    }
    await settle()
    expect(wrapper.findAll('.voice-stage__tool strong').map(node => node.text())).toEqual([
      'tool-5',
      'tool-4',
      'tool-3',
      'tool-2',
    ])

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.store.stopStreaming).toHaveBeenCalledTimes(1)
    expect(wrapper.classes()).toContain('voice-stage--idle')
    wrapper.unmount()
  })

  it.each(['openai', 'custom', 'doubao'] as const)(
    'keeps PC browser capture and falls back to the active %s STT provider on network errors',
    async (provider) => {
    testState.sttSettingsResponse = {
      activeProvider: provider,
      providers: [{
        provider,
        settings: { language: 'zh-CN', prompt: '中英混合' },
        secrets: { apiKey: '[stored]' },
        updatedAt: Date.now(),
      }],
    }
    const wrapper = mount(RealtimeVoiceStage)

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()
    expect(testState.recorder.start).toHaveBeenCalledTimes(1)
    expect(testState.browserRecognition.start).toHaveBeenCalledWith({
      language: 'zh-CN',
      continuous: true,
    })

    testState.browserRecognition.errorCode.value = 'network'
    testState.browserRecognition.error.value = new Error('network')
    await settle()

    expect(testState.transcribeSpeech).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      language: 'zh-CN',
      prompt: '中英混合',
    }))
    expect(testState.store.sendMessage).toHaveBeenCalledWith('备用识别文本')
    wrapper.unmount()
    },
  )

  it('uses explicit manual backend recording on mobile even when desktop-site mode hides the mobile UA', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
      maxTouchPoints: 5,
    })
    vi.stubGlobal('screen', { width: 430, height: 932 })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    testState.sttSettingsResponse = {
      activeProvider: 'openai',
      providers: [{
        provider: 'openai',
        settings: { language: 'zh-CN', prompt: '中英混合' },
        secrets: { apiKey: '[stored]' },
        updatedAt: Date.now(),
      }],
    }
    const wrapper = mount(RealtimeVoiceStage)

    await vi.advanceTimersByTimeAsync(180)
    await settle()

    expect(wrapper.classes()).toContain('voice-stage--idle')
    expect(testState.recorder.start).not.toHaveBeenCalled()
    expect(testState.browserRecognition.start).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(wrapper.classes()).toContain('voice-stage--listening')
    expect(wrapper.get('[data-testid="realtime-voice-caption"]').text()).toBe('realtimeVoice.hint.listeningManual')
    expect(testState.recorder.start).toHaveBeenCalledTimes(1)
    expect(testState.browserRecognition.start).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.transcribeSpeech).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      language: 'zh-CN',
      prompt: '中英混合',
    }))
    expect(testState.store.sendMessage).toHaveBeenCalledWith('备用识别文本')
    wrapper.unmount()
  })

  it('keeps restart-based browser capture on mobile when no backend STT is configured', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36',
      maxTouchPoints: 5,
    })
    vi.stubGlobal('screen', { width: 430, height: 932 })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const wrapper = mount(RealtimeVoiceStage)

    await vi.advanceTimersByTimeAsync(180)
    await settle()

    expect(testState.browserRecognition.start).toHaveBeenCalledWith({
      language: 'zh-CN',
      continuous: false,
    })

    testState.recognitionStopResult = '移动端问题'
    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.store.sendMessage).toHaveBeenCalledWith('移动端问题')
    expect(testState.browserRecognition.start).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('shows a direct network error when the active STT setting has no backend fallback', async () => {
    const wrapper = mount(RealtimeVoiceStage)

    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()
    expect(testState.recorder.start).not.toHaveBeenCalled()
    expect(testState.browserRecognition.start).toHaveBeenCalledWith({
      language: 'zh-CN',
      continuous: true,
    })
    testState.browserRecognition.errorCode.value = 'network'
    testState.browserRecognition.error.value = new Error('network')
    await settle()

    expect(testState.transcribeSpeech).not.toHaveBeenCalled()
    expect(wrapper.classes()).toContain('voice-stage--error')
    expect(wrapper.get('[data-testid="realtime-voice-caption"]').text()).toBe('realtimeVoice.networkUnavailableNoFallback')
    wrapper.unmount()
  })

  it('restarts PC browser capture when no speech is detected', async () => {
    vi.useFakeTimers()
    const wrapper = mount(RealtimeVoiceStage)

    await vi.advanceTimersByTimeAsync(180)
    await settle()

    expect(testState.browserRecognition.start).toHaveBeenCalledTimes(1)
    expect(wrapper.classes()).toContain('voice-stage--listening')

    testState.browserRecognition.errorCode.value = 'no-speech'
    testState.browserRecognition.error.value = new Error('Browser speech recognition failed: no-speech.')
    await settle()

    expect(testState.browserRecognition.clearError).toHaveBeenCalled()
    expect(testState.transcribeSpeech).not.toHaveBeenCalled()
    expect(testState.recorder.cancel).not.toHaveBeenCalled()
    expect(wrapper.classes()).toContain('voice-stage--listening')
    expect(wrapper.classes()).not.toContain('voice-stage--error')

    await vi.advanceTimersByTimeAsync(420)
    await settle()

    expect(testState.browserRecognition.start).toHaveBeenCalledTimes(2)
    expect(wrapper.classes()).toContain('voice-stage--listening')
    wrapper.unmount()
  })

  it('keeps microphone capture stopped while the assistant response is playing', async () => {
    vi.useFakeTimers()
    testState.store.isStreaming = true
    const wrapper = mount(RealtimeVoiceStage)

    await vi.advanceTimersByTimeAsync(180)
    await settle()

    testState.recognitionStopResult = '第一个问题'
    await wrapper.get('[data-testid="realtime-voice-toggle"]').trigger('click')
    await settle()

    expect(testState.store.sendMessage).toHaveBeenCalledWith('第一个问题')
    expect(testState.browserRecognition.stop).toHaveBeenCalledTimes(1)
    expect(testState.browserRecognition.start).toHaveBeenCalledTimes(1)

    testState.store.messages.push({
      id: 'assistant-no-capture',
      role: 'assistant',
      content: '这是正在播放的回答。',
      timestamp: Date.now(),
      isStreaming: true,
    })
    await settle()
    resolveRequest(0)
    await settle()

    expect(wrapper.classes()).toContain('voice-stage--speaking')
    testState.browserRecognition.partialTranscript.value = '这是正在播放的回答'
    await settle()

    expect(testState.store.stopStreaming).not.toHaveBeenCalled()
    expect(testState.browserRecognition.start).toHaveBeenCalledTimes(1)

    testState.audioInstances[0].onended?.()
    testState.store.isStreaming = false
    await settle()
    await vi.advanceTimersByTimeAsync(420)
    await settle()

    expect(testState.browserRecognition.start).toHaveBeenCalledTimes(2)
    expect(wrapper.classes()).toContain('voice-stage--listening')
    testState.store.isStreaming = true
    wrapper.unmount()
  })

})
