import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHATGPT_WEB_PROVIDER,
  ChatGptWebImageError,
  ChatGptWebImageService,
  decodeReferenceImages,
  type ChatGptWebImageDependencies,
} from '../../packages/server/src/services/chatgpt-web-image'
import {
  defaultChromeUserDataDir,
  resolveChatGptWebConfig,
  resolveChromeBinary,
} from '../../packages/server/src/services/chatgpt-web-image/config'
import {
  ChatGptWebBrowserError,
  type EnsureBrowserResult,
} from '../../packages/server/src/services/chatgpt-web-image/browser-host'
import {
  ChatGptWebDriver,
  ChatGptWebGenerationError,
  ChatGptWebNeedsHumanError,
  ChatGptWebTimeoutError,
  COMPOSER_WAIT_MS,
  CONVERSATION_START_MAX_MS,
  conversationIdFromPath,
  conversationStartTimeoutMs,
  looksLikeChallenge,
  parsePageState,
  parseSessionProbe,
  projectSlugFromUrl,
  type GenerationRequest,
  type GenerationResult,
} from '../../packages/server/src/services/chatgpt-web-image/driver'
import { CdpError } from '../../packages/server/src/services/chatgpt-web-image/cdp'

const temporaryDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A real 1x1 PNG so the magic-byte validation is exercised for real.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const pngDataUri = () => `data:image/png;base64,${PNG_1X1}`

function chromeResult(overrides: Partial<EnsureBrowserResult> = {}): EnsureBrowserResult {
  return {
    reachable: true,
    port: 9222,
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
    browserVersion: 'Chrome/152.0.0.0',
    launched: false,
    chromeBin: null,
    seed: null,
    ...overrides,
  }
}

function serviceWithDriver(driver: ChatGptWebDriver, ensure: () => Promise<EnsureBrowserResult> = async () => chromeResult()) {
  const deps: ChatGptWebImageDependencies = {
    ensureBrowser: ensure as unknown as ChatGptWebImageDependencies['ensureBrowser'],
    createDriver: () => driver,
    probeCdp: (async () => ({ reachable: false, port: 9222, webSocketDebuggerUrl: null, browserVersion: null })) as unknown as ChatGptWebImageDependencies['probeCdp'],
    seedProfileFromChrome: (() => ({ seeded: false, sourceProfileDir: null, copied: [] })) as unknown as ChatGptWebImageDependencies['seedProfileFromChrome'],
  }
  return new ChatGptWebImageService(deps)
}

function driverReturning(result: Partial<GenerationResult>, captured?: { requests: GenerationRequest[]; refsExisted?: boolean[] }): ChatGptWebDriver {
  return {
    generate: async (request: GenerationRequest) => {
      captured?.requests.push(request)
      captured?.refsExisted?.push(...(request.referenceFiles || []).map(file => existsSync(file)))
      return {
        imageBase64: PNG_1X1,
        bytes: 68,
        alt: '已生成图片：测试',
        width: 1672,
        height: 941,
        conversationId: 'conv-1',
        durationMs: 1000,
        ...result,
      }
    },
  } as unknown as ChatGptWebDriver
}

function driverThrowing(error: Error): ChatGptWebDriver {
  return { generate: async () => { throw error } } as unknown as ChatGptWebDriver
}

