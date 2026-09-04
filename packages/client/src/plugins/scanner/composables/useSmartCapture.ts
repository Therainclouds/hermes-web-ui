import { onUnmounted, ref, shallowRef } from 'vue'
import { canvasToDataUrl, drawVideoFrame } from '../image-io'
import {
  accumulateStable,
  inCooldown,
  isQuadSufficient,
  isStableEnough,
  shouldRecapture,
  type StableAccumulator,
} from '../vision/capture-logic'
import { createDetector, type Detector } from '../vision/detector'
import { warpQuad } from '../vision/perspective'
import type { Pt, Quad } from '../vision/types'

/**
 * 智能捕捉 composable（Scanner 插件内）。
 *
 * 检测：纯 JS 边缘检测 + Web Worker（vision/detector.ts）；
 * 矫正：纯 JS 双三角形仿射（vision/perspective.ts）。
 * 全部不依赖 OpenCV.js / WebAssembly。
 *
 * 开启「智能模式」后周期分析摄像头画面：
 *  1. 检测到纸张 -> 暴露归一化选框 quad（供 UI 覆盖层绘制 / 角点拖动）；
 *  2. 选框连续稳定 N 帧且满足冷却/翻页条件时 -> 触发 onAutoCapture，
 *     由调用方把矫正+增强后的页面加入列表；
 *  3. 检测器（Worker）异常时降级，不阻塞普通拍摄。
 *
 * 纯决策逻辑在 vision/capture-logic.ts，可在 Node 里单测。
 */

export type SmartCaptureStatus =
  | 'off'
  | 'loading'
  | 'unavailable'
  | 'searching'
  | 'detected'
  | 'capturing'
  | 'cooling'

export interface AutoCapturePayload {
  canvas: HTMLCanvasElement
  quad: Quad
  ms: number
}

export interface SmartCaptureOptions {
  video: () => HTMLVideoElement | null
  cameraRunning: () => boolean
  onAutoCapture?: (payload: AutoCapturePayload) => void | Promise<void>
  analyzeMaxEdge?: number
  intervalMs?: number
  minStableFrames?: number
  minAreaRatio?: number
  stabilityTolerance?: number
  cooldownMs?: number
  changeThreshold?: number
  maxFrameEdge?: number
  outputMaxEdge?: number
  aspectRatio?: number | null
}

