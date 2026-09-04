import type { DetectOptions, PaperDetection } from './paper-detector'

/**
 * 主线程 → Worker 通信层。
 *
 * 启动一个 module worker（Vite URL 形式），按 id 匹配请求与回调。
 * 多次 detect() 并行不会阻塞；terminate() 立即关停。
 */

export interface Detector {
  detect(
    imageData: { width: number; height: number; data: Uint8ClampedArray },
    opts?: DetectOptions,
  ): Promise<PaperDetection | null>
  terminate(): void
}

interface PendingEntry {
  resolve: (result: PaperDetection | null) => void
}

interface WorkerResponse {
  id: number
  result: PaperDetection | null
  error?: string
}

export function createDetector(): Detector {
  const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' })
  let nextId = 1
  const pending = new Map<number, PendingEntry>()

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, result } = event.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.resolve(result ?? null)
  }
  worker.onerror = (event) => {
    // eslint-disable-next-line no-console
    console.warn('[scanner-detector] worker error:', event.message)
    for (const entry of pending.values()) entry.resolve(null)
    pending.clear()
  }

  return {
    detect(imageData, opts) {
      return new Promise<PaperDetection | null>((resolve) => {
        const id = nextId++
        pending.set(id, { resolve })
        const copy = new Uint8ClampedArray(imageData.data)
        worker.postMessage(
          { id, imageData: { width: imageData.width, height: imageData.height, data: copy }, opts },
          [copy.buffer],
        )
      })
    },
    terminate() {
      worker.terminate()
      pending.clear()
    },
  }
}