import { detectPaper, type DetectOptions, type PaperDetection } from './paper-detector'

/**
 * Web Worker 入口：每条消息 = 一次检测请求，回复同 id。
 *
 * 输入用 transferable 把像素 buffer 零拷贝传进来（同一 buffer 被 neutered，
 * 调用方需要在主线程维护一份拷贝）。
 */

interface DetectRequest {
  id: number
  imageData: { width: number; height: number; data: Uint8ClampedArray }
  opts?: DetectOptions
}

interface DetectResponse {
  id: number
  result: PaperDetection | null
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<DetectRequest>) => {
  const { id, imageData, opts } = event.data
  try {
    const result = detectPaper(imageData, opts)
    const response: DetectResponse = { id, result }
    ctx.postMessage(response)
  } catch (error) {
    ctx.postMessage({
      id,
      result: null,
      error: (error as Error)?.message ?? String(error),
    })
  }
}

export type { DetectRequest, DetectResponse }