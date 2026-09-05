// @vitest-environment jsdom
import { createApp, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSmartCapture } from '@/plugins/scanner/composables/useSmartCapture'
import type { Quad } from '@/plugins/scanner/vision/types'

const mocks = vi.hoisted(() => ({ detect: vi.fn() }))
vi.mock('@/plugins/scanner/vision/detector', () => ({
  createDetector: () => ({ detect: mocks.detect, terminate() {}, preloadML() {}, mlStatus: ref({ state: 'off' }) }),
}))
const quad: Quad = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }]
const detected = { quad, ms: 10, confidence: 0.7, strategy: 'bright' }
let app: ReturnType<typeof createApp>
let smart: ReturnType<typeof useSmartCapture>
let frameCallback: FrameRequestCallback
let now = 0
async function tick() {
  now += 150
  frameCallback(now)
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
beforeEach(async () => {
  vi.useFakeTimers()
  mocks.detect.mockReset().mockResolvedValue(detected)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frameCallback = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
  } as any)
  const video = { readyState: 2, videoWidth: 64, videoHeight: 64 } as HTMLVideoElement
  app = createApp({ setup() { smart = useSmartCapture({ video: () => video, cameraRunning: () => true }); return () => null } })
  app.mount(document.createElement('div'))
  now = 0
  await smart.setEnabled(true)
  await tick(); await tick()
  expect(smart.quad.value).toEqual(quad)
})
afterEach(() => { app.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('retains an acquired box through prolonged loss, pauses auto shoot, and resets only explicitly', async () => {
  smart.setAutoCapture(true)
  mocks.detect.mockResolvedValue(null)
  for (let i = 0; i < 30; i++) await tick()
  expect(smart.quad.value).toEqual(quad)
  expect(smart.status.value).toBe('held')
  expect(smart.autoCount.value).toBe(0)
  mocks.detect.mockResolvedValue(detected)
  await tick()
  expect(smart.status.value).toBe('held')
  smart.setAutoCapture(false)
  await tick()
  expect(smart.status.value).toBe('detected')
  smart.rescan()
  expect(smart.quad.value).toBeNull()
  expect(smart.status.value).toBe('searching')
})

it('locks on pointer-down and ignores an already in-flight result before any pointer movement', async () => {
  let resolve!: (result: typeof detected) => void
  mocks.detect.mockReturnValue(new Promise(r => { resolve = r }))
  await tick()
  smart.lockSelection()
  expect(smart.manual.value).toBe(true)
  resolve({ ...detected, quad: quad.map(p => ({ x: p.x + 0.1, y: p.y })) as Quad })
  for (let i = 0; i < 6; i++) await Promise.resolve()
  expect(smart.quad.value).toEqual(quad)
  mocks.detect.mockResolvedValue(null)
  for (let i = 0; i < 15; i++) await tick()
  expect(smart.quad.value).toEqual(quad)
  expect(smart.manual.value).toBe(true)
})

it('resumes following moving paper after releasing a manually adjusted corner without clearing it', async () => {
  smart.lockSelection()
  const edited = quad.map(p => ({ x: p.x + 0.02, y: p.y })) as Quad
  smart.setQuadManually(edited)
  smart.resumeTracking()
  expect(smart.manual.value).toBe(false)
  expect(smart.quad.value).toEqual(edited)
  mocks.detect.mockResolvedValue(null)
  await tick()
  expect(smart.quad.value).toEqual(edited)
  for (const shift of [0.04, 0.08, 0.12]) {
    mocks.detect.mockResolvedValue({ ...detected, quad: quad.map(p => ({ x: p.x + shift, y: p.y })) })
    await tick()
  }
  expect(smart.quad.value![0].x).toBeGreaterThan(0.29)
  expect(smart.status.value).toBe('detected')
})

it('reacquires a distant target that is still moving instead of requiring capture-level stillness', async () => {
  const moved = (offset: number) => quad.map(p => ({ x: p.x * 0.4 + offset, y: p.y * 0.4 })) as Quad
  mocks.detect.mockResolvedValue({ ...detected, quad: moved(0) })
  await tick()
  expect(smart.quad.value).toEqual(quad)
  mocks.detect.mockResolvedValue({ ...detected, quad: moved(0.02) })
  await tick()
  expect(smart.quad.value).toEqual(moved(0.02))
  expect(smart.autoCount.value).toBe(0)
})
