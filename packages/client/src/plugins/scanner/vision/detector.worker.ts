import { detectPaper, type DetectOptions, type PaperDetection } from './paper-detector'
import { getMLStatus, type MLStatus } from './detector-ml'

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
  mlStatus?: MLStatus
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (event: MessageEvent<DetectRequest>) => {
  const { id, imageData, opts } = event.data
  try {
    const result = await detectPaper(imageData, opts)
    const response: DetectResponse = { id, result, mlStatus: getMLStatus() }
    ctx.postMessage(response)
  } catch (error) {
    ctx.postMessage({
      id,
      result: null,
      mlStatus: getMLStatus(),
      error: (error as Error)?.message ?? String(error),
    })
  }
}

export type { DetectRequest, DetectResponse }