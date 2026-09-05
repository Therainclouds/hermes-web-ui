import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDetector } from '@/plugins/scanner/vision/detector'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  messages: any[] = []
  listeners = new Set<(e: any) => void>()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
  postMessage(message: any) { this.messages.push(message) }
  addEventListener(_type: string, listener: (e: any) => void) { this.listeners.add(listener) }
  removeEventListener(_type: string, listener: (e: any) => void) { this.listeners.delete(listener) }
  reply(data: any) { this.onmessage?.({ data }); for (const listener of this.listeners) listener({ data }) }
}
const frame = { width: 32, height: 32, data: new Uint8ClampedArray(4096) }
const result = { quad: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }], confidence: 0.5, ms: 20, strategy: 'bright' }

describe('scanner worker isolation', () => {
  beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('returns the current classical frame without waiting for AI and preserves AI status', async () => {
    const detector = createDetector()
    detector.preloadML()
    const [classic, ml] = FakeWorker.instances
    ml!.reply({ type: 'ml-status', mlStatus: { state: 'ready' } })
    const pending = detector.detect(frame, { strategies: ['ml', 'bright', 'edge'] })
    expect(ml!.messages.some(m => m.type === 'detect')).toBe(true)
    const request = classic!.messages[0]
    expect(request.opts.strategies).toEqual(['bright', 'edge'])
    classic!.reply({ id: request.id, result, mlStatus: { state: 'off' } })
    expect(await pending).toEqual(result)
    expect(detector.mlStatus.value.state).toBe('ready')
    detector.terminate()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles outstanding detection on terminate instead of leaving the loop stuck', async () => {
    const detector = createDetector()
    const pending = detector.detect(frame)
    detector.terminate()
    expect(await pending).toBeNull()
    expect(await detector.detect(frame)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires a hung classical request', async () => {
    const detector = createDetector()
    const pending = detector.detect(frame)
    vi.advanceTimersByTime(5000)
    expect(await pending).toBeNull()
    detector.terminate()
  })

  it('uses AI only as a hint on a new frame, not as the displayed result', async () => {
    const detector = createDetector()
    const first = detector.detect(frame, { strategies: ['ml', 'bright', 'edge'] })
    const [classic, ml] = FakeWorker.instances
    classic!.reply({ id: classic!.messages[0].id, result: null })
    expect(await first).toBeNull()
    ml!.reply({ id: ml!.messages[0].id, result })
    const second = detector.detect(frame, { strategies: ['ml', 'bright', 'edge'] })
    expect(classic!.messages[1].opts.priorQuad).toEqual(result.quad)
    classic!.reply({ id: classic!.messages[1].id, result: null })
    expect(await second).toBeNull()
    detector.terminate()
  })
})
