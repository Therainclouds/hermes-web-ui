import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { logger } from '../logger'
import { defaultImageOutputPath } from '../hermes/media-output-paths'
import { CdpError } from './cdp'
import {
  ChatGptWebBrowserError,
  ensureBrowser,
  probeCdp,
  seedProfileFromChrome,
  type BrowserStatus,
} from './browser-host'
import {
  ChatGptWebDriver,
  ChatGptWebGenerationError,
  ChatGptWebNeedsHumanError,
  ChatGptWebTimeoutError,
  type ChatGptWebStage,
} from './driver'
import { chatGptWebStateDir, resolveChatGptWebConfig } from './config'

export const CHATGPT_WEB_PROVIDER = 'chatgpt-web'

const MAX_REFERENCE_IMAGES = 4
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024
const MAX_REFERENCE_TOTAL_BYTES = 10 * 1024 * 1024
/** How long a finished job stays retrievable so a slow client can still collect it. */
export const JOB_RETENTION_MS = 60 * 60 * 1000
export const MAX_JOBS = 30
const REFERENCE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export interface ChatGptWebImageRequest {
  profile: string
  prompt: string
  /** Data URIs, same contract as the existing `edit` mode of the media API. */
  referenceImages?: string[]
  /** Overrides the configured project URL (the TRPG model field carries it). */
  projectUrl?: string
  timeoutMs?: number
  outputPath?: string
  returnBase64?: boolean
  signal?: AbortSignal
}

export interface ChatGptWebImageResult {
  images: string[]
  outputPaths: string[]
  provider: typeof CHATGPT_WEB_PROVIDER
  conversationId: string | null
  durationMs: number
  bytes: number
  width: number | null
  height: number | null
  alt: string | null
}

export type ChatGptWebJobState = 'queued' | 'running' | 'done' | 'failed'

export interface ChatGptWebJobError {
  code: string
  message: string
  status: number
  detail?: string
}

/**
 * Client-facing view of an async generation.
 *
 * The web flow takes 1.5–3 minutes and the browser keeps working even if the
 * caller disconnects, so the HTTP request only starts the job. The client polls
 * this snapshot; a slow generation therefore never turns into a 502 and a
 * completed image stays collectable for {@link JOB_RETENTION_MS}.
 */
export interface ChatGptWebJobSnapshot {
  id: string
  state: ChatGptWebJobState
  stage: ChatGptWebStage | null
  createdAt: number
  updatedAt: number
  durationMs: number
  images?: string[]
  outputPaths?: string[]
  conversationId?: string | null
  width?: number | null
  height?: number | null
  alt?: string | null
  error?: ChatGptWebJobError
}

interface JobRecord {
  id: string
  profile: string
  state: ChatGptWebJobState
  stage: ChatGptWebStage | null
  createdAt: number
  updatedAt: number
  returnBase64: boolean
  result?: ChatGptWebImageResult
  error?: ChatGptWebImageError
}

export class ChatGptWebImageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'ChatGptWebImageError'
  }
}

interface DecodedReference {
  dataUri: string
  mime: string
  extension: string
  buffer: Buffer
}

export function decodeReferenceImages(referenceImages: unknown): DecodedReference[] {
  if (referenceImages === undefined || referenceImages === null) return []
  if (!Array.isArray(referenceImages)) {
    throw new ChatGptWebImageError('reference_images must be an array of data URIs', 'invalid_reference_images', 400)
  }
  if (referenceImages.length < 1 || referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new ChatGptWebImageError(
      `Use 1 to ${MAX_REFERENCE_IMAGES} reference images`,
      'invalid_reference_images',
      400,
    )
  }
  let total = 0
  const decoded = referenceImages.map((value, index) => {
    const uri = String(value || '')
    const match = uri.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
    if (!match) {
      throw new ChatGptWebImageError(
        'Reference images must be PNG, JPEG or WebP data URIs',
        'invalid_reference_images',
        400,
      )
    }
    const buffer = Buffer.from(match[2], 'base64')
    if (!buffer.byteLength || buffer.byteLength > MAX_REFERENCE_BYTES) {
      throw new ChatGptWebImageError('Each reference image must be at most 5 MB', 'invalid_reference_images', 400)
    }
    total += buffer.byteLength
    if (total > MAX_REFERENCE_TOTAL_BYTES) {
      throw new ChatGptWebImageError('Reference images exceed the 10 MB total limit', 'invalid_reference_images', 400)
    }
    // Magic-byte check: the declared mime must match the actual bytes.
    const magic = buffer.subarray(0, 4).toString('hex')
    const isPng = magic.startsWith('89504e47')
    const isJpeg = magic.startsWith('ffd8ff')
    const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    const mimeOk = (match[1] === 'image/png' && isPng)
      || (match[1] === 'image/jpeg' && isJpeg)
      || (match[1] === 'image/webp' && isWebp)
    if (!mimeOk) {
      throw new ChatGptWebImageError('Reference image content does not match its mime type', 'invalid_reference_images', 400)
    }
    return { dataUri: uri, mime: match[1], extension: REFERENCE_MIME_EXTENSIONS[match[1]], buffer }
  })
  return decoded
}

