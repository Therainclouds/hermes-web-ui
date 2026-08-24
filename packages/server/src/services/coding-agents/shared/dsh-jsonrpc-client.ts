import { randomUUID } from 'crypto'
import type { ChildProcess } from 'child_process'

/**
 * A client-side notification frame pushed by the DeepSeek Harness SDK runtime
 * over its newline-delimited JSON-RPC stdio transport.
 */
export interface DshJsonRpcNotification {
  method: string
  params: Record<string, unknown>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Minimal newline-delimited JSON-RPC 2.0 client for a `dsh-jsonrpc-agent`
 * child process. It correlates request ids and surfaces server notifications
 * through {@link onNotification}. Malformed lines are ignored, mirroring the
 * SDK transport's tolerance for non-JSON noise on stdout.
 */
export class DshJsonRpcClient {
  private buffer = ''
  private readonly pending = new Map<string, PendingRequest>()
  private notificationHandler: ((notification: DshJsonRpcNotification) => void) | undefined
  private closed = false

  constructor(
    private readonly child: ChildProcess,
    private readonly onClose?: (error: Error | null) => void,
  ) {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.drain()
    })
    child.stdout?.on('end', () => {
      this.settle(new Error('dsh-jsonrpc-agent closed its stdout'))
      this.onClose?.(null)
    })
    child.on('error', (err) => {
      this.settle(err)
      this.onClose?.(err)
    })
    child.on('exit', (code) => {
      if (!this.closed) {
        this.settle(new Error(`dsh-jsonrpc-agent exited with code ${code ?? 'unknown'}`))
        this.onClose?.(null)
      }
    })
  }

  /** Install the server-notification handler. */
  onNotification(handler: (notification: DshJsonRpcNotification) => void): void {
    this.notificationHandler = handler
  }

  /** Whether the transport has already closed or failed. */
  isClosed(): boolean {
    return this.closed
  }

  /** Send a request and await its JSON-RPC `result`. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('dsh-jsonrpc-agent connection is closed'))
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const payload = { jsonrpc: '2.0', id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.child.stdin?.write(`${JSON.stringify(payload)}\n`)
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private drain(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') return
      frame = parsed as Record<string, unknown>
    } catch {
      return
    }
    const id = frame.id
    const method = frame.method
    if (typeof id === 'string' && typeof method === 'string') {
      // Inbound requests are unused by the SDK runtime; drop them without a response.
      return
    }
    if (typeof id === 'string') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (frame.error && typeof frame.error === 'object') {
        const error = frame.error as Record<string, unknown>
        pending.reject(new Error(typeof error.message === 'string' ? error.message : 'dsh-jsonrpc-agent request failed'))
      } else {
        pending.resolve(frame.result)
      }
      return
    }
    if (typeof method === 'string') {
      const params = frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
        ? frame.params as Record<string, unknown>
        : {}
      this.notificationHandler?.({ method, params })
    }
  }

  private settle(error: Error): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}
