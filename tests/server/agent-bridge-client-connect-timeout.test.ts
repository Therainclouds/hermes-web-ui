import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeSocket extends EventEmitter {
  destroyed = false
  destroy(): this {
    this.destroyed = true
    return this
  }
  write(): boolean {
    return true
  }
  end(): this {
    return this
  }
}

const hoisted = vi.hoisted(() => ({
  fakeSocket: null as FakeSocket | null,
}))

vi.mock('net', async importOriginal => {
  const actual = await importOriginal<typeof import('net')>()
  return {
    ...actual,
    createConnection: vi.fn(() => {
      hoisted.fakeSocket = new FakeSocket()
      return hoisted.fakeSocket
    }),
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  hoisted.fakeSocket = null
})

describe('AgentBridgeClient connect timeout', () => {
  it('fails with bridge_unreachable when the broker accept backlog hangs the connect', async () => {
    vi.useFakeTimers()
    const { AgentBridgeClient } = await import(
      '../../packages/server/src/services/hermes/agent-bridge/client'
    )
    const client = new AgentBridgeClient({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      connectRetryMs: 5000,
      timeoutMs: 100,
    })

    // The Unix socket connect never fires 'connect' or 'error' (broker
    // backlog full) — the request must still fail within the budget.
    const pending = client.ping()
    const assertion = expect(pending).rejects.toMatchObject({
      errorType: 'bridge_unreachable',
    })
    await vi.advanceTimersByTimeAsync(300)
    await assertion

    expect(hoisted.fakeSocket?.destroyed).toBe(true)
  })

  it('bounds the total request by timeoutMs even when the connect succeeds slowly', async () => {
    vi.useFakeTimers()
    const { AgentBridgeClient } = await import(
      '../../packages/server/src/services/hermes/agent-bridge/client'
    )
    const client = new AgentBridgeClient({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      connectRetryMs: 5000,
      timeoutMs: 200,
    })

    const pending = client.ping()
    const assertion = expect(pending).rejects.toMatchObject({
      errorType: 'bridge_unreachable',
    })
    // No 'connect' emitted yet: the single-connect budget is consumed by
    // the request deadline and must give up on its own.
    await vi.advanceTimersByTimeAsync(400)
    await assertion
  })

  it('still completes normally when connect succeeds', async () => {
    vi.useFakeTimers()
    const { AgentBridgeClient } = await import(
      '../../packages/server/src/services/hermes/agent-bridge/client'
    )
    const client = new AgentBridgeClient({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      connectRetryMs: 5000,
      timeoutMs: 2000,
    })

    const pending = client.ping()
    hoisted.fakeSocket?.emit('connect')
    // Flush the promise chain so connect resolution, write and the read
    // listeners are all registered before we emit the response.
    await vi.advanceTimersByTimeAsync(0)
    hoisted.fakeSocket?.emit('data', Buffer.from(`${JSON.stringify({ ok: true })}\n`))

    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('still connects successfully with connectRetryMs=0 (no retries, one attempt)', async () => {
    vi.useFakeTimers()
    const { AgentBridgeClient } = await import(
      '../../packages/server/src/services/hermes/agent-bridge/client'
    )
    // connectRetryMs=0 must NOT short-circuit before the first attempt: the
    // request-level deadline still bounds the connect, so a reachable broker
    // is used normally even though retries are disabled.
    const client = new AgentBridgeClient({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      connectRetryMs: 0,
      timeoutMs: 2000,
    })

    const pending = client.ping()
    hoisted.fakeSocket?.emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    hoisted.fakeSocket?.emit('data', Buffer.from(`${JSON.stringify({ ok: true })}\n`))

    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('gives up after the single attempt when connectRetryMs=0 and connect hangs', async () => {
    vi.useFakeTimers()
    const { AgentBridgeClient } = await import(
      '../../packages/server/src/services/hermes/agent-bridge/client'
    )
    const client = new AgentBridgeClient({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      connectRetryMs: 0,
      timeoutMs: 100,
    })

    const pending = client.ping()
    const assertion = expect(pending).rejects.toMatchObject({
      errorType: 'bridge_unreachable',
    })
    // The single connect hangs (broker backlog); the request deadline must
    // still cap it instead of retrying forever.
    await vi.advanceTimersByTimeAsync(300)
    await assertion

    expect(hoisted.fakeSocket?.destroyed).toBe(true)
  })
})