export interface ChatGptWebStatus {
  provider: typeof CHATGPT_WEB_PROVIDER
  projectUrl: string
  cdpPort: number
  userDataDir: string
  chromeBin: string | null
  browser: BrowserStatus
  seedSource: string | null
}

export interface ChatGptWebImageDependencies {
  ensureBrowser: typeof ensureBrowser
  createDriver: () => ChatGptWebDriver
  probeCdp: typeof probeCdp
  seedProfileFromChrome: typeof seedProfileFromChrome
}

const defaultDependencies: ChatGptWebImageDependencies = {
  ensureBrowser,
  createDriver: () => new ChatGptWebDriver(),
  probeCdp,
  seedProfileFromChrome,
}

export class ChatGptWebImageService {
  private static instance: ChatGptWebImageService | null = null
  /** One browser, one conversation at a time: generations are serialized. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Recent async jobs, kept so a polling client can still collect a slow result. */
  private readonly jobs = new Map<string, JobRecord>()

  constructor(private readonly deps: ChatGptWebImageDependencies = defaultDependencies) {}

  static getInstance(): ChatGptWebImageService {
    if (!ChatGptWebImageService.instance) {
      ChatGptWebImageService.instance = new ChatGptWebImageService()
    }
    return ChatGptWebImageService.instance
  }

  async status(): Promise<ChatGptWebStatus> {
    const config = resolveChatGptWebConfig()
    return {
      provider: CHATGPT_WEB_PROVIDER,
      projectUrl: config.projectUrl,
      cdpPort: config.cdpPort,
      userDataDir: config.userDataDir,
      chromeBin: config.chromeBin,
      browser: await this.deps.probeCdp(config.cdpPort),
      seedSource: config.chromeUserDataDir,
    }
  }

  async generate(request: ChatGptWebImageRequest): Promise<ChatGptWebImageResult> {
    return this.enqueue(() => this.runGenerate(request))
  }

  /**
   * Start a generation in the background and return immediately.
   *
   * The caller's abort signal is deliberately dropped: the browser window keeps
   * generating after a slow client gives up, so the job must outlive the HTTP
   * request and stay collectable through {@link getJob}.
   */
  startJob(request: ChatGptWebImageRequest): string {
    const id = randomUUID()
    const now = Date.now()
    const record: JobRecord = {
      id,
      profile: request.profile,
      state: 'queued',
      stage: null,
      createdAt: now,
      updatedAt: now,
      returnBase64: request.returnBase64 === true,
    }
    this.jobs.set(id, record)
    this.pruneJobs()
    void this.enqueue(async () => {
      record.state = 'running'
      record.updatedAt = Date.now()
      try {
        record.result = await this.runGenerate({ ...request, signal: undefined }, stage => {
          record.stage = stage
          record.updatedAt = Date.now()
        })
        record.state = 'done'
      } catch (error) {
        record.error = this.mapError(error)
        record.state = 'failed'
      } finally {
        record.stage = null
        record.updatedAt = Date.now()
      }
    })
    return id
  }

  /** Read one job, scoped to the profile that started it. */
  getJob(id: string, profile: string): ChatGptWebJobSnapshot {
    const record = this.jobs.get(id)
    // A job owned by another profile is reported as missing, not forbidden, so
    // job ids are not an existence oracle across profiles.
    if (!record || record.profile !== profile) {
      throw new ChatGptWebImageError(
        'ChatGPT web job not found; it may have expired or the server restarted',
        'chatgpt_web_job_not_found',
        404,
      )
    }
    return this.snapshot(record)
  }

  private snapshot(record: JobRecord): ChatGptWebJobSnapshot {
    const base: ChatGptWebJobSnapshot = {
      id: record.id,
      state: record.state,
      stage: record.stage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      durationMs: record.result?.durationMs ?? Math.max(0, record.updatedAt - record.createdAt),
    }
    if (record.result) {
      return {
        ...base,
        ...(record.returnBase64 ? { images: record.result.images } : { outputPaths: record.result.outputPaths }),
        conversationId: record.result.conversationId,
        width: record.result.width,
        height: record.result.height,
        alt: record.result.alt,
      }
    }
    if (record.error) {
      return {
        ...base,
        error: {
          code: record.error.code,
          message: record.error.message,
          status: record.error.status,
          ...(record.error.detail ? { detail: record.error.detail } : {}),
        },
      }
    }
    return base
  }