export function useSmartCapture(options: SmartCaptureOptions) {
  const video = options.video
  const cameraRunning = options.cameraRunning
  const analyzeMaxEdge = options.analyzeMaxEdge ?? 512
  const intervalMs = options.intervalMs ?? 140
  const minStableFrames = options.minStableFrames ?? 4
  const minAreaRatio = options.minAreaRatio ?? 0.03
  const stabilityTolerance = options.stabilityTolerance ?? 0.012
  const cooldownMs = options.cooldownMs ?? 1600
  const changeThreshold = options.changeThreshold ?? 0.03
  const maxFrameEdge = options.maxFrameEdge ?? 2400
  const outputMaxEdge = options.outputMaxEdge ?? 2200

  const enabled = ref(false)
  const autoCapture = ref(false)
  const quad = ref<Quad | null>(null)
  const manual = ref(false)
  const status = ref<SmartCaptureStatus>('off')
  const detectMs = ref(0)
  const autoCount = ref(0)

  const detector = shallowRef<Detector | null>(null)
  const engineError = ref('')
  const loadElapsed = ref(0)

  let loadTimer = 0
  let rafId = 0
  let lastTickAt = 0
  let detectInFlight = false
  let stable: StableAccumulator | null = null
  let lastCapturedQuad: Quad | null = null
  let lastCapturedAt = 0
  let analysisCanvas: HTMLCanvasElement | null = null
  let disposed = false

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  function startLoop() {
    if (rafId || disposed) return
    lastTickAt = 0
    const frame = (now: number) => {
      if (disposed) return
      rafId = requestAnimationFrame(frame)
      if (!enabled.value || !cameraRunning() || !detector.value) return
      if (now - lastTickAt < intervalMs) return
      if (detectInFlight) return
      lastTickAt = now
      detectInFlight = true
      void analyzeOnce().finally(() => { detectInFlight = false })
    }
    rafId = requestAnimationFrame(frame)
  }

  function analysisFrame(): HTMLCanvasElement | null {
    const el = video()
    if (!el || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
    const vw = el.videoWidth
    const vh = el.videoHeight
    if (!vw || !vh) return null
    const scale = Math.min(1, analyzeMaxEdge / Math.max(vw, vh))
    const w = Math.max(1, Math.round(vw * scale))
    const h = Math.max(1, Math.round(vh * scale))
    if (!analysisCanvas || analysisCanvas.width !== w || analysisCanvas.height !== h) {
      analysisCanvas = document.createElement('canvas')
      analysisCanvas.width = w
      analysisCanvas.height = h
    }
    const ctx = analysisCanvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(el, 0, 0, w, h)
    return analysisCanvas
  }

  function canvasToRgba(canvas: HTMLCanvasElement): { width: number; height: number; data: Uint8ClampedArray } | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(img.data) }
  }

  function rgbaToCanvas(rgba: { width: number; height: number; data: Uint8ClampedArray }): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = rgba.width
    canvas.height = rgba.height
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0)
    }
    return canvas
  }

  async function analyzeOnce(): Promise<void> {
    const det = detector.value
    if (!det) return
    let canvas: HTMLCanvasElement | null = null
    try {
      canvas = analysisFrame()
      if (!canvas) return
      const rgba = canvasToRgba(canvas)
      if (!rgba) return
      const outcome = await det.detect(rgba, { minAreaRatio: 0.05 })
      if (disposed || !enabled.value) return
      if (!outcome) {
        stable = null
        if (!manual.value) quad.value = null
        if (status.value !== 'cooling') status.value = 'searching'
        return
      }
      detectMs.value = Math.round(outcome.ms)
      const quadNorm = outcome.quad
      if (!manual.value) quad.value = quadNorm
      if (!isQuadSufficient(quadNorm, minAreaRatio)) {
        stable = null
        if (!manual.value) quad.value = null
        if (status.value !== 'cooling') status.value = 'searching'
        return
      }
      stable = accumulateStable(stable, quadNorm, stabilityTolerance)

      if (!autoCapture.value || manual.value) {
        status.value = 'detected'
        return
      }
      if (inCooldown(lastCapturedAt, cooldownMs, performance.now())) {
        status.value = 'cooling'
        return
      }
      if (isStableEnough(stable, minStableFrames) && shouldRecapture(lastCapturedQuad, quadNorm, changeThreshold)) {
        fireAutoCapture(quadNorm)
      } else {
        status.value = 'detected'
      }
    } catch {
      stable = null
      if (status.value !== 'cooling') status.value = 'searching'
    }
  }

  function fireAutoCapture(quadNorm: Quad) {
    if (status.value === 'capturing') return
    status.value = 'capturing'
    const started = performance.now()
    const canvas = captureCorrected(quadNorm)
    if (!canvas) {
      status.value = 'detected'
      return
    }
    const payload: AutoCapturePayload = {
      canvas,
      quad: quadNorm,
      ms: performance.now() - started,
    }
    void Promise.resolve(options.onAutoCapture?.(payload)).then(() => {
      if (status.value === 'capturing') {
        markCaptured(quadNorm)
      }
    })
  }

  /** 按选框把当前视频帧矫正拍摄成 canvas；失败返回 null。 */
  function captureCorrected(quadNorm: Quad | null): HTMLCanvasElement | null {
    const useQuad = quadNorm ?? quad.value
    const el = video()
    if (!el || !useQuad) return null
    const frame = drawVideoFrame(el, maxFrameEdge)
    if (!frame) return null
    const rgba = canvasToRgba(frame)
    if (!rgba) return null
    const cornersPx: [Pt, Pt, Pt, Pt] = [
      { x: useQuad[0].x * frame.width, y: useQuad[0].y * frame.height },
      { x: useQuad[1].x * frame.width, y: useQuad[1].y * frame.height },
      { x: useQuad[2].x * frame.width, y: useQuad[2].y * frame.height },
      { x: useQuad[3].x * frame.width, y: useQuad[3].y * frame.height },
    ]
    const warped = warpQuad(rgba, cornersPx, {
      maxEdge: outputMaxEdge,
      aspectRatio: options.aspectRatio ?? null,
    })
    return rgbaToCanvas(warped)
  }

  async function captureNow(): Promise<{ dataUrl: string; width: number; height: number; quad: Quad } | null> {
    const useQuad = quad.value
    if (!useQuad) return null
    const canvas = captureCorrected(useQuad)
    if (!canvas) return null
    const quadCopy: Quad = [useQuad[0], useQuad[1], useQuad[2], useQuad[3]]
    return {
      dataUrl: canvasToDataUrl(canvas, 0.92),
      width: canvas.width,
      height: canvas.height,
      quad: quadCopy,
    }
  }

  function markCaptured(quadNorm: Quad | null) {
    if (quadNorm) {
      lastCapturedQuad = [quadNorm[0], quadNorm[1], quadNorm[2], quadNorm[3]]
      lastCapturedAt = performance.now()
    }
    stable = null
    autoCount.value += 1
    status.value = 'cooling'
  }

  function setQuadManually(next: Quad | null) {
    if (!next) {
      clearManual()
      return
    }
    manual.value = true
    quad.value = [next[0], next[1], next[2], next[3]]
    stable = null
  }

  function clearManual() {
    manual.value = false
  }

  function setAspectRatio(aspect: number | null) {
    options.aspectRatio = aspect
  }

  function ensureRunning() {
    if (!enabled.value || disposed) return
    if (!cameraRunning()) {
      if (status.value !== 'unavailable') status.value = 'off'
      return
    }
    if (!detector.value) {
      if (status.value !== 'unavailable') status.value = 'loading'
      return
    }
    if (status.value !== 'unavailable') status.value = 'searching'
    startLoop()
  }

  async function setEnabled(value: boolean) {
    if (!value) {
      enabled.value = false
      status.value = 'off'
      stopLoop()
      clearLoadTimer()
      engineError.value = ''
      return
    }
    enabled.value = true
    if (detector.value) {
      ensureRunning()
      return
    }
    if (cameraRunning()) status.value = 'loading'
    const startedAt = Date.now()
    loadElapsed.value = 0
    window.clearInterval(loadTimer)
    loadTimer = window.setInterval(() => {
      loadElapsed.value = Math.round((Date.now() - startedAt) / 1000)
    }, 1000)
    try {
      const det = createDetector()
      detector.value = det
      engineError.value = ''
      loadElapsed.value = 0
      clearLoadTimer()
      if (disposed || !enabled.value) {
        det.terminate()
        detector.value = null
        return
      }
      ensureRunning()
    } catch (error) {
      clearLoadTimer()
      engineError.value = (error as Error)?.message ?? 'detector startup failed'
      status.value = 'unavailable'
    }
  }

  function clearLoadTimer() {
    window.clearInterval(loadTimer)
    loadTimer = 0
  }

  let wasRunning = cameraRunning()
  const cameraWatcher = window.setInterval(() => {
    if (disposed) return
    const running = cameraRunning()
    if (running === wasRunning) return
    wasRunning = running
    if (!running) {
      stopLoop()
      if (enabled.value && status.value !== 'unavailable') status.value = 'off'
    } else if (enabled.value) {
      ensureRunning()
    }
  }, 500)

  onUnmounted(() => {
    disposed = true
    stopLoop()
    window.clearInterval(cameraWatcher)
    clearLoadTimer()
    detector.value?.terminate()
    detector.value = null
  })

  return {
    enabled,
    autoCapture,
    quad,
    manual,
    status,
    engineError,
    loadElapsed,
    detectMs,
    autoCount,
    setEnabled,
    setAutoCapture: (v: boolean) => { autoCapture.value = v },
    setQuadManually,
    clearManual,
    captureNow,
    markCaptured,
    setAspectRatio,
  }
}

export type SmartCapture = ReturnType<typeof useSmartCapture>