/** Poll a background job until it reaches a terminal state (or the test gives up). */
async function waitForJob(service: ChatGptWebImageService, id: string, profile: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = service.getJob(id, profile)
    if (job.state === 'done' || job.state === 'failed') return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

/** Point the bridge at a clean state dir so host config never leaks into tests. */
function isolateState(): string {
  const home = tempDir('chatgpt-web-home-')
  vi.stubEnv('HERMES_WEB_UI_HOME', home)
  vi.stubEnv('CHATGPT_WEB_PROJECT_URL', 'https://chatgpt.com/g/g-p-test-project/project')
  return home
}

describe('chatgpt-web driver helpers', () => {
  it('extracts the project slug so the right tab is reused', () => {
    expect(projectSlugFromUrl('https://chatgpt.com/g/g-p-6a9ee55cc6448191b4722abc27419eea-dndpao-tuan/project'))
      .toBe('g-p-6a9ee55cc6448191b4722abc27419eea-dndpao-tuan')
    expect(projectSlugFromUrl('https://chatgpt.com/')).toBeNull()
  })

  it('reads the conversation id out of the path', () => {
    expect(conversationIdFromPath('/g/g-p-abc/c/6aa2bf83-1e0c-83e9-800b-1479ad82acd2'))
      .toBe('6aa2bf83-1e0c-83e9-800b-1479ad82acd2')
    expect(conversationIdFromPath('/g/g-p-abc/project')).toBeNull()
  })

  it('parses page state and tolerates junk', () => {
    expect(parsePageState('{"path":"/c/x","busy":true,"image":null,"tail":"hi"}'))
      .toEqual({ path: '/c/x', busy: true, image: null, tail: 'hi' })
    expect(parsePageState(JSON.stringify({ path: '/c/x', busy: false, image: { width: 2, height: 3, alt: 'a' }, tail: '' }))?.image)
      .toEqual({ width: 2, height: 3, alt: 'a' })
    expect(parsePageState('not json')).toBeNull()
    expect(parsePageState(undefined)).toBeNull()
  })

  it('classifies the session probe', () => {
    expect(parseSessionProbe('{"user":true}')).toEqual({ loggedIn: true })
    expect(parseSessionProbe('{"user":false}')).toEqual({ loggedIn: false })
    expect(parseSessionProbe('ERR:boom')).toEqual({ loggedIn: false, error: 'boom' })
    expect(parseSessionProbe('nope').loggedIn).toBe(false)
  })

  it('recognises Cloudflare and login interstitials', () => {
    expect(looksLikeChallenge('Just a moment...', '')).toBe(true)
    expect(looksLikeChallenge('', '确认你是真人后继续')).toBe(true)
    expect(looksLikeChallenge('ChatGPT - DND跑团', '你好')).toBe(false)
  })

  it('lets the conversation-start wait follow the per-image budget, within bounds', () => {
    // A short budget gets the 60s floor; a missing/huge one is capped.
    expect(conversationStartTimeoutMs(30_000)).toBe(COMPOSER_WAIT_MS)
    expect(conversationStartTimeoutMs(0)).toBe(CONVERSATION_START_MAX_MS)
    expect(conversationStartTimeoutMs(300_000)).toBe(300_000)
    expect(conversationStartTimeoutMs(30 * 60_000)).toBe(CONVERSATION_START_MAX_MS)
  })
})

describe('chatgpt-web reference images', () => {
  it('accepts PNG data URIs and reports nothing for an absent field', () => {
    expect(decodeReferenceImages(undefined)).toEqual([])
    const [decoded] = decodeReferenceImages([pngDataUri()])
    expect(decoded.extension).toBe('png')
    expect(decoded.buffer.subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('rejects malformed, oversized and mismatched references', () => {
    const expectCode = (value: unknown) => {
      try {
        decodeReferenceImages(value)
        throw new Error('expected a rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(ChatGptWebImageError)
        expect((error as ChatGptWebImageError).status).toBe(400)
      }
    }
    expectCode('not-an-array')
    expectCode([])
    expectCode(Array.from({ length: 5 }, () => pngDataUri()))
    expectCode(['data:image/png;base64,%%%'])
    // Declared PNG, actual JPEG bytes.
    expectCode([`data:image/png;base64,${Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64')}`])
  })
})

describe('chatgpt-web config resolution', () => {
  it('prefers env over the state file over defaults', () => {
    const home = tempDir('chatgpt-web-cfg-')
    mkdirSync(join(home, 'chatgpt-web'), { recursive: true })
    writeFileSync(join(home, 'chatgpt-web', 'config.json'), JSON.stringify({
      projectUrl: 'https://chatgpt.com/g/g-p-file/project',
      cdpPort: 9333,
      chromeProfileName: 'Profile 2',
    }))

    const fromFile = resolveChatGptWebConfig({ env: { HERMES_WEB_UI_HOME: home } })
    expect(fromFile.projectUrl).toBe('https://chatgpt.com/g/g-p-file/project')
    expect(fromFile.cdpPort).toBe(9333)
    expect(fromFile.chromeProfileName).toBe('Profile 2')

    const fromEnv = resolveChatGptWebConfig({
      env: {
        HERMES_WEB_UI_HOME: home,
        CHATGPT_WEB_PROJECT_URL: 'https://chatgpt.com/g/g-p-env/project',
        CHATGPT_WEB_CDP_PORT: '9444',
        CHATGPT_WEB_TIMEOUT_MS: '60000',
        CHATGPT_WEB_SEED_FROM_CHROME: 'false',
      },
    })
    expect(fromEnv.projectUrl).toBe('https://chatgpt.com/g/g-p-env/project')
    expect(fromEnv.cdpPort).toBe(9444)
    expect(fromEnv.timeoutMs).toBe(60_000)
    expect(fromEnv.seedFromChrome).toBe(false)
  })

  it('ignores a malformed state file instead of failing', () => {
    const home = tempDir('chatgpt-web-bad-')
    mkdirSync(join(home, 'chatgpt-web'), { recursive: true })
    writeFileSync(join(home, 'chatgpt-web', 'config.json'), '{ not json')
    const config = resolveChatGptWebConfig({ env: { HERMES_WEB_UI_HOME: home } })
    expect(config.projectUrl).toBe('')
    expect(config.userDataDir).toBe(join(home, 'chatgpt-web', 'browser-profile'))
  })

  it('resolves the source Chrome profile per platform', () => {
    expect(defaultChromeUserDataDir('linux', '/home/x', {})).toBe('/home/x/.config/google-chrome')
    expect(defaultChromeUserDataDir('darwin', '/Users/x', {})).toBe('/Users/x/Library/Application Support/Google/Chrome')
    expect(defaultChromeUserDataDir('win32', 'C:\\Users\\x', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }))
      .toBe(join('C:\\Users\\x\\AppData\\Local', 'Google', 'Chrome', 'User Data'))
    expect(defaultChromeUserDataDir('linux', '/home/x', { CHATGPT_WEB_CHROME_USER_DATA_DIR: '/custom' })).toBe('/custom')
  })

  it('honours an explicit Chrome path and rejects a missing one', () => {
    const bin = join(tempDir('chatgpt-web-bin-'), 'chrome')
    writeFileSync(bin, '#!/bin/sh\n')
    expect(resolveChromeBinary({ CHATGPT_WEB_CHROME_BIN: bin })).toBe(bin)
    expect(resolveChromeBinary({ CHATGPT_WEB_CHROME_BIN: join(bin, 'nope') })).toBeNull()
  })
})

describe('chatgpt-web image service', () => {
  it('requires a project URL before touching the browser', async () => {
    const home = tempDir('chatgpt-web-nourl-')
    vi.stubEnv('HERMES_WEB_UI_HOME', home)
    vi.stubEnv('CHATGPT_WEB_PROJECT_URL', '')
    const ensure = vi.fn(async () => chromeResult())
    const service = serviceWithDriver(driverReturning({}), ensure)

    await expect(service.generate({ profile: 'default', prompt: '画一张' }))
      .rejects.toMatchObject({ code: 'chatgpt_web_project_url_required', status: 400 })
    expect(ensure).not.toHaveBeenCalled()
  })

  it('returns base64 and forwards references as temp files that are cleaned up', async () => {
    isolateState()
    const captured = { requests: [] as GenerationRequest[], refsExisted: [] as boolean[] }
    const service = serviceWithDriver(driverReturning({}, captured))

    const result = await service.generate({
      profile: 'default',
      prompt: '画一张高光',
      referenceImages: [pngDataUri()],
      returnBase64: true,
    })

    expect(result.provider).toBe(CHATGPT_WEB_PROVIDER)
    expect(result.images).toEqual([PNG_1X1])
    expect(result.outputPaths).toEqual([])
    expect(result.conversationId).toBe('conv-1')

    const request = captured.requests[0]
    expect(request.referenceFiles).toHaveLength(1)
    // The temp file must exist while the driver runs, and be gone afterwards.
    expect(captured.refsExisted).toEqual([true])
    expect(existsSync(request.referenceFiles![0])).toBe(false)
    expect(request.projectUrl).toBe('https://chatgpt.com/g/g-p-test-project/project')
  })

  it('writes a file when base64 is not requested', async () => {
    isolateState()
    const outputPath = join(tempDir('chatgpt-web-out-'), 'nested', 'highlight.png')
    const service = serviceWithDriver(driverReturning({}))

    const result = await service.generate({ profile: 'default', prompt: '画一张', outputPath })

    expect(result.outputPaths).toEqual([outputPath])
    expect(result.images).toEqual([])
    expect(readFileSync(outputPath).subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('maps bridge failures onto actionable HTTP codes', async () => {
    isolateState()
    const cases: Array<[Error, string, number]> = [
      [new ChatGptWebNeedsHumanError('请先登录'), 'chatgpt_web_needs_human', 409],
      [new ChatGptWebBrowserError('找不到 Chrome'), 'chatgpt_web_browser_unavailable', 503],
      [new ChatGptWebGenerationError('timed out after 300s waiting for the image'), 'chatgpt_web_timeout', 504],
      [new ChatGptWebGenerationError('ChatGPT finished without producing an image', '抱歉'), 'chatgpt_web_generation_failed', 502],
    ]
    for (const [error, code, status] of cases) {
      const service = serviceWithDriver(driverThrowing(error))
      await expect(service.generate({ profile: 'default', prompt: '画一张' }))
        .rejects.toMatchObject({ code, status })
    }
  })

  it('serializes generations because there is only one browser tab', async () => {
    isolateState()
    let active = 0
    let maxActive = 0
    const driver = {
      generate: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active -= 1
        return {
          imageBase64: PNG_1X1, bytes: 68, alt: null, width: 1, height: 1,
          conversationId: 'c', durationMs: 1,
        }
      },
    } as unknown as ChatGptWebDriver
    const service = serviceWithDriver(driver)

    await Promise.all([
      service.generate({ profile: 'default', prompt: 'a', returnBase64: true }),
      service.generate({ profile: 'default', prompt: 'b', returnBase64: true }),
      service.generate({ profile: 'default', prompt: 'c', returnBase64: true }),
    ])

    expect(maxActive).toBe(1)
  })

  it('keeps the queue alive after a failure', async () => {
    isolateState()
    let calls = 0
    const driver = {
      generate: async () => {
        calls += 1
        if (calls === 1) throw new ChatGptWebGenerationError('boom')
        return { imageBase64: PNG_1X1, bytes: 68, alt: null, width: 1, height: 1, conversationId: 'c', durationMs: 1 }
      },
    } as unknown as ChatGptWebDriver
    const service = serviceWithDriver(driver)

    await expect(service.generate({ profile: 'default', prompt: 'a' })).rejects.toBeInstanceOf(ChatGptWebImageError)
    await expect(service.generate({ profile: 'default', prompt: 'b', returnBase64: true })).resolves.toMatchObject({ images: [PNG_1X1] })
  })

  it('maps a CDP conversation-start timeout to a retryable 504, not a generic 502', async () => {
    isolateState()
    const service = serviceWithDriver(driverThrowing(
      new CdpError('timeout waiting for conversation start (last=false)', 'waitFor'),
    ))
    await expect(service.generate({ profile: 'default', prompt: 'x' }))
      .rejects.toMatchObject({ code: 'chatgpt_web_timeout', status: 504 })
  })

  it('returns a job id immediately and exposes the finished image to its owner', async () => {
    isolateState()
    const service = serviceWithDriver(driverReturning({}))
    const jobId = service.startJob({ profile: 'default', prompt: '画一张', returnBase64: true })

    // The call must not wait for the browser: a fresh job is queued or running.
    expect(['queued', 'running']).toContain(service.getJob(jobId, 'default').state)

    const job = await waitForJob(service, jobId, 'default')
    expect(job.state).toBe('done')
    expect(job.images).toEqual([PNG_1X1])
    expect(job.durationMs).toBe(1000)
    expect(job.conversationId).toBe('conv-1')
    // Another profile must not be able to read the job.
    try {
      service.getJob(jobId, 'other')
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ChatGptWebImageError)
      expect((error as ChatGptWebImageError).code).toBe('chatgpt_web_job_not_found')
      expect((error as ChatGptWebImageError).status).toBe(404)
    }
  })

  it('records a failed job with the mapped error instead of throwing at start', async () => {
    isolateState()
    const service = serviceWithDriver(driverThrowing(new ChatGptWebTimeoutError('ChatGPT did not start a conversation')))
    const jobId = service.startJob({ profile: 'default', prompt: '画一张', returnBase64: true })
    const job = await waitForJob(service, jobId, 'default')
    expect(job.state).toBe('failed')
    // A timeout is retryable, so the job reports 504 rather than a hard 502.
    expect(job.error).toMatchObject({ code: 'chatgpt_web_timeout', status: 504 })
    expect(job.images).toBeUndefined()
  })

  it('rejects a job id that does not belong to any job', () => {
    isolateState()
    const service = serviceWithDriver(driverReturning({}))
    expect(() => service.getJob('missing', 'default')).toThrow(ChatGptWebImageError)
  })
})