  private pruneJobs(now = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (now - job.updatedAt > JOB_RETENTION_MS) this.jobs.delete(id)
    }
    if (this.jobs.size <= MAX_JOBS) return
    const oldest = [...this.jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    for (const job of oldest.slice(0, this.jobs.size - MAX_JOBS)) this.jobs.delete(job.id)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    // Keep the chain alive after a rejection so one failure does not wedge the queue.
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async runGenerate(
    request: ChatGptWebImageRequest,
    onProgress?: (stage: ChatGptWebStage) => void,
  ): Promise<ChatGptWebImageResult> {
    const prompt = String(request.prompt || '').trim()
    if (!prompt) throw new ChatGptWebImageError('prompt is required', 'prompt_required', 400)

    const config = resolveChatGptWebConfig({ projectUrl: request.projectUrl, timeoutMs: request.timeoutMs })
    if (!config.projectUrl) {
      throw new ChatGptWebImageError(
        'No ChatGPT project URL configured. Set CHATGPT_WEB_PROJECT_URL, add it to '
        + 'chatgpt-web/config.json in the Web UI state dir, or put the project URL in the TRPG model field.',
        'chatgpt_web_project_url_required',
        400,
      )
    }

    const references = decodeReferenceImages(request.referenceImages)

    let referenceDir: string | null = null
    try {
      let referenceFiles: string[] = []
      if (references.length) {
        const base = join(chatGptWebStateDir(), 'tmp')
        mkdirSync(base, { recursive: true })
        referenceDir = mkdtempSync(join(base, 'refs-'))
        referenceFiles = references.map((reference, index) => {
          const file = join(referenceDir as string, `reference-${index + 1}.${reference.extension}`)
          writeFileSync(file, reference.buffer)
          return file
        })
      }

      const browser = await this.deps.ensureBrowser({ config, initialUrl: config.projectUrl })
      const driver = this.deps.createDriver()
      const result = await driver.generate({
        port: browser.port,
        projectUrl: config.projectUrl,
        prompt,
        referenceFiles,
        timeoutMs: config.timeoutMs,
        signal: request.signal,
        onProgress: stage => {
          logger.info(`[chatgpt-web] ${request.profile}: ${stage}`)
          onProgress?.(stage)
        },
      })

      logger.info(
        `[chatgpt-web] generated ${result.bytes} bytes in ${Math.round(result.durationMs / 1000)}s `
        + `(conversation=${result.conversationId || 'unknown'}, refs=${referenceFiles.length})`,
      )

      if (request.returnBase64) {
        return {
          images: [result.imageBase64],
          outputPaths: [],
          provider: CHATGPT_WEB_PROVIDER,
          conversationId: result.conversationId,
          durationMs: result.durationMs,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          alt: result.alt,
        }
      }

      const outputPath = request.outputPath && request.outputPath.trim()
        ? request.outputPath.trim()
        : defaultImageOutputPath(`chatgpt_web_${Date.now()}`)
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, Buffer.from(result.imageBase64, 'base64'))
      return {
        images: [],
        outputPaths: [outputPath],
        provider: CHATGPT_WEB_PROVIDER,
        conversationId: result.conversationId,
        durationMs: result.durationMs,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        alt: result.alt,
      }
    } catch (error) {
      throw this.mapError(error)
    } finally {
      if (referenceDir) {
        try {
          rmSync(referenceDir, { recursive: true, force: true })
        } catch {
          // best effort cleanup
        }
      }
    }
  }

  private mapError(error: unknown): ChatGptWebImageError {
    if (error instanceof ChatGptWebImageError) return error
    if (error instanceof ChatGptWebNeedsHumanError) {
      return new ChatGptWebImageError(error.message, error.code, 409, error.detail)
    }
    if (error instanceof ChatGptWebBrowserError) {
      return new ChatGptWebImageError(error.message, error.code, 503)
    }
    // Timeout first: ChatGptWebTimeoutError extends the generation error and
    // must map to a retryable 504, not the generic 502.
    if (error instanceof ChatGptWebTimeoutError) {
      return new ChatGptWebImageError(error.message, 'chatgpt_web_timeout', 504, error.detail)
    }
    if (error instanceof ChatGptWebGenerationError) {
      const timeout = error.code === 'chatgpt_web_timeout' || /timeout|timed out/i.test(error.message)
      return new ChatGptWebImageError(
        error.message,
        timeout ? 'chatgpt_web_timeout' : error.code,
        timeout ? 504 : 502,
        error.detail,
      )
    }
    // A CDP wait/connection deadline is a transient environment problem, not a
    // generation failure; the caller can safely retry.
    if (error instanceof CdpError) {
      const timeout = /timeout|timed out|aborted/i.test(error.message)
      return new ChatGptWebImageError(
        error.message,
        timeout ? 'chatgpt_web_timeout' : 'chatgpt_web_failed',
        timeout ? 504 : 502,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    return new ChatGptWebImageError(message, 'chatgpt_web_failed', 502)
  }
}

export { resolveChatGptWebConfig, chatGptWebStateDir } from './config'
export type { ChatGptWebConfig } from './config'
