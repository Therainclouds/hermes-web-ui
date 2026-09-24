import { CdpConnection, CdpError, CdpPage } from './cdp'
import { probeCdp } from './browser-host'
import { logger } from '../logger'

/**
 * The ChatGPT web flow, verified end to end against chatgpt.com (Chrome 152).
 *
 * Details that are easy to get wrong and were confirmed by hand:
 *  - `press Enter` does NOT submit; the send button must receive a real click.
 *  - Generated images live at `chatgpt.com/backend-api/estuary/content?id=…`,
 *    not at `files.oaiusercontent.com`, and carry alt text starting with
 *    `已生成图片`.
 *  - The composer is a ProseMirror contenteditable (`#prompt-textarea`), so the
 *    text must arrive as real input (`Input.insertText`), not a value assignment.
 *  - The project page composer starts a brand new conversation, which is how we
 *    avoid appending to (and polluting) an earlier thread.
 */

export const CHATGPT_WEB_SELECTORS = {
  composer: '#prompt-textarea',
  sendButton: '[data-testid="send-button"]',
  stopButton: '[data-testid="stop-button"]',
  fileInput: 'input[type="file"][data-testid="upload-photos-input"], input[type="file"][accept*="image"]',
  generatedImage: 'img[alt^="已生成图片"]',
} as const

const GENERATED_IMAGE_ALT_PREFIX = '已生成图片'
export const COMPOSER_WAIT_MS = 60_000
/**
 * Upper bound for the "conversation started" wait. The ChatGPT project composer
 * can take a while to open a new `/c/<id>` thread under load, and the old
 * hard-coded 60s turned a healthy-but-slow generation into a 502. The wait now
 * follows the caller's per-image budget, capped here so a huge timeout cannot
 * leave a request waiting forever when the send silently failed.
 */
export const CONVERSATION_START_MAX_MS = 5 * 60_000
const UPLOAD_SETTLE_MS = 2_500
const NO_IMAGE_GRACE_MS = 25_000

export function conversationStartTimeoutMs(overallTimeoutMs: number): number {
  const budget = Number.isFinite(overallTimeoutMs) && overallTimeoutMs > 0 ? overallTimeoutMs : CONVERSATION_START_MAX_MS
  return Math.max(COMPOSER_WAIT_MS, Math.min(budget, CONVERSATION_START_MAX_MS))
}

/** Stable, locale-free progress keys the UI can translate. */
export const CHATGPT_WEB_STAGES = [
  'opening_project',
  'attaching_references',
  'typing_prompt',
  'sending',
  'waiting_start',
  'waiting_image',
  'downloading_image',
] as const
export type ChatGptWebStage = typeof CHATGPT_WEB_STAGES[number]

export class ChatGptWebNeedsHumanError extends Error {
  readonly code = 'chatgpt_web_needs_human'
  constructor(message: string, readonly detail?: string) {
    super(message)
    this.name = 'ChatGptWebNeedsHumanError'
  }
}

export class ChatGptWebGenerationError extends Error {
  readonly code: string
  constructor(message: string, readonly detail?: string, code = 'chatgpt_web_generation_failed') {
    super(message)
    this.name = 'ChatGptWebGenerationError'
    this.code = code
  }
}

/** A deadline was reached while the browser was still working; retryable, not a hard failure. */
export class ChatGptWebTimeoutError extends ChatGptWebGenerationError {
  constructor(message: string, detail?: string) {
    super(message, detail, 'chatgpt_web_timeout')
    this.name = 'ChatGptWebTimeoutError'
  }
}

export interface GenerationRequest {
  port: number
  projectUrl: string
  prompt: string
  referenceFiles?: string[]
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (stage: ChatGptWebStage) => void
}

export interface GenerationResult {
  imageBase64: string
  bytes: number
  alt: string | null
  width: number | null
  height: number | null
  conversationId: string | null
  durationMs: number
}

export interface PageState {
  path: string
  busy: boolean
  image: { width: number; height: number; alt: string } | null
  tail: string
}

/** Project slug (`/g/g-p-<id>-<name>`) used to find the right tab. */
export function projectSlugFromUrl(url: string): string | null {
  const match = url.match(/\/g\/(g-p-[a-z0-9-]+)/i)
  return match ? match[1].toLowerCase() : null
}

export function conversationIdFromPath(path: string): string | null {
  const match = path.match(/\/c\/([0-9a-f-]{8,})/i)
  return match ? match[1] : null
}

export function parsePageState(raw: unknown): PageState | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return {
      path: typeof parsed.path === 'string' ? parsed.path : '',
      busy: parsed.busy === true,
      image: parsed.image && typeof parsed.image === 'object'
        ? {
            width: Number(parsed.image.width) || 0,
            height: Number(parsed.image.height) || 0,
            alt: String(parsed.image.alt || ''),
          }
        : null,
      tail: typeof parsed.tail === 'string' ? parsed.tail : '',
    }
  } catch {
    return null
  }
}

