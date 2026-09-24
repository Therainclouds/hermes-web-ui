import { request } from '@/api/client'
import { imageDataUri } from './image-io'
import type { ImageSettings } from './storage'

/** One named portrait attached to an image request so the model can keep a face consistent. */
export interface ImageReference { name: string; blob: Blob }

/** Progress tick while the ChatGPT web bridge drives the browser. */
export interface ImageProgress { stage: string; elapsedMs: number }

/**
 * The web flow is asynchronous: the server returns a job id immediately and the
 * browser keeps generating even if this client is slow. Polling is what makes a
 * multi-minute generation reliable instead of a 502.
 */
const WEB_JOB_POLL_MS = 3_000
/**
 * Client-side ceiling, intentionally above the server's per-image budget so a
 * server-side timeout is reported with its own message rather than masked by
 * the client giving up first.
 */
const WEB_JOB_BUDGET_MS = 15 * 60 * 1000
const WEB_JOB_TIMEOUT_MS = 5 * 60 * 1000

interface WebJobSnapshot {
  state?: 'queued' | 'running' | 'done' | 'failed'
  stage?: string | null
  images?: string[]
  error?: { code?: string; message?: string; status?: number; detail?: string }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { code: 'aborted' })
    if (signal?.aborted) { reject(aborted()); return }
    const onAbort = () => { clearTimeout(timer); reject(aborted()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Send one prompt to the configured image backend.
 *
 * Both TRPG flows (scene highlights and chronicle illustrations) go through
 * here so provider selection, reference handling and the ChatGPT-web bridge
 * behave identically. Reference portraits are downscaled to data URIs first;
 * the API path returns base64. At most four portraits are attached because
 * every backend under test rejects more, so the caller's intent stays honest.
 */
export async function requestImage(
  prompt: string,
  references: ImageReference[],
  options: ImageSettings,
  signal?: AbortSignal,
  onProgress?: (progress: ImageProgress) => void,
): Promise<string> {
  if (references.length > 4) throw new Error('tooManyReferences')
  const images = await Promise.all(references.map(reference => imageDataUri(reference.blob)))
  const referenceMap = references.map((reference, index) => `参考图 ${index + 1} 对应 【${reference.name}】，只借鉴外观，不照搬原图姿势和场景。`).join('\n')
  const fullPrompt = [prompt, referenceMap].filter(Boolean).join('\n\n')
  if (options.useChatGptWeb) return requestChatGptWebImage(fullPrompt, images, options, signal, onProgress)
  const response = await request<{ images: string[] }>('/api/hermes/media/apikey-image-generate', {
    method: 'POST', signal, body: JSON.stringify({
      mode: images.length ? 'edit' : 'text', prompt: fullPrompt,
      provider: options.provider || undefined, model: options.model || undefined, size: options.size, quality: options.quality,
      n: 1, return_base64: true, reference_images: images.length ? images : undefined, timeout_ms: 180000,
    }),
  })
  const image = response.images?.[0]
  if (!image) throw new Error('imageFailed')
  return image
}

/**
 * Start the ChatGPT web generation, then poll its job until it finishes.
 *
 * A transient poll failure is retried rather than surfaced as an error: the
 * browser and the server-side job keep working, so a dropped request should
 * only cost one polling interval.
 */
async function requestChatGptWebImage(
  prompt: string,
  referenceImages: string[],
  options: ImageSettings,
  signal?: AbortSignal,
  onProgress?: (progress: ImageProgress) => void,
): Promise<string> {
  const startedAt = Date.now()
  const start = await request<{ job_id?: string }>('/api/hermes/media/chatgpt-web-image', {
    method: 'POST', signal, body: JSON.stringify({
      prompt, project_url: options.chatGptWebProjectUrl.trim() || undefined,
      n: 1, return_base64: true, reference_images: referenceImages.length ? referenceImages : undefined,
      timeout_ms: WEB_JOB_TIMEOUT_MS, async: true,
    }),
  })
  const jobId = start?.job_id
  if (!jobId) throw Object.assign(new Error('imageFailed'), { code: 'chatgpt_web_failed' })
  const deadline = startedAt + WEB_JOB_BUDGET_MS
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' })
    let job: WebJobSnapshot | null = null
    try {
      job = await request<WebJobSnapshot>(`/api/hermes/media/chatgpt-web-image/jobs/${encodeURIComponent(jobId)}`, { signal })
    } catch (error) {
      const status = (error as { status?: number }).status
      // A lost job (server restart / expiry) or an auth problem cannot heal; a
      // transient network/proxy error can, so keep polling for those.
      if (status === 404 || status === 401 || status === 403) throw error
    }
    if (job) {
      onProgress?.({ stage: job.stage || job.state || 'running', elapsedMs: Date.now() - startedAt })
      if (job.state === 'done') {
        const image = job.images?.[0]
        if (image) return image
        throw Object.assign(new Error('imageFailed'), { code: 'chatgpt_web_generation_failed' })
      }
      if (job.state === 'failed') {
        throw Object.assign(new Error(job.error?.message || 'imageFailed'), {
          code: job.error?.code || 'chatgpt_web_failed',
          ...(job.error?.detail ? { detail: job.error.detail } : {}),
          ...(job.error?.status ? { status: job.error.status } : {}),
        })
      }
    }
    if (Date.now() >= deadline) throw Object.assign(new Error('imageFailed'), { code: 'chatgpt_web_timeout' })
    await sleep(WEB_JOB_POLL_MS, signal)
  }
}

/**
 * Turn an image-generation failure into user-facing text.
 *
 * Browser-bridge failures carry actionable server text and must reach the user
 * verbatim; a timeout gets a dedicated hint because the browser may still be
 * working, and everything else collapses to the localized "generation failed".
 */
export function describeImageFailure(error: unknown, t: (key: string) => string): string {
  const err = error as { code?: string; message?: string; detail?: string }
  if ((err?.message || '') === 'tooManyReferences') return t('trpg.tooManyReferences')
  if (err?.code === 'aborted') return ''
  if (err?.code === 'chatgpt_web_timeout') return t('trpg.chatGptWebTimeout')
  if (typeof err?.code === 'string' && err.code.startsWith('chatgpt_web_')) {
    return [err.message, err.detail].filter(Boolean).join(' — ')
  }
  return t('trpg.imageFailed')
}
