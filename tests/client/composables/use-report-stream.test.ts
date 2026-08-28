// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => `i18n:${key}` }),
}))

import { useReportStream } from '@/composables/useReportStream'

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= frames.length) return { done: true, value: undefined }
          return { done: false, value: encoder.encode(frames[i++]) }
        },
      }),
    },
  }
}

function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function setup() {
  const onReportGenerated = vi.fn()
  const stream = useReportStream({
    getSessionId: () => 'session-1',
    getSceneTemplate: () => 'general',
    resolveProfile: () => 'default',
    onReportGenerated,
  })
  return { onReportGenerated, ...stream }
}

describe('useReportStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('accumulates { text } frames into reportMarkdown and emits the final markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame({ text: '# 报告\n' }),
      frame({ text: '正文' }),
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, reportMarkdown, isGeneratingReport, reportError, onReportGenerated } = setup()
    await generateReport('transcript')

    expect(reportMarkdown.value).toBe('# 报告\n正文')
    expect(reportError.value).toBeNull()
    expect(onReportGenerated).toHaveBeenCalledWith('# 报告\n正文')
    expect(isGeneratingReport.value).toBe(false)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      sessionId: 'session-1',
      sceneTemplate: 'general',
      transcript: 'transcript',
      profile: 'default',
    })
    vi.unstubAllGlobals()
  })

  it('discards accumulated content when the { fallback: true } frame arrives', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame({ text: 'agent 半截产出' }),
      frame({ fallback: true }),
      frame({ text: 'LLM 完整报告' }),
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, reportMarkdown, onReportGenerated } = setup()
    await generateReport('transcript')

    expect(reportMarkdown.value).toBe('LLM 完整报告')
    expect(onReportGenerated).toHaveBeenCalledWith('LLM 完整报告')
    vi.unstubAllGlobals()
  })

  it('stops consuming frames after [DONE] (later frames are ignored)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame({ text: 'first' }),
      'data: [DONE]\n\n',
      frame({ text: 'SHOULD NOT APPEAR' }),
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, reportMarkdown } = setup()
    await generateReport('transcript')

    expect(reportMarkdown.value).toBe('first')
    vi.unstubAllGlobals()
  })

  it('classifies { error } frames into a localized reportError and skips onReportGenerated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame({ error: { message: 'Provider returned an empty stream with no finish_reason', type: 'provider_error' } }),
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, reportError, onReportGenerated } = setup()
    await generateReport('transcript')

    expect(reportError.value).toBe('i18n:meeting.reportPanel.errorLLMStreamInterrupted')
    expect(onReportGenerated).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('throws an HTTP error for non-OK responses (classified as well)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, reportError } = setup()
    await generateReport('transcript')

    expect(reportError.value).toBe('i18n:meeting.reportPanel.errorLLMNetwork')
    vi.unstubAllGlobals()
  })

  it('ignores a second generate call while one is in flight', async () => {
    let releaseReader: (() => void) | null = null
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => {
      releaseReader = () => resolve(sseResponse([
        frame({ text: 'slow' }),
        'data: [DONE]\n\n',
      ]))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, reportMarkdown } = setup()
    const first = generateReport('first')
    // 第一次仍在进行中：isGeneratingReport 已置位，第二次调用必须被吞掉。
    const second = generateReport('second')
    releaseReader!()
    await first
    await second

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reportMarkdown.value).toBe('slow')
    vi.unstubAllGlobals()
  })

  it('retryReport reuses the last transcript', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce(sseResponse([frame({ text: 'retried' }), 'data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)

    const { generateReport, retryReport, reportMarkdown, reportError } = setup()
    await generateReport('original transcript')
    expect(reportError.value).not.toBeNull()

    // retryReport 内部是 fire-and-forget，等待流结束后的状态。
    await retryReport()
    await vi.waitFor(() => expect(reportMarkdown.value).toBe('retried'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).transcript).toBe('original transcript')
    expect(reportError.value).toBeNull()
    vi.unstubAllGlobals()
  })
})
