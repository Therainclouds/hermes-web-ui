import { ref, type Ref } from 'vue'
import type { DetectOptions, PaperDetection } from './paper-detector'
import type { MLStatus } from './detector-ml'
import type { Quad } from './types'

/**
 * 主线程 → Worker 通信层。
 *
 * 启动一个 module worker（Vite URL 形式），按 id 匹配请求与回调。
 * 多次 detect() 并行不会阻塞；terminate() 立即关停。
 *
 * ML 加载状态由 worker 通过 postMessage 同步回来，UI 通过 mlStatusRef 读。
 */

export interface Detector {
  detect(
    imageData: { width: number; height: number; data: Uint8ClampedArray },
    opts?: DetectOptions,
  ): Promise<PaperDetection | null>
  /**
   * 主动触发 ML pipeline 预热。worker 内 fire-and-forget 拉起模型加载，
   * 状态变化通过 mlStatus ref 实时镜像到主线程。重复调用由 worker 内部
   * promise 复用保证只下载一次。
   */
  preloadML(): void
  terminate(): void
  /** ML pipeline 加载状态（ref，UI 直接绑）。 */
  readonly mlStatus: Ref<MLStatus>
}

interface PendingEntry {
  resolve: (result: PaperDetection | null) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerResponse {
  id?: number
  result?: PaperDetection | null
  error?: string
  mlStatus?: MLStatus
}

export function createDetector(): Detector {
  const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' })
  const mlStatusRef = ref<MLStatus>({ state: 'off' })
  let nextId = 1
  const pending = new Map<number, PendingEntry>()
  let terminated = false
  let mlWorker: Worker | null = null
  let mlBusy = false
  let mlStartedAt = -Infinity
  let mlGeneration = 0
  let mlTimer: ReturnType<typeof setTimeout> | undefined
  let mlHint: { result: PaperDetection; at: number; width: number; height: number } | null = null

  function stopML() {
    clearTimeout(mlTimer)
    mlGeneration++
    mlWorker?.terminate()
    mlWorker = null
    mlBusy = false
    mlHint = null
    mlStartedAt = -Infinity
    mlStatusRef.value = { state: 'off' }
  }

  function ensureML(): Worker {
    if (mlWorker) return mlWorker
    const instance = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' })
    mlWorker = instance
    instance.onerror = () => { stopML(); mlStatusRef.value = { state: 'failed' } }
    instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.mlStatus) mlStatusRef.value = event.data.mlStatus
    }
    return instance
  }

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, result } = event.data
    if (id === undefined) return
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(result ?? null)
  }
  worker.onerror = (event) => {
    // eslint-disable-next-line no-console
    console.warn('[scanner-detector] worker error:', event.message)
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(null) }
    pending.clear()
  }

  return {
    detect(imageData, opts) {
      if (terminated) return Promise.resolve(null)
      // Vue refs expose proxy coordinates, which postMessage cannot clone.
      // Copy both the tuple and its points before crossing the worker boundary.
      const plainQuad = (quad?: Quad | null): Quad | null => quad
        ? [{ x: quad[0].x, y: quad[0].y }, { x: quad[1].x, y: quad[1].y },
          { x: quad[2].x, y: quad[2].y }, { x: quad[3].x, y: quad[3].y }] : null
      opts = { ...opts, priorQuad: plainQuad(opts?.priorQuad), proposalQuad: plainQuad(opts?.proposalQuad) }
      const wantsML = opts?.strategies?.includes('ml') ?? false
      if (!wantsML && mlWorker) stopML()
      const now = performance.now()
      const hint = mlHint && now - mlHint.at < 1500 && mlHint.width === imageData.width && mlHint.height === imageData.height
        ? mlHint.result.quad : null
      if (wantsML && !mlBusy && now - mlStartedAt >= 300) {
        // A separate worker isolates slow WASM inference from the real-time loop.
        const instance = ensureML()
        const generation = mlGeneration
        const started = now
        mlBusy = true
        mlStartedAt = now
        const onMessage = (event: MessageEvent<WorkerResponse>) => {
          if (event.data.id === undefined) return
          instance.removeEventListener('message', onMessage)
          clearTimeout(timer)
          if (generation !== mlGeneration) return
          mlBusy = false
          // Never display an old AI frame. Only use a fresh proposal as a prior
          // for contour detection on the NEXT current camera frame.
          if (event.data.result && performance.now() - started < 1500) {
            mlHint = { result: event.data.result, at: started, width: imageData.width, height: imageData.height }
          } else mlHint = null
        }
        const timer = setTimeout(() => {
          instance.removeEventListener('message', onMessage)
          if (generation === mlGeneration) stopML()
        }, 10000)
        mlTimer = timer
        instance.addEventListener('message', onMessage)
        const copy = new Uint8ClampedArray(imageData.data)
        instance.postMessage({ type: 'detect', id: nextId++, imageData: { ...imageData, data: copy }, opts: { ...opts, priorQuad: null, strategies: ['ml'] } }, [copy.buffer])
      }
      return new Promise<PaperDetection | null>((resolve) => {
        const id = nextId++
        const timer = setTimeout(() => { pending.delete(id); resolve(null) }, 5000)
        pending.set(id, { resolve, timer })
        const copy = new Uint8ClampedArray(imageData.data)
        worker.postMessage(
          { type: 'detect', id, imageData: { width: imageData.width, height: imageData.height, data: copy }, opts: {
            ...opts, strategies: opts?.strategies?.filter(s => s !== 'ml').length
              ? opts.strategies.filter(s => s !== 'ml') : ['bright', 'edge'],
            priorQuad: opts?.priorQuad ?? hint,
            proposalQuad: wantsML ? hint : null,
          } },
          [copy.buffer],
        )
      })
    },
    preloadML() {
      if (!terminated) ensureML().postMessage({ type: 'preload' })
    },
    terminate() {
      terminated = true
      worker.terminate()
      stopML()
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(null) }
      pending.clear()
      mlStatusRef.value = { state: 'off' }
    },
    get mlStatus() {
      return mlStatusRef
    },
  }
}
