// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/client', () => ({ request: mocks.request }))
vi.mock('../../packages/client/src/plugins/trpg/image-io', () => ({
  imageDataUri: async () => 'data:image/png;base64,AAAA',
  generatedImageBlob: () => new Blob(),
}))
import { requestImage, describeImageFailure } from '../../packages/client/src/plugins/trpg/imageRequest'
import { defaultImageSettings } from '../../packages/client/src/plugins/trpg/storage'

const webSettings = () => ({ ...defaultImageSettings(), useChatGptWeb: true })
const jsonError = (status: number, code = 'http_error') => Object.assign(new Error(`API Error ${status}`), { status, code })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('ChatGPT web image request', () => {
  it('starts a background job and polls until the image is done', async () => {
    mocks.request
      .mockResolvedValueOnce({ job_id: 'job-1' })
      .mockResolvedValueOnce({ state: 'running', stage: 'waiting_image' })
      .mockResolvedValueOnce({ state: 'done', images: ['BASE64'] })
    const stages: string[] = []
    const promise = requestImage('画一张', [], webSettings(), undefined, progress => stages.push(progress.stage))

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toBe('BASE64')
    expect(stages).toContain('waiting_image')
    // The start call must ask for the async job form.
    expect(mocks.request.mock.calls[0][1].body).toContain('"async":true')
    expect(mocks.request.mock.calls[1][0]).toContain('/chatgpt-web-image/jobs/job-1')
  })

  it('retries a transient poll failure instead of failing while the browser keeps working', async () => {
    mocks.request
      .mockResolvedValueOnce({ job_id: 'job-2' })
      .mockRejectedValueOnce(jsonError(502))
      .mockResolvedValueOnce({ state: 'done', images: ['RETRIED'] })
    const promise = requestImage('画一张', [], webSettings())

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toBe('RETRIED')
  })

  it('fails fast when the job is gone, and maps a server timeout to a retryable code', async () => {
    mocks.request.mockResolvedValueOnce({ job_id: 'job-3' }).mockRejectedValueOnce(jsonError(404, 'chatgpt_web_job_not_found'))
    await expect(requestImage('画一张', [], webSettings())).rejects.toMatchObject({ status: 404 })

    mocks.request.mockReset()
    mocks.request
      .mockResolvedValueOnce({ job_id: 'job-4' })
      .mockResolvedValueOnce({ state: 'failed', error: { code: 'chatgpt_web_timeout', status: 504, message: 'did not start' } })
    await expect(requestImage('画一张', [], webSettings())).rejects.toMatchObject({ code: 'chatgpt_web_timeout' })
  })

  it('keeps the API path synchronous', async () => {
    mocks.request.mockResolvedValueOnce({ images: ['API_IMAGE'] })
    await expect(requestImage('画一张', [], defaultImageSettings())).resolves.toBe('API_IMAGE')
    expect(mocks.request.mock.calls[0][0]).toBe('/api/hermes/media/apikey-image-generate')
    expect(mocks.request.mock.calls[0][1].body).not.toContain('"async":true')
  })
})

describe('describeImageFailure', () => {
  const t = (key: string) => key
  it('gives timeouts their own hint and keeps bridge details verbatim', () => {
    expect(describeImageFailure({ code: 'chatgpt_web_timeout' }, t)).toBe('trpg.chatGptWebTimeout')
    expect(describeImageFailure({ code: 'aborted' }, t)).toBe('')
    expect(describeImageFailure({ code: 'chatgpt_web_needs_human', message: '未登录', detail: '请登录' }, t)).toBe('未登录 — 请登录')
    expect(describeImageFailure(new Error('boom'), t)).toBe('trpg.imageFailed')
  })
})
