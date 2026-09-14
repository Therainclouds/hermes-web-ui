import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * HTTP mapping for the ChatGPT web image route: status codes, response shape
 * and the error codes the TRPG panel switches on. The browser work itself is
 * mocked here and covered by chatgpt-web-image.test.ts + the opt-in live test.
 */

const generate = vi.fn()
const status = vi.fn()
const startJob = vi.fn()
const getJob = vi.fn()

vi.mock('../../packages/server/src/services/chatgpt-web-image', () => ({
  CHATGPT_WEB_PROVIDER: 'chatgpt-web',
  ChatGptWebImageService: class {
    static getInstance() { return { generate, status, startJob, getJob } }
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
  listProfileNamesFromDisk: () => ['default'],
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  userCanAccessProfile: () => true,
}))

function fakeContext(body: Record<string, unknown>) {
  return {
    request: { body },
    state: { profile: { name: 'default' } },
    query: {},
    get: () => '',
    status: 200,
    body: undefined as any,
  } as any
}

afterEach(() => {
  generate.mockReset()
  status.mockReset()
  startJob.mockReset()
  getJob.mockReset()
})

describe('chatgpt-web image controller', () => {
  it('returns base64 images for the TRPG panel contract', async () => {
    generate.mockResolvedValue({
      images: ['AAAA'],
      outputPaths: [],
      provider: 'chatgpt-web',
      conversationId: 'conv-1',
      durationMs: 1000,
      bytes: 3,
      width: 1672,
      height: 941,
      alt: '已生成图片：x',
    })
    const { chatGptWebImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({ prompt: '画一张', return_base64: true, project_url: 'https://chatgpt.com/g/g-p-x/project' })

    await chatGptWebImageGenerate(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      ok: true,
      mode: 'chatgpt-web',
      provider: 'chatgpt-web',
      profile: 'default',
      conversation_id: 'conv-1',
      images: ['AAAA'],
    })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'default',
      prompt: '画一张',
      projectUrl: 'https://chatgpt.com/g/g-p-x/project',
      returnBase64: true,
    }))
  })

  it('returns output paths when base64 was not requested', async () => {
    generate.mockResolvedValue({
      images: [], outputPaths: ['/home/state/media/chatgpt_web_1.png'], provider: 'chatgpt-web',
      conversationId: null, durationMs: 10, bytes: 1, width: null, height: null, alt: null,
    })
    const { chatGptWebImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({ prompt: '画一张' })

    await chatGptWebImageGenerate(ctx)

    expect(ctx.body.output_paths).toEqual(['/home/state/media/chatgpt_web_1.png'])
    expect(ctx.body.images).toBeUndefined()
  })

  it('rejects n > 1 because the web UI returns one image per turn', async () => {
    const { chatGptWebImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({ prompt: '画两张', n: 2 })

    await chatGptWebImageGenerate(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.code).toBe('chatgpt_web_n_unsupported')
    expect(generate).not.toHaveBeenCalled()
  })

  it('passes bridge error codes and details through to the client', async () => {
    const error = Object.assign(new Error('请先登录'), {
      code: 'chatgpt_web_needs_human',
      status: 409,
      detail: 'detail-text',
    })
    generate.mockRejectedValue(error)
    const { chatGptWebImageGenerate } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({ prompt: '画一张' })

    await chatGptWebImageGenerate(ctx)

    expect(ctx.status).toBe(409)
    expect(ctx.body).toMatchObject({ error: '请先登录', code: 'chatgpt_web_needs_human', detail: 'detail-text' })
  })

  it('reports browser bridge status', async () => {
    status.mockResolvedValue({
      provider: 'chatgpt-web', projectUrl: 'https://chatgpt.com/g/g-p-x/project', cdpPort: 9222,
      userDataDir: '/home/state/chatgpt-web/browser-profile', chromeBin: '/usr/bin/google-chrome',
      browser: { reachable: true, port: 9222, webSocketDebuggerUrl: 'ws://x', browserVersion: 'Chrome/152' },
      seedSource: '/home/.config/google-chrome',
    })
    const { chatGptWebImageStatus } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({})

    await chatGptWebImageStatus(ctx)

    expect(ctx.body).toMatchObject({ ok: true, provider: 'chatgpt-web', browser: { reachable: true } })
  })

  it('starts an async job with 202 and polls its snapshot', async () => {
    startJob.mockReturnValue('job-1')
    getJob.mockReturnValue({
      id: 'job-1', state: 'done', stage: null, createdAt: 1, updatedAt: 2, durationMs: 3,
      images: ['AAAA'], conversationId: 'conv-1', width: 100, height: 50, alt: null,
    })
    const { chatGptWebImageGenerate, chatGptWebImageJobStatus } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({ prompt: '画一张', return_base64: true, async: true })

    await chatGptWebImageGenerate(ctx)

    expect(ctx.status).toBe(202)
    expect(ctx.body).toMatchObject({ ok: true, async: true, job_id: 'job-1', state: 'queued' })
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ profile: 'default', prompt: '画一张', returnBase64: true }))
    // The synchronous generate path must not run when a job was requested.
    expect(generate).not.toHaveBeenCalled()

    const pollCtx = fakeContext({})
    pollCtx.params = { jobId: 'job-1' }
    await chatGptWebImageJobStatus(pollCtx)
    expect(pollCtx.body).toMatchObject({ ok: true, id: 'job-1', state: 'done', images: ['AAAA'] })
    expect(getJob).toHaveBeenCalledWith('job-1', 'default')
  })

  it('maps an unknown job id to 404', async () => {
    getJob.mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'chatgpt_web_job_not_found', status: 404 }) })
    const { chatGptWebImageJobStatus } = await import('../../packages/server/src/controllers/hermes/media')
    const ctx = fakeContext({})
    ctx.params = { jobId: 'missing' }

    await chatGptWebImageJobStatus(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body.code).toBe('chatgpt_web_job_not_found')
  })
})
