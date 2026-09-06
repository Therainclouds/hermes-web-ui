import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { canvasToDataUrl, drawVideoFrame } from '../image-io'
import {
  accumulateStable,
  inCooldown,
  isOutlierWhileLocked,
  isQuadSufficient,
  isStableEnough,
  shouldRecapture,
  shouldStayLocked,
  smoothQuad,
  type StableAccumulator,
} from '../vision/capture-logic'
import { createDetector, type Detector } from '../vision/detector'
import { warpQuad } from '../vision/perspective'
import { quadCornerDelta } from '../vision/quad'
import type { Pt, Quad } from '../vision/types'

/**
 * 智能捕捉 composable（Scanner 插件内）。
 *
 * 检测：纯 JS 边缘检测 + Web Worker（vision/detector.ts）；
 * 矫正：纯 JS 双三角形仿射（vision/perspective.ts）。
 * 经典路径不依赖 OpenCV.js；可选 AI 路径使用独立 Worker / ONNX。
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
  | 'held'
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

  /** 连续命中帧数达到该值才亮起选框并上报「已检测到」（滤掉单帧误报拉框）。 */
  const SHOW_MIN_HITS = 2
  // Once visible, retain the selection until reset; a miss pauses auto capture.
  const HOLD_AFTER_MISSES = 3
  const LOCK_HITS = SHOW_MIN_HITS
  /**
   * 锁定态离群点阈值：新检测与当前选框平均角点位移超过该值视为噪声候选，
   * 保持选框不动。若新位置持续稳定 LOCK_HITS 帧，则认为目标真的换了，硬切换过去。
   */
  const JUMP_REJECT_DIST = 0.30
  const REACQUIRE_TOLERANCE = 0.08

  const enabled = ref(false)
  const autoCapture = ref(false)
  /** AI（ML 物体检测）开关：默认关闭，仅用经典识别（毫秒级实时跟随）。 */
  const aiEnabled = ref(false)
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
  let detectionRevision = 0
  /** 连续命中帧计数（首次亮框门槛用；框已在显示时单帧命中即刷新）。 */
  let hits = 0
  /** 连续丢失帧计数（清框滞回用）。 */
  let misses = 0
  /**
   * 锁定态 sticky 标志：连续 hits >= LOCK_HITS 后置 true，**只在选框真正清掉时**重置。
   * 即使中途出现几帧 miss / 抖动也保持 true —— 这是「连续识别到就保持锁定」的关键：
   *   - 之前用 stable.count >= LOCK_HITS 触发，但 stabilityTolerance=0.012 极严苛，
   *     Otsu / 相机抖动下根本到不了 3，锁定态事实上从未激活；
   *   - 改成 sticky 后，单帧 miss 不会让锁定反复进/出，miss 容忍也真正生效。
   */
  let locked = false
  /**
   * 锁定态离群点候选：当前锁定目标之外、检测持续出现的新位置。
   * 计数到 LOCK_HITS 时硬切换到该位置（用户确实把纸挪到了别处）；
   * 任何贴近当前锁定的帧都把候选归零，避免错误累积。
   */
  let candidate: { count: number; last: Quad } | null = null

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
    // 该 canvas 每帧被 drawImage 一次、随后 getImageData 读一次 ——
    // willReadFrequently 提示浏览器走 CPU 快速读回路径（消除
    // "Multiple readback operations using getImageData..." 告警）
    const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(el, 0, 0, w, h)
    return analysisCanvas
  }

  function canvasToRgba(canvas: HTMLCanvasElement): { width: number; height: number; data: Uint8ClampedArray } | null {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
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
    const revision = detectionRevision
    const det = detector.value
    if (!det) return
    let canvas: HTMLCanvasElement | null = null
    try {
      canvas = analysisFrame()
      if (!canvas) return
      const rgba = canvasToRgba(canvas)
      if (!rgba) return
      // 默认只跑经典策略（bright/edge，毫秒级）；AI 开启时才加入 'ml' 兜底。
      // priorQuad 传上一帧已显示选框：让检测结果黏住同一张纸、不跳变。
      const outcome = await det.detect(rgba, {
        minAreaRatio,
        strategies: aiEnabled.value ? ['ml', 'bright', 'edge'] : ['bright', 'edge'],
        priorQuad: quad.value,
      })
      if (disposed || !enabled.value || !cameraRunning() || revision !== detectionRevision) return

      if (!outcome || !isQuadSufficient(outcome.quad, minAreaRatio)) {
        onDetectionLoss()
        return
      }

      // Only an active drag freezes the crop; pointer-up resumes tracking.
      if (manual.value) return

      // —— 本帧有合格候选 ——
      hits += 1
      misses = 0
      detectMs.value = Math.round(outcome.ms)
      const quadNorm = outcome.quad
      const currentQuad = quad.value
      if (status.value === 'held' && hits < SHOW_MIN_HITS) return

      // 一次性锁定升级：连续命中达到 LOCK_HITS 后置 sticky 锁定态。
      // 锁定后中间出现几帧 miss 也不会退出 —— 只有选框真正清掉时才重置。
      locked = shouldStayLocked({
        currentlyLocked: locked,
        consecutiveHits: hits,
        lockHits: LOCK_HITS,
      })

      // 锁定态离群点过滤：
      //   - 单帧跳变（噪声候选）→ 忽略，保持当前选框不动；
      //   - 持续新位置 → 累加 candidate.count，达到 LOCK_HITS 硬切换（用户挪纸）；
      //   - 慢速移动（单帧位移 < JUMP_REJECT_DIST）→ 走正常平滑跟随。
      // 非锁定态（初次搜索）跳过该过滤：响应优先，由后续稳定累计把关。
      if (locked && currentQuad && isOutlierWhileLocked({
        currentQuad,
        locked,
        detected: quadNorm,
        jumpRejectDist: JUMP_REJECT_DIST,
      })) {
        if (candidate && quadCornerDelta(candidate.last, quadNorm) <= REACQUIRE_TOLERANCE) {
          candidate = { count: candidate.count + 1, last: quadNorm }
        } else {
          candidate = { count: 1, last: quadNorm }
        }
        if (candidate.count >= LOCK_HITS) {
          // 候选位置已稳定 LOCK_HITS 帧 → 硬切换到新位置（不与旧框插值，避免可见拖拽）
          stable = { count: 1, last: quadNorm }
          candidate = null
          hits = SHOW_MIN_HITS
          quad.value = quadNorm
          if (status.value !== 'cooling') status.value = 'detected'
          // 走自动拍摄分支（如果开启）
          if (!autoCapture.value) return
          if (inCooldown(lastCapturedAt, cooldownMs, performance.now())) {
            status.value = 'cooling'
            return
          }
          if (isStableEnough(stable, minStableFrames) && shouldRecapture(lastCapturedQuad, quadNorm, changeThreshold)) {
            fireAutoCapture(quadNorm)
          }
          return
        }
        // 候选位置还没稳定：保持当前选框，丢掉 stable 计数，等下一帧再判定
        stable = null
        if (status.value !== 'cooling') status.value = 'detected'
        return
      }
      // 正常帧：候选归零、累加稳定计数
      candidate = null
      stable = accumulateStable(stable, quadNorm, stabilityTolerance)

      // 亮框滞回：首次亮框需要连续 SHOW_MIN_HITS 帧（滤单帧误报）；
      // 选框已在显示时，单帧命中就刷新（持续跟随，不闪断）。
      const boxShown = quad.value !== null
      if (!boxShown && hits < SHOW_MIN_HITS) {
        if (status.value !== 'cooling') status.value = 'searching'
        return
      }
      // 指数平滑：选框向新检测收敛而非逐帧硬跳（抑制角点抖动/跳框）。
      // 拍摄/校正仍用原始 quadNorm（captureCorrected/fireAutoCapture 传 raw）。
      quad.value = smoothQuad(quad.value, quadNorm, 0.6)

      if (!autoCapture.value) {
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
      onDetectionLoss()
    }
  }

  /** Detection loss must not unmount the controls the user is reaching for. */
  function onDetectionLoss(): void {
    stable = null
    candidate = null
    hits = 0
    misses += 1
    if (manual.value) return
    if (quad.value && misses >= HOLD_AFTER_MISSES) status.value = 'held'
  }

  /** 释放手动锁定并清空选框，回到搜索状态。 */
  function releaseManual(): void {
    detectionRevision++
    manual.value = false
    quad.value = null
    stable = null
    candidate = null
    hits = 0
    misses = 0
    locked = false
    if (enabled.value) status.value = 'searching'
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
    detectionRevision++
    if (!next) {
      releaseManual()
      return
    }
    manual.value = true
    quad.value = [next[0], next[1], next[2], next[3]]
    stable = null
    candidate = null
    hits = 0
    misses = 0
    locked = false
    status.value = 'detected'
  }

  function resumeTracking() {
    if (!manual.value) return
    detectionRevision++
    manual.value = false
    stable = null
    candidate = null
    hits = 0
    misses = 0
    locked = quad.value !== null
    // Keep the edited corners as the prior; never clear the overlay on release.
  }

  /**
   * 清除当前选框 / 手动锁定，重新开始搜索（UI「重置选框」）。
   * 同时重置自动拍摄记忆，使冷却 / 翻页判定立即失效，可对同一文档重新拍摄。
   */
  function rescan() {
    lastCapturedQuad = null
    lastCapturedAt = 0
    releaseManual()
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
    detectionRevision++
    if (!value) {
      enabled.value = false
      status.value = 'off'
      stopLoop()
      clearLoadTimer()
      engineError.value = ''
      // 关闭时清空选框/手动锁定与检测统计，重新开启即全新搜索
      manual.value = false
      quad.value = null
      stable = null
      candidate = null
      hits = 0
      misses = 0
      locked = false
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
      // AI 开关若已点亮，detector 一创建就立刻预热模型（不等下一帧 analyze）
      if (aiEnabled.value) det.preloadML()
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

  /**
   * 用户点亮 AI 开关 → 立刻 worker 端预热模型，UI 立刻显示「AI 模型加载中…」。
   * 之前的实现是「下一帧 analyzeOnce 才会触发 getMLPipeline」，UI 反馈延迟一拍；
   * 而且 strategies=ml 的情况下 ML 也只在经典失败时才跑（前几帧模型还没下载完
   * 又被节流跳过），造成「开关亮着但模型一直没启动」的体感。
   *
   * 关闭 AI 后下一帧释放 AI Worker；组件 unmount 时释放所有 Worker。
   */
  watch(aiEnabled, (on) => {
    if (!on) return
    const det = detector.value
    if (!det) return
    det.preloadML()
  })

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
    aiEnabled,
    quad,
    manual,
    status,
    engineError,
    loadElapsed,
    detectMs,
    autoCount,
    /** ML pipeline 加载状态（由 worker 镜像回主线程）。 */
    mlStatus: computed<{ state: 'off' | 'loading' | 'ready' | 'failed'; error?: string }>(() =>
      detector.value?.mlStatus.value ?? { state: 'off' as const },
    ),
    setEnabled,
    setAutoCapture: (v: boolean) => { autoCapture.value = v },
    setQuadManually,
    resumeTracking,
    lockSelection: () => { if (quad.value) setQuadManually(quad.value) },
    rescan,
    captureNow,
    markCaptured,
    setAspectRatio,
  }
}

export type SmartCapture = ReturnType<typeof useSmartCapture>
