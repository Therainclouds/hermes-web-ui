import { writeFileSync } from 'fs'
import WebSocket, { type RawData } from 'ws'

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * We talk to CDP directly instead of going through the agent-browser CLI: the
 * CLI caps its output and defaults to a 25s operation timeout, which cannot
 * carry a multi-megabyte generated PNG back to the server.
 */

const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
const DEFAULT_CALL_TIMEOUT_MS = 120_000

export interface CdpTargetInfo {
  targetId: string
  type: string
  url: string
  title?: string
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

interface PendingCall {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class CdpConnection {
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  private closed = false

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw: RawData) => this.onMessage(raw))
    ws.on('close', () => this.failAll('CDP connection closed'))
    ws.on('error', (error: Error) => this.failAll(`CDP connection error: ${error.message}`))
  }

  static async open(wsUrl: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl, { maxPayload: MAX_PAYLOAD_BYTES })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new CdpError(`CDP connect timeout after ${timeoutMs}ms`, 'connect'))
      }, timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new CdpError(`CDP connect failed: ${error.message}`, 'connect'))
      })
    })
    return new CdpConnection(ws)
  }

  private onMessage(raw: RawData): void {
    let message: any
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!message || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new CdpError(JSON.stringify(message.error), message.method || 'cdp'))
    } else {
      pending.resolve(message.result)
    }
  }

  private failAll(reason: string): void {
    this.closed = true
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new CdpError(reason, 'connection'))
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new CdpError('CDP connection is closed', method))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError(`CDP timeout: ${method}`, method))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  async listTargets(): Promise<CdpTargetInfo[]> {
    const result = await this.send('Target.getTargets')
    return Array.isArray(result?.targetInfos) ? result.targetInfos : []
  }

  async createTarget(url: string): Promise<string> {
    const result = await this.send('Target.createTarget', { url })
    return String(result.targetId)
  }

  async attach(targetId: string): Promise<string> {
    const result = await this.send('Target.attachToTarget', { targetId, flatten: true })
    return String(result.sessionId)
  }

  close(): void {
    this.failAll('CDP connection closed by caller')
    try {
      this.ws.close()
    } catch {
      // best effort
    }
  }
}

export interface WaitOptions {
  label: string
  timeoutMs: number
  intervalMs?: number
  signal?: AbortSignal
}

/** A single attached page target: evaluate / click / navigate primitives only. */
export class CdpPage {
  constructor(
    private readonly conn: CdpConnection,
    readonly sessionId: string,
  ) {}

  async evaluate<T = unknown>(
    expression: string,
    options: { awaitPromise?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const result = await this.conn.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: true,
      },
      this.sessionId,
      options.timeoutMs,
    )
    if (result?.exceptionDetails) {
      throw new CdpError(`page exception: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`, 'Runtime.evaluate')
    }
    return result?.result?.value as T
  }

  async waitFor(expression: string, options: WaitOptions): Promise<void> {
    const interval = options.intervalMs ?? 1_000
    const deadline = Date.now() + options.timeoutMs
    let last: unknown
    for (;;) {
      if (options.signal?.aborted) throw new CdpError(`aborted while waiting for ${options.label}`, 'waitFor')
      last = await this.evaluate(expression)
      if (last === true || last === 'true') return
      if (Date.now() >= deadline) {
        throw new CdpError(`timeout waiting for ${options.label} (last=${JSON.stringify(last)})`, 'waitFor')
      }
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }

  async navigate(url: string, timeoutMs = 60_000): Promise<void> {
    await this.conn.send('Page.navigate', { url }, this.sessionId, timeoutMs)
    await this.waitFor('document.readyState === "complete"', {
      label: 'page load',
      timeoutMs,
      intervalMs: 500,
    })
  }

  /**
   * Click with real input events. A synthetic element.click() is not enough for
   * ChatGPT's React composer — the same reason `press Enter` does not submit.
   */
  async clickSelector(selector: string, timeoutMs = 30_000): Promise<void> {
    const box = await this.evaluate<string | null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`,
      { timeoutMs },
    )
    if (!box) throw new CdpError(`element not clickable: ${selector}`, 'clickSelector')
    const { x, y } = JSON.parse(box) as { x: number; y: number }
    // A full pointer sequence. React's composer button ignores a press that
    // arrives without a preceding hover, and Chrome needs the `buttons` bitmask
    // for the press/release pair to count as a real click.
    const events: Array<Record<string, unknown>> = [
      { type: 'mouseMoved', x, y, pointerType: 'mouse' },
      { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' },
      { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' },
    ]
    for (const event of events) {
      await this.conn.send('Input.dispatchMouseEvent', event, this.sessionId, timeoutMs)
    }
  }

  /**
   * Attach files to a file input. Chrome refuses scripted `.files` assignment,
   * so the files are handed to the browser through DOM.setFileInputFiles.
   */
  async setFileInputFiles(selector: string, files: string[]): Promise<void> {
    const node = await this.conn.send(
      'Runtime.evaluate',
      { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false },
      this.sessionId,
    )
    const objectId = node?.result?.objectId
    if (!objectId) throw new CdpError(`file input not found: ${selector}`, 'setFileInputFiles')
    await this.conn.send('DOM.setFileInputFiles', { files, objectId }, this.sessionId)
  }

  async screenshot(path: string): Promise<void> {
    const result = await this.conn.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    const data = result?.data
    if (typeof data === 'string' && data) writeFileSync(path, Buffer.from(data, 'base64'))
  }
}