export function parseSessionProbe(raw: unknown): { loggedIn: boolean; error?: string } {
  if (typeof raw !== 'string') return { loggedIn: false, error: 'empty session probe' }
  if (raw.startsWith('ERR:')) return { loggedIn: false, error: raw.slice(4) }
  try {
    const parsed = JSON.parse(raw)
    return { loggedIn: parsed?.user === true }
  } catch {
    return { loggedIn: false, error: 'unparsable session probe' }
  }
}

const CHALLENGE_PATTERNS = [
  /just a moment/i,
  /verify you are human/i,
  /确认你是真人/,
  /正在验证/,
  /checking your browser/i,
]

export function looksLikeChallenge(title: string, bodyText: string): boolean {
  const haystack = `${title}\n${bodyText}`
  return CHALLENGE_PATTERNS.some(pattern => pattern.test(haystack))
}

const PAGE_STATE_EXPR = `JSON.stringify({
  path: location.pathname,
  busy: !!document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.stopButton)}),
  image: (() => {
    const el = document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.generatedImage)});
    return el ? { width: el.naturalWidth, height: el.naturalHeight, alt: el.alt || '' } : null;
  })(),
  tail: document.body.innerText.slice(-160)
})`

const SESSION_PROBE_EXPR = `fetch('/api/auth/session')
  .then(r => r.json())
  .then(j => JSON.stringify({ user: !!j.user }))
  .catch(e => 'ERR:' + (e && e.message ? e.message : String(e)))`

const READ_IMAGE_EXPR = `(async () => {
  const el = document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.generatedImage)});
  if (!el) return 'ERR:no-image';
  const url = el.currentSrc || el.src;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return 'ERR:http-' + res.status;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return JSON.stringify({ bytes: bytes.length, b64: btoa(binary) });
})()`

export interface DriverDependencies {
  openConnection: (port: number) => Promise<CdpConnection>
}

export class ChatGptWebDriver {
  constructor(private readonly deps: DriverDependencies = { openConnection: defaultOpenConnection }) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now()
    const progress = (stage: ChatGptWebStage) => {
      request.onProgress?.(stage)
      logger.info(`[chatgpt-web] ${stage}`)
    }

    const status = await probeCdp(request.port, 3_000)
    if (!status.reachable || !status.webSocketDebuggerUrl) {
      throw new ChatGptWebGenerationError(`CDP not reachable on port ${request.port}`)
    }

    const conn = await this.deps.openConnection(request.port)
    try {
      const slug = projectSlugFromUrl(request.projectUrl)
      let target = (await conn.listTargets()).find(
        entry => entry.type === 'page' && slug && entry.url.toLowerCase().includes(slug),
      )
      if (!target) {
        const targetId = await conn.createTarget('about:blank')
        target = { targetId, type: 'page', url: 'about:blank' }
      }
      const sessionId = await conn.attach(target.targetId)
      const page = new CdpPage(conn, sessionId)
      await conn.send('Page.enable', {}, sessionId)
      await conn.send('Runtime.enable', {}, sessionId)
      await conn.send('DOM.enable', {}, sessionId)

      progress('opening_project')
      await page.navigate(request.projectUrl)

      // Login / Cloudflare gate: hand control back to the human instead of
      // guessing. The window is on their desktop, so this is actionable.
      const probe = parseSessionProbe(await page.evaluate(SESSION_PROBE_EXPR))
      if (!probe.loggedIn) {
        const title = String(await page.evaluate('document.title').catch(() => ''))
        const body = String(await page.evaluate('document.body.innerText.slice(0, 400)').catch(() => ''))
        const hint = looksLikeChallenge(title, body)
          ? 'Cloudflare 正在验证浏览器，请在那个人工窗口里点一下验证。'
          : '请在打开的 ChatGPT 窗口里完成登录（登录态会长期保留）。'
        throw new ChatGptWebNeedsHumanError(`ChatGPT 未登录或未通过验证：${hint}${probe.error ? ` (${probe.error})` : ''}`)
      }

      try {
        await page.waitFor(`!!document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.composer)})`, {
          label: 'composer',
          timeoutMs: COMPOSER_WAIT_MS,
          signal: request.signal,
        })
      } catch (error) {
        const title = String(await page.evaluate('document.title').catch(() => ''))
        throw new ChatGptWebNeedsHumanError(
          `ChatGPT 输入框未出现（title=${title}），可能停在验证或登录页，请在窗口里处理后重试。`,
        )
      }

      const referenceFiles = request.referenceFiles || []
      if (referenceFiles.length) {
        progress('attaching_references')
        await page.setFileInputFiles(CHATGPT_WEB_SELECTORS.fileInput, referenceFiles)
        await page.waitFor(
          `[...document.querySelectorAll('img')]
             .filter(i => /^blob:/.test(i.currentSrc || i.src || '')).length >= ${referenceFiles.length}`,
          { label: 'reference upload', timeoutMs: 60_000, intervalMs: 1_000, signal: request.signal },
        )
        // Uploads finish shortly after the local preview appears.
        await new Promise(resolve => setTimeout(resolve, UPLOAD_SETTLE_MS))
      }

      progress('typing_prompt')
      await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.composer)});
        el.focus();
        return true;
      })()`)
      await conn.send('Input.insertText', { text: request.prompt }, sessionId)

      const typed = Number(await page.evaluate(`document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.composer)}).innerText.length`))
      if (!Number.isFinite(typed) || typed < 2) {
        throw new ChatGptWebGenerationError('prompt did not land in the composer')
      }

      progress('sending')
      await page.clickSelector(CHATGPT_WEB_SELECTORS.sendButton)

      // "Started" is either the new `/c/<id>` URL or the stop button appearing:
      // under load ChatGPT sometimes begins generating before the address bar
      // changes, and waiting only for the URL used to fail a healthy turn.
      progress('waiting_start')
      const startDeadline = conversationStartTimeoutMs(request.timeoutMs)
      const startedExpr = `(!!location.pathname.match(/\\/c\\/[0-9a-f-]{8,}/i)) || !!document.querySelector(${JSON.stringify(CHATGPT_WEB_SELECTORS.stopButton)})`
      try {
        await page.waitFor(startedExpr, {
          label: 'conversation start',
          timeoutMs: startDeadline,
          intervalMs: 1_000,
          signal: request.signal,
        })
      } catch (error) {
        // A long wait here means the send did not take, NOT that generation
        // failed. Surface it as a retryable timeout instead of a generic 502.
        if (error instanceof CdpError && /timeout waiting/i.test(error.message)) {
          throw new ChatGptWebTimeoutError(
            `ChatGPT did not start a conversation within ${Math.round(startDeadline / 1000)}s of sending the prompt`,
          )
        }
        throw error
      }

      progress('waiting_image')
      const state = await this.waitForImage(page, request)
      const conversationId = conversationIdFromPath(state.path)

      progress('downloading_image')
      const payloadRaw = await page.evaluate(READ_IMAGE_EXPR, { timeoutMs: 180_000 })
      if (typeof payloadRaw !== 'string' || payloadRaw.startsWith('ERR:')) {
        throw new ChatGptWebGenerationError(`could not read the generated image: ${String(payloadRaw)}`)
      }
      const payload = JSON.parse(payloadRaw) as { bytes: number; b64: string }

      return {
        imageBase64: payload.b64,
        bytes: payload.bytes,
        alt: state.image?.alt || null,
        width: state.image?.width || null,
        height: state.image?.height || null,
        conversationId,
        durationMs: Date.now() - started,
      }
    } finally {
      conn.close()
    }
  }

  private async waitForImage(page: CdpPage, request: GenerationRequest): Promise<PageState> {
    const deadline = Date.now() + request.timeoutMs
    let quietSince: number | null = null
    let last: PageState | null = null
    for (;;) {
      if (request.signal?.aborted) throw new ChatGptWebGenerationError('aborted')
      const state = parsePageState(await page.evaluate(PAGE_STATE_EXPR))
      if (state) {
        last = state
        if (!state.busy && state.image) return state
        // Generation ended without an image: the model likely replied in text
        // (refusal, rate limit, or a clarification). Surface its tail.
        if (!state.busy && !state.image) {
          quietSince = quietSince ?? Date.now()
          if (Date.now() - quietSince > NO_IMAGE_GRACE_MS) {
            throw new ChatGptWebGenerationError(
              'ChatGPT finished without producing an image',
              state.tail.slice(-300),
            )
          }
        } else {
          quietSince = null
        }
      }
      if (Date.now() >= deadline) {
        throw new ChatGptWebTimeoutError(
          `timed out after ${Math.round(request.timeoutMs / 1000)}s waiting for the image`,
          last?.tail?.slice(-300),
        )
      }
      await new Promise(resolve => setTimeout(resolve, 4_000))
    }
  }
}

async function defaultOpenConnection(port: number): Promise<CdpConnection> {
  const status = await probeCdp(port, 3_000)
  if (!status.reachable || !status.webSocketDebuggerUrl) {
    throw new CdpError(`CDP not reachable on port ${port}`, 'connect')
  }
  return CdpConnection.open(status.webSocketDebuggerUrl)
}
