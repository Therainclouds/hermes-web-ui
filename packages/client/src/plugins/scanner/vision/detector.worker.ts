import { detectPaper, type DetectOptions, type PaperDetection } from './paper-detector'
import { getMLPipeline, getMLStatus, type MLStatus } from './detector-ml'

/**
 * Web Worker 入口：每条消息 = 一次检测请求，回复同 id。
 *
 * 输入用 transferable 把像素 buffer 零拷贝传进来（同一 buffer 被 neutered，
 * 调用方需要在主线程维护一份拷贝）。
 */

interface DetectRequest {
  type: 'detect'
  id: number
  imageData: { width: number; height: number; data: Uint8ClampedArray }
  opts?: DetectOptions
}

interface PreloadRequest {
  type: 'preload'
}

type WorkerRequest = DetectRequest | PreloadRequest

interface DetectResponse {
  id?: number
  result?: PaperDetection | null
  mlStatus?: MLStatus
  type?: 'ml-status'
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'preload') {
    ctx.postMessage({ type: 'ml-status', mlStatus: { state: 'loading' } satisfies MLStatus } satisfies DetectResponse)
    try {
      await getMLPipeline()
    } catch {
      ctx.postMessage({ type: 'ml-status', mlStatus: getMLStatus() } satisfies DetectResponse)
      return
    }
    ctx.postMessage({ type: 'ml-status', mlStatus: getMLStatus() } satisfies DetectResponse)
    return
  }

  const { id, imageData, opts } = request
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