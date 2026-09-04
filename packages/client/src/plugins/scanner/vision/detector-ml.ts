import type { Quad } from './types'

/**
 * 基于 @huggingface/transformers 的物体检测包装。
 *
 * 启动时按需从 huggingface CDN 懒加载模型（约 6-10 MB）。
 * 优先尝试 WebGPU，回退 WASM（100% 浏览器支持，但慢 4-5 倍）。
 *
 * 返回的不是"纸张检测"，而是"画面里所有矩形物体的边界框"——
 * 检测器接收 YOLO 的所有高分检测，按"大面积矩形 + 合理宽高比"选最优。
 * 在实时摄像头取景下，白纸 / 书本 / 笔记本 / 便签通常都是最大的矩形物体。
 */

export interface MLBox {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

export interface MLCandidate {
  quad: Quad
  score: number
  label: string
  /** 像素宽 / 像素高。用于过滤纸张比例。 */
  aspect: number
  /** 占帧面积比 (0..1)。 */
  areaRatio: number
}

export interface MLOptions {
  /** 评分阈值，低于此丢弃。默认 0.35。 */
  threshold?: number
  /** 最大保留检测数（按面积排序）。默认 8。 */
  topK?: number
}

const DEFAULT_MODEL = 'onnx-community/yolov10n'
const DEFAULT_THRESHOLD = 0.35
const DEFAULT_TOP_K = 8

interface PipelineBox {
  label: string
  score: number
  box: MLBox
}

interface PipelineLike {
  (input: HTMLCanvasElement | OffscreenCanvas | HTMLImageElement, opts?: { threshold?: number }): Promise<PipelineBox[]>
}

let pipelinePromise: Promise<PipelineLike> | null = null
let pipelineKey = ''

function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/** 获取（懒加载）Transformers.js + YOLO pipeline。WebGPU 优先，WASM 兜底。 */
export async function getMLPipeline(modelId = DEFAULT_MODEL): Promise<PipelineLike> {
  const envMod = await import('@huggingface/transformers')
  const { pipeline, env } = envMod as unknown as {
    pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<PipelineLike>
    env: {
      backends?: { onnx?: { wasm?: { numThreads?: number } } }
      allowLocalModels?: boolean
      useFs?: boolean
    }
  }

  // WASM 线程数：尽量榨干多核
  if (env.backends?.onnx?.wasm) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2
    env.backends.onnx.wasm.numThreads = Math.min(4, cores)
  }
  // 避免 worker 里访问 fs（Vite 静态服务没有 fs）
  env.allowLocalModels = false
  env.useFs = false

  const device = hasWebGPU() ? 'webgpu' : 'wasm'
  const key = `${modelId}@${device}`
  if (pipelinePromise && pipelineKey === key) return pipelinePromise

  pipelineKey = key
  pipelinePromise = pipeline('object-detection', modelId, {
    device,
    dtype: 'q8',
  })
  return pipelinePromise
}

/** 取消加载中的 pipeline（用于 unmount）。 */
export function disposeMLPipeline(): void {
  pipelinePromise = null
  pipelineKey = ''
}

/**
 * 调一次 YOLO，返回"高分矩形检测"列表，按面积降序。
 *
 * 输入需为 HTMLCanvasElement / OffscreenCanvas（Transformers.js 不直接吃 ImageData）。
 * 输入像素 (W, H) 用于把 box 转归一化 + 过滤 aspect/area。
 */
export async function detectRectangles(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  W: number,
  H: number,
  modelId: string = DEFAULT_MODEL,
  opts: MLOptions = {},
): Promise<MLCandidate[]> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const topK = opts.topK ?? DEFAULT_TOP_K

  const pipe = await getMLPipeline(modelId)
  const raw = await pipe(canvas, { threshold })

  const candidates: MLCandidate[] = []
  for (const det of raw) {
    const w = det.box.xmax - det.box.xmin
    const h = det.box.ymax - det.box.ymin
    if (w <= 0 || h <= 0) continue
    const areaRatio = (w * h) / (W * H)
    if (areaRatio < 0.02 || areaRatio > 0.9) continue
    const quad: Quad = [
      { x: det.box.xmin / W, y: det.box.ymin / H },
      { x: det.box.xmax / W, y: det.box.ymin / H },
      { x: det.box.xmax / W, y: det.box.ymax / H },
      { x: det.box.xmin / W, y: det.box.ymax / H },
    ]
    candidates.push({
      quad,
      score: det.score,
      label: det.label,
      aspect: w / h,
      areaRatio,
    })
  }

  candidates.sort((a, b) => b.areaRatio - a.areaRatio)
  return candidates.slice(0, topK)
}

/**
 * 把 MLCandidate 转成 PaperDetection 兼容的结果。
 * caller 负责 aspect / area 等业务校验。
 */
export function candidateToDetection(c: MLCandidate): {
  quad: Quad
  confidence: number
  strategy: 'ml'
  ms: number
} {
  return {
    quad: c.quad,
    confidence: c.score,
    strategy: 'ml',
    ms: 0,
  }
}