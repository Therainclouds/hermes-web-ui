// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => `i18n:${key}` }),
}))

const startFileTranscription = vi.fn()
const getFileTranscriptionStatus = vi.fn()

vi.mock('@/utils/meeting-asr-api', () => ({
  meetingASRApi: {
    startFileTranscription: (...args: unknown[]) => startFileTranscription(...args),
    getFileTranscriptionStatus: (...args: unknown[]) => getFileTranscriptionStatus(...args),
  },
}))

import { useFileTranscription } from '@/composables/useFileTranscription'

const RESULT = {
  engine: 'minimax',
  diarize: true,
  duration_sec: 12,
  sample_rate: 16000,
  sentences: [{ text: '你好', begin_ms: 0, end_ms: 1000, speaker_id: 1, sentence_id: 0 }],
  speakers: [1],
  text: '你好',
  warnings: [],
}

function withSetup<T>(composable: () => T): { result: T; unmount: () => void } {
  let result!: T
  const wrapper = mount(defineComponent({
    setup() {
      result = composable()
      return () => null
    },
  }))
  return { result, unmount: () => wrapper.unmount() }
}

describe('useFileTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('uploads, polls and hands the finished result to onComplete', async () => {
    startFileTranscription.mockResolvedValue({ job_id: 'job-1', status: 'pending' })
    getFileTranscriptionStatus.mockResolvedValue({
      job_id: 'job-1', status: 'done', progress: 1, message: 'done',
      engine: 'minimax', diarize: true, error: null, result: RESULT,
    })
    const onComplete = vi.fn()
    const { result } = withSetup(() => useFileTranscription({ onComplete }))

    const file = new File(['audio'], 'meeting.webm', { type: 'audio/webm' })
    const ok = await result.transcribe(file, { engine: 'minimax', diarize: true, sessionId: 's1' })

    expect(ok).toBe(true)
    expect(startFileTranscription).toHaveBeenCalledWith(file, expect.objectContaining({ engine: 'minimax', diarize: true }))
    expect(onComplete).toHaveBeenCalledWith(RESULT, expect.objectContaining({ diarize: true }))
    expect(result.isTranscribing.value).toBe(false)
    expect(result.progress.value).toBe(1)
  })

  it('keeps polling while the job is still running', async () => {
    startFileTranscription.mockResolvedValue({ job_id: 'job-2', status: 'pending' })
    getFileTranscriptionStatus
      .mockResolvedValueOnce({ job_id: 'job-2', status: 'running', progress: 0.4, message: 'transcribing', result: null, error: null })
      .mockResolvedValueOnce({ job_id: 'job-2', status: 'done', progress: 1, message: 'done', result: RESULT, error: null })
    const onComplete = vi.fn()
    const { result } = withSetup(() => useFileTranscription({ onComplete }))

    const ok = await result.transcribe(new File(['x'], 'a.wav'), { engine: 'minimax' })

    expect(ok).toBe(true)
    expect(getFileTranscriptionStatus).toHaveBeenCalledTimes(2)
    expect(result.progress.value).toBe(1)
  })

  it('reports backend failures through onError', async () => {
    startFileTranscription.mockResolvedValue({ job_id: 'job-3', status: 'pending' })
    getFileTranscriptionStatus.mockResolvedValue({
      job_id: 'job-3', status: 'error', progress: 0.2, message: 'error',
      result: null, error: 'ffmpeg not found',
    })
    const onError = vi.fn()
    const { result } = withSetup(() => useFileTranscription({ onComplete: vi.fn(), onError }))

    const ok = await result.transcribe(new File(['x'], 'a.wav'), { engine: 'qwen' })

    expect(ok).toBe(false)
    expect(onError).toHaveBeenCalledWith('ffmpeg not found')
    expect(result.errorMessage.value).toBe('ffmpeg not found')
    expect(result.isTranscribing.value).toBe(false)
  })

  it('surfaces a rejected upload as an error without polling', async () => {
    startFileTranscription.mockRejectedValue(new Error('transcribe start failed: 413 too large'))
    const onError = vi.fn()
    const { result } = withSetup(() => useFileTranscription({ onComplete: vi.fn(), onError }))

    const ok = await result.transcribe(new File(['x'], 'a.wav'), { engine: 'minimax' })

    expect(ok).toBe(false)
    expect(getFileTranscriptionStatus).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('413'))
  })
})
