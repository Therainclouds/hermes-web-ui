import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createDetector } from '@/plugins/scanner/vision/detector'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  messages: any[] = []
  listeners = new Set<(e: any) => void>()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
  postMessage(message: any) { this.messages.push(structuredClone(message)) }
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
    expect(classic!.messages[1].opts.proposalQuad).toEqual(result.quad)
    classic!.reply({ id: classic!.messages[1].id, result: null })
    expect(await second).toBeNull()
    detector.terminate()
  })

  /**
   * Slow-device regression: 修复前 AI 回包耗时 > 1500ms 会被硬性丢弃
   * （mlHint = null），即使推理成功并返回了完整 quad。这导致慢设备
   * "模型已就绪但 hint 一直用不上"。
   *
   * 修复后仅以"代际过期"作为丢弃条件——同代际内推理耗时再长也照收。
   * 提示框新鲜度（1500ms）只在读 hint 时作为软约束过滤，不再丢弃回包本身。
   */
  it('keeps a successful slow AI reply (>1500ms wall clock) as a hint', async () => {
    const detector = createDetector()
    const first = detector.detect(frame, { strategies: ['ml', 'bright', 'edge'] })
    const [classic, ml] = FakeWorker.instances
    classic!.reply({ id: classic!.messages[0].id, result: null })
    expect(await first).toBeNull()
    // Simulate a slow WASM device: > 1500 ms wall clock between request and reply.
    vi.advanceTimersByTime(2000)
    ml!.reply({ id: ml!.messages[0].id, result })
    const second = detector.detect(frame, { strategies: ['ml', 'bright', 'edge'] })
    expect(classic!.messages[1].opts.priorQuad).toEqual(result.quad)
    expect(classic!.messages[1].opts.proposalQuad).toEqual(result.quad)
    classic!.reply({ id: classic!.messages[1].id, result: null })
    expect(await second).toBeNull()
    detector.terminate()
  })
})


it('transfers reactive selection coordinates as plain data on subsequent frames', async () => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  const detector = createDetector()
  try {
    const priorQuad = reactive(result.quad) as import('@/plugins/scanner/vision/types').Quad
    const pending = detector.detect(frame, { priorQuad })
    const worker = FakeWorker.instances[0]!
    expect(worker.messages[0].opts.priorQuad).toEqual(result.quad)
    worker.reply({ id: worker.messages[0].id, result })
    expect(await pending).toEqual(result)
  } finally {
    detector.terminate()
    vi.unstubAllGlobals()
  }
})
