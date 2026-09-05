import type { Pt, Quad } from './types'
import { quadCornerDelta } from './quad'
import { refinePaperQuad } from './refine-quad'
import { getMLStatus, getMLPipeline, isMLRetryCooldown } from './detector-ml'

/**
 * 纯 JS 纸张边缘检测（经典优先 + ML 兜底版）。
 *
 * 输入：RGBA 像素。输出：归一化 4 角点 + 置信度 + 耗时。
 *
 * 执行顺序：
 *   1) bright / edge 经典策略（同步、单帧几十 ms，实时跟随的主路径）。
 *      bright 同时评估白纸对暗背景 / 深色纸对亮桌面两种极性；
 *      候选按「矩形度 + 边框接触」质量评分选优，并优先黏住上一帧的目标。
 *   2) AI 提供候选区域，再通过同帧经典轮廓验证四角。
 *      实时通信层使用独立 AI Worker，不让推理阻塞经典检测。
 *
 * 全部纯函数，对 ~512 长边单帧 25-55 ms（V8 / happy-dom）。
 */

export interface PaperDetection {
  /** 归一化四边形角点（0..1，相对输入图像宽高）。 */
  quad: Quad
  /** 0..1，面积比 × 紧凑度 × 策略加权。 */
  confidence: number
  /** 单帧耗时 ms（含全部策略）。 */
  ms: number
  /** 命中的策略，便于调试与 UI 提示。 */
  strategy: 'ml' | 'bright' | 'edge'
}

export interface DetectOptions {
  /** 最小面积比（占帧），低于返回 null。默认 0.05。 */
  minAreaRatio?: number
  /** 最大面积比（占帧），高于返回 null（mask 过均匀时拒绝）。默认 0.85。 */
  maxAreaRatio?: number
  /** 宽高比下界，默认 0.3。 */
  minAspect?: number
  /** 宽高比上界，默认 3.0。 */
  maxAspect?: number
  /**
   * 要运行的策略。默认 ['bright', 'edge']（纯经典，毫秒级实时跟随）。
   * 'ml'（AI）默认不参与；显式加入后与经典并行跑，由复合分 + 黏性选优最终选一个。
   */
  strategies?: ReadonlyArray<'ml' | 'bright' | 'edge'>
  /** ML 评分阈值，低于此丢弃。默认 0.35。 */
  mlThreshold?: number
  /**
   * 上一帧已确认的选框（归一化）。用于候选选择：优先选与上一帧位置接近的
   * 目标，避免选框在多物体/杂波间跳变，实现「时时追随同一张纸」。
   */
  priorQuad?: Quad | null
  /** Fresh AI proposal, revalidated against the current frame before use. */
  proposalQuad?: Quad | null
}

const DEFAULTS: Required<Omit<DetectOptions, 'strategies' | 'priorQuad' | 'proposalQuad'>> & {
  strategies: ReadonlyArray<'ml' | 'bright' | 'edge'>
  priorQuad: Quad | null
} = {
  minAreaRatio: 0.05,
  maxAreaRatio: 0.85,
  minAspect: 0.3,
  maxAspect: 3.0,
  mlThreshold: 0.35,
  strategies: ['bright', 'edge'],
  priorQuad: null,
}

/** 连通域按面积取 Top-N 交给 finalizeDetection 评分（不只看最大的一个）。 */
const BRIGHT_CANDIDATES = 5
const EDGE_CANDIDATES = 4
/** 候选与上一帧选框的归一化角点位移 <= 该值时视为「同一目标」。 */
const STICK_DIST = 0.22
/** 黏性候选的置信度加成：> 0.1 的置信度差距才能把选框从上一帧目标上抢走。 */
const STICK_BONUS = 0.1
/** AI（ML）两次推理之间的最小间隔：避免慢速推理拖慢实时跟随。 */
const ML_MIN_INTERVAL_MS = 300
/** worker 内上一次 ML 推理完成时间（模块级，跨请求保持）。 */
let lastMlRunAt = 0

/**
 * 主入口：输入 RGBA ImageData，返回最佳检测结果或 null。
 *
 * 追踪保留全帧面积和评分尺度，priorQuad 参与候选择优，不提前返回 ROI。
 */
export async function detectPaper(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  opts: DetectOptions = {},
): Promise<PaperDetection | null> {
  const W = rgba.width
  const H = rgba.height
  if (W < 16 || H < 16) return null
  // Keep geometry/area scores in full-frame coordinates. An early ROI return can
  // lock onto a text block and changes the meaning of min/maxAreaRatio each frame.
  return detectPaperCore(rgba, opts)
}

/**
 * 把上一帧选框扩成局部搜索窗口（像素坐标）。扩边 40%（至少 8% 帧宽高），
 * 让慢速移动的目标仍留在窗口内；窗口盖满全帧或目标异常小时返回 null（走整帧）。
 */
function priorToRoi(prior: Quad, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const p of prior) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const pw = Math.max(1e-6, maxX - minX)
  const ph = Math.max(1e-6, maxY - minY)
  const mx = Math.max(pw * 0.4, 0.08)
  const my = Math.max(ph * 0.4, 0.08)
  const x0 = Math.max(0, minX - mx)
  const y0 = Math.max(0, minY - my)
  const x1 = Math.min(1, maxX + mx)
  const y1 = Math.min(1, maxY + my)
  if (x1 - x0 < 0.12 || y1 - y0 < 0.12) return null
  if (x0 <= 0 && y0 <= 0 && x1 >= 1 && y1 >= 1) return null // 窗口=全帧，无意义
  const x = Math.floor(x0 * W)
  const y = Math.floor(y0 * H)
  const w = Math.max(16, Math.min(W, Math.ceil(x1 * W)) - x)
  const h = Math.max(16, Math.min(H, Math.ceil(y1 * H)) - y)
  return { x, y, w, h }
}

/** 按 ROI 裁剪 RGBA。 */
function cropRgba(
  src: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  roi: { x: number; y: number; w: number; h: number },
): { width: number; height: number; data: Uint8ClampedArray } | null {
  const { x, y, w, h } = roi
  const out = new Uint8ClampedArray(w * h * 4)
  for (let j = 0; j < h; j++) {
    const sOff = (y + j) * src.width * 4 + x * 4
    out.set(src.data.subarray(sOff, sOff + w * 4), j * w * 4)
  }
  return { width: w, height: h, data: out }
}

/** ROI 内归一化 quad → 全帧归一化 quad。 */
function mapQuadBack(
  quad: Quad,
  roi: { x: number; y: number; w: number; h: number },
  cw: number,
  ch: number,
  W: number,
  H: number,
): Quad {
  return [
    { x: (roi.x + quad[0]!.x * cw) / W, y: (roi.y + quad[0]!.y * ch) / H },
    { x: (roi.x + quad[1]!.x * cw) / W, y: (roi.y + quad[1]!.y * ch) / H },
    { x: (roi.x + quad[2]!.x * cw) / W, y: (roi.y + quad[2]!.y * ch) / H },
    { x: (roi.x + quad[3]!.x * cw) / W, y: (roi.y + quad[3]!.y * ch) / H },
  ] as unknown as Quad
}

/** 单帧检测核心（无追踪上下文）：灰度/模糊 → 经典候选 →（可选）AI 兜底 → 择优。 */
async function detectPaperCore(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  opts: DetectOptions,
): Promise<PaperDetection | null> {
  const merged = {
    minAreaRatio: opts.minAreaRatio ?? DEFAULTS.minAreaRatio,
    maxAreaRatio: opts.maxAreaRatio ?? DEFAULTS.maxAreaRatio,
    minAspect: opts.minAspect ?? DEFAULTS.minAspect,
    maxAspect: opts.maxAspect ?? DEFAULTS.maxAspect,
    mlThreshold: opts.mlThreshold ?? DEFAULTS.mlThreshold,
    strategies: opts.strategies ?? DEFAULTS.strategies,
    priorQuad: opts.priorQuad ?? DEFAULTS.priorQuad,
  }
  const { width: W, height: H } = rgba
  if (W < 16 || H < 16) return null
  const t0 = performanceNow()

  // 0) 灰度 + 5x5 高斯模糊（亮 / 边缘策略共用）
  const gray = grayscale(rgba)
  const blurred = gaussianBlur5x5(gray, W, H)

  // 1) 经典策略（同步、毫秒级）：实时跟随的主路径，收集全部命中
  //    bright 同时评估「白纸对暗背景」与「深色纸张对亮背景」两种极性；
  //    edge 输出最强的边缘闭合四边形。
  const candidates: PaperDetection[] = []
  for (const strategy of merged.strategies) {
    if (strategy === 'edge') {
      for (const r of detectByEdges(blurred, W, H, merged, t0)) {
        if (r) candidates.push(r)
      }
    } else if (strategy === 'bright') {
      for (const r of detectByBrightness(blurred, W, H, merged, t0)) {
        if (r) candidates.push(r)
      }
    }
  }

  // Direct callers await ML here. The live detector isolates this path in a
  // second worker; its result can only guide a new current-frame contour search.
  const wantMl = merged.strategies.includes('ml')
  if (wantMl) {
    const r = await detectByML(rgba, W, H, merged, t0)
    if (r) candidates.push(r)
  }

  if (opts.proposalQuad) {
    const proposed = await detectProposal(rgba, opts.proposalQuad, merged)
    if (proposed) candidates.push(proposed)
  }

  // 3) 目标黏性 + 置信度选优：
  //    与上一帧选框接近的候选获得黏性加成（保持同一目标、抑制候选交替跳框）；
  //    但远处候选若置信度显著更高（目标真的移动/换目标），加成挡不住它——
  //    避免选框钉在上一帧位置的陈旧候选上、跟不上移动中的书本。
  let best: PaperDetection | null = null
  if (candidates.length > 0) {
    const prior = merged.priorQuad
    best = candidates[0]!
    let bestScore = -Infinity
    for (const c of candidates) {
      let score = c.confidence
      if (prior) {
        const delta = quadCornerDelta(prior, c.quad)
        if (delta <= STICK_DIST) score += STICK_BONUS
      }
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
  }
  if (!best) return null

  return {
    quad: best.quad,
    confidence: best.confidence,
    ms: performanceNow() - t0,
    strategy: best.strategy,
  }
}

/* ------------------------------------------------------------------ *
 * 预处理：灰度 + 5x5 高斯模糊
 * ------------------------------------------------------------------ */
function grayscale(rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): Uint8Array {
  const W = rgba.width
  const totalPx = W * rgba.height
  const out = new Uint8Array(totalPx)
  const data = rgba.data
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    out[p] = (r * 299 + g * 587 + b * 114) >> 10
  }
  return out
}

/** 5x5 高斯（σ≈1.0），归一化卷积核 273。边界像素用 clamp-to-edge。 */
function gaussianBlur5x5(src: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(src.length)
  // 归一化系数（除以 273 = 16+26*2+41*4+26*4+16*4+... 的和）
  const kernel = [
    [1, 4, 7, 4, 1],
    [4, 16, 26, 16, 4],
    [7, 26, 41, 26, 7],
    [4, 16, 26, 16, 4],
    [1, 4, 7, 4, 1],
  ]
  const idx = (x: number, y: number) => Math.max(0, Math.min(W - 1, x)) + Math.max(0, Math.min(H - 1, y)) * W

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          sum += src[idx(x + kx, y + ky)]! * kernel[ky + 2]![kx + 2]!
        }
      }
      out[y * W + x] = sum / 273
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 策略 0：AI 物体检测（transformers.js，YOLOS/DETR 系）——仅作兜底。
 * detectByML 负责 worker 节流；真正推理在 detectByMLInner。
 * ------------------------------------------------------------------ */
async function detectByML(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number; mlThreshold: number },
  t0: number,
): Promise<PaperDetection | null> {
  const state = getMLStatus().state
  // 模型未就绪：后台触发加载（fire-and-forget，不阻塞本帧），让经典识别继续实时跟随；
  // 状态机 off→loading→ready/failed 由 detector-ml 自管，失败自带冷却。
  if (state !== 'ready') {
    // 无 OffscreenCanvas 的环境（Node 单测等）无法推理，跳过预热避免后台网络请求
    if (state !== 'loading' && typeof OffscreenCanvas !== 'undefined') {
      void getMLPipeline().catch(() => undefined)
    }
    return null
  }
  // 模型已就绪：按节流间隔执行真推理（慢帧仅出现在真正需要 AI 兜底时）
  if (performanceNow() - lastMlRunAt < ML_MIN_INTERVAL_MS) return null
  const result = await detectByMLInner(rgba, W, H, opts, t0)
  lastMlRunAt = performanceNow()
  return result
}

async function detectByMLInner(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number; mlThreshold: number },
  t0: number,
): Promise<PaperDetection | null> {
  // 冷却期快速失败：pipeline 上次加载失败后 RETRY_COOLDOWN_MS 内不重试，
  // 直接静默返回 null —— 否则 AI 开启期间会重复尝试下载模型并在控制台刷屏
  // （getMLPipeline 内部同样带冷却，这里提前省掉像素拷贝开销）。
  // 冷却结束后本函数照常放行，让 getMLPipeline 自动重试一次。
  if (isMLRetryCooldown()) return null

  // ML 推理需要 OffscreenCanvas（Transformers.js 不直接吃 ImageData）
  let canvas: OffscreenCanvas | null = null
  try {
    canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const imageData = new ImageData(new Uint8ClampedArray(rgba.data), W, H)
    ctx.putImageData(imageData, 0, 0)
  } catch {
    return null
  }

  let candidates
  try {
    const { detectRectangles, candidateToDetection } = await import('./detector-ml')
    candidates = await detectRectangles(canvas, W, H, undefined, { threshold: opts.mlThreshold })
    if (candidates.length === 0) return null

    // 按业务约束（宽高比 + 面积）过滤，选最大的（最像"占据画面"的物体）
    let best: PaperDetection | null = null
    for (const c of candidates) {
      if (c.aspect < opts.minAspect || c.aspect > opts.maxAspect) continue
      if (c.areaRatio < opts.minAreaRatio || c.areaRatio > opts.maxAreaRatio) continue
      // A COCO bounding box is a proposal, never a document quadrilateral.
      // Recover a contour in the same frame before allowing it to become a crop.
      const local = await detectProposal(rgba, c.quad, opts)
      if (!local) continue
      const detection = { ...candidateToDetection(c), quad: local.quad, confidence: local.confidence }
      if (!best || detection.confidence > best.confidence) {
        best = detection
      }
    }
    if (!best) return null

    return {
      quad: best.quad,
      confidence: best.confidence,
      ms: performanceNow() - t0,
      strategy: 'ml' as const,
    }
  } catch (error) {
    // ML 加载失败（模型源不通、模型下载超时、webgpu 不可用等）→ 安静退化
    // eslint-disable-next-line no-console
    console.warn('[paper-detector] ML strategy failed:', (error as Error)?.message ?? error, '\n', error)
    return null
  }
}

/** Validate a proposal using current pixels, retaining full-frame area/score units. */
async function detectProposal(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  proposal: Quad,
  opts: DetectOptions,
): Promise<PaperDetection | null> {
  const { width: W, height: H } = rgba
  const roi = priorToRoi(proposal, W, H)
  if (!roi) return null
  const crop = cropRgba(rgba, roi)
  if (!crop) return null
  const fraction = crop.width * crop.height / (W * H)
  const local = await detectPaperCore(crop, {
    ...opts, strategies: ['bright', 'edge'], priorQuad: null, proposalQuad: null,
    minAreaRatio: (opts.minAreaRatio ?? DEFAULTS.minAreaRatio) / fraction,
    maxAreaRatio: 0.95,
  })
  if (!local) return null
  const quad = mapQuadBack(local.quad, roi, crop.width, crop.height, W, H)
  const area = polygonArea(quad)
  if (area < (opts.minAreaRatio ?? DEFAULTS.minAreaRatio)
    || area > (opts.maxAreaRatio ?? DEFAULTS.maxAreaRatio)
    || quadCornerDelta(quad, proposal) > 0.15) return null
  return { ...local, quad, confidence: local.confidence * fraction, strategy: 'ml' }
}

/* ------------------------------------------------------------------ *
 * 策略 1：亮度 + Otsu（双极性）
 * ------------------------------------------------------------------ */
type Polarity = 'white' | 'dark'

/**
 * 亮度分割策略：同一 Otsu 阈值把画面分成亮/暗两簇，各作为一次前景尝试——
 * 既覆盖「白纸对暗背景」，也覆盖「深色笔记本对亮桌面」。
 * 返回 0..2 个候选（各自经过面积/宽高比/亮度一致性过滤）。
 */
function detectByBrightness(
  gray: Uint8Array,
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number },
  t0: number,
): PaperDetection[] {
  const totalPx = W * H
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++
  const threshold = otsuThreshold(hist, totalPx)

  const out: PaperDetection[] = []
  const polarities: Array<{ polarity: Polarity; mask: Uint8Array }> = []
  // Printed text can dominate Otsu's dark cluster. Split the remaining bright
  // cluster once more to separate a low-contrast page from its background.
  const upperHist = hist.slice()
  let upperCount = totalPx
  for (let i = 0; i < Math.ceil(threshold); i++) {
    upperCount -= upperHist[i]!
    upperHist[i] = 0
  }
  const upperThreshold = upperCount > 0 ? otsuThreshold(upperHist, upperCount) : threshold
  for (const cut of new Set([threshold, ...(upperThreshold > threshold ? [upperThreshold] : [])])) {
    const whiteMask = new Uint8Array(totalPx)
    const darkMask = new Uint8Array(totalPx)
    for (let i = 0; i < totalPx; i++) {
      if (gray[i]! >= cut) whiteMask[i] = 1
      else darkMask[i] = 1
    }
    polarities.push({ polarity: 'white', mask: whiteMask })
    if (cut === threshold) polarities.push({ polarity: 'dark', mask: darkMask })
  }

  for (const { polarity, mask } of polarities) {
    morphologicalClose(mask, W, H, 3, 1)
    // 不只取最大连通域：把前几大都交给 finalizeDetection 评分，
    // 让「矩形度 × 反背景」选出真正的纸张，而不是被最大的背景/桌面压过。
    for (const largest of topComponents(mask, W, H, BRIGHT_CANDIDATES)) {
      const r = finalizeDetection(largest, gray, W, H, opts, t0, 'bright', polarity)
      if (r) out.push(r)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 策略 2：Canny 边缘 + 膨胀 + 连通域
 * ------------------------------------------------------------------ */
function detectByEdges(
  gray: Uint8Array,
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number },
  t0: number,
): PaperDetection[] {
  const totalPx = W * H

  // 1) Sobel 梯度
  const mag = new Float32Array(totalPx)
  const dir = new Uint8Array(totalPx) // 0=0°, 1=45°, 2=90°, 3=135°
  sobel(gray, W, H, mag, dir)

  // 2) 非极大值抑制
  const suppressed = nonMaxSuppression(mag, dir, W, H)

  // 3) 双阈值（用 Otsu 在梯度幅值上选 high）
  const highThreshold = otsuFloat(suppressed) * 0.7
  const lowThreshold = highThreshold * 0.4

  // 4) 滞后（强 + 弱 → 通过弱找连通强）
  const edges = hysteresis(suppressed, lowThreshold, highThreshold, W, H)

  // 5) 膨胀（闭合边缘缝隙）
  dilateMask(edges, W, H, 3)

  // 6) 连通域：同样取 Top-N，让「墙/桌面边界」这类大背景与「纸张矩形」一起评分，
  //    复合分（矩形度 × 反背景）再决定谁更像纸；只取最大边缘区域会框住整幅背景。
  const out: PaperDetection[] = []
  for (const largest of topComponents(edges, W, H, EDGE_CANDIDATES)) {
    const r = finalizeDetection(largest, gray, W, H, opts, t0, 'edge', 'edge')
    if (r) out.push(r)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Otsu 自动阈值（亮度 [0..255] 与浮点梯度幅值共用）
 * ------------------------------------------------------------------ */
function otsuThreshold(hist: Uint32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]!

  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
  let bestMB = 0
  let bestMF = 0

  for (let t = 0; t < 256; t++) {
    wB += hist[t]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const variance = wB * wF * (mB - mF) * (mB - mF)
    if (variance > maxVar) {
      maxVar = variance
      threshold = t
      bestMB = mB
      bestMF = mF
    }
  }
  const mid = Math.round((bestMB + bestMF) / 2)
  if (mid > 0 && mid < 256) return mid
  return threshold
}

/** 浮点数组的 Otsu：基于 64 bin 直方图。返回最优阈值。 */
function otsuFloat(values: Float32Array): number {
  const total = values.length
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < total; i++) {
    const v = values[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  if (max - min < 1e-6) return min
  const bins = 64
  const hist = new Uint32Array(bins)
  const scale = (bins - 1) / (max - min)
  for (let i = 0; i < total; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.round((values[i]! - min) * scale)))
    hist[b]!++
  }
  let sum = 0
  for (let i = 0; i < bins; i++) sum += i * hist[i]!
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let bestB = 0
  let bestMB = 0
  let bestMF = 0
  for (let t = 0; t < bins; t++) {
    wB += hist[t]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const variance = wB * wF * (mB - mF) * (mB - mF)
    if (variance > maxVar) {
      maxVar = variance
      bestB = t
      bestMB = mB
      bestMF = mF
    }
  }
  const mid = (bestMB + bestMF) / 2
  if (mid > 0 && mid < bins) return min + mid / scale
  return min + bestB / scale
}

/* ------------------------------------------------------------------ *
 * Sobel 梯度 + 非极大值抑制 + 滞后 + 膨胀
 * ------------------------------------------------------------------ */
function sobel(gray: Uint8Array, W: number, H: number, mag: Float32Array, dir: Uint8Array): void {
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      // 3x3 Sobel
      const tl = gray[i - W - 1]!
      const tc = gray[i - W]!
      const tr = gray[i - W + 1]!
      const ml = gray[i - 1]!
      const mr = gray[i + 1]!
      const bl = gray[i + W - 1]!
      const bc = gray[i + W]!
      const br = gray[i + W + 1]!
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br
      mag[i] = Math.abs(gx) + Math.abs(gy)
      // Compare along the gradient, with sector boundaries at 22.5° and 67.5°.
      const ax = Math.abs(gx)
      const ay = Math.abs(gy)
      if (ay <= ax * Math.tan(Math.PI / 8)) dir[i] = 0
      else if (ax <= ay * Math.tan(Math.PI / 8)) dir[i] = 2
      else dir[i] = gx * gy >= 0 ? 1 : 3
    }
  }
}

function nonMaxSuppression(mag: Float32Array, dir: Uint8Array, W: number, H: number): Float32Array {
  const out = new Float32Array(mag.length)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const m = mag[i]!
      if (m === 0) continue
      const d = dir[i]!
      let n1 = 0
      let n2 = 0
      // 0° → 水平边，比较左右
      // 1° → 45°，比较 TL/BR
      // 2° → 垂直，比较上下
      // 3° → 135°，比较 TR/BL
      switch (d) {
        case 0: n1 = mag[i - 1]!; n2 = mag[i + 1]!; break
        case 1: n1 = mag[i - W - 1]!; n2 = mag[i + W + 1]!; break
        case 2: n1 = mag[i - W]!; n2 = mag[i + W]!; break
        case 3: n1 = mag[i - W + 1]!; n2 = mag[i + W - 1]!; break
      }
      if (m >= n1 && m >= n2) out[i] = m
    }
  }
  return out
}

function hysteresis(suppressed: Float32Array, low: number, high: number, W: number, H: number): Uint8Array {
  const out = new Uint8Array(suppressed.length)
  const visited = new Uint8Array(suppressed.length)
  const stack: number[] = []

  // Step 1: 强边缘入栈
  for (let i = 0; i < suppressed.length; i++) {
    if (suppressed[i]! >= high) {
      out[i] = 1
      visited[i] = 1
      stack.push(i)
    }
  }

  // Step 2: BFS，沿 8 邻接扩散到弱边缘
  while (stack.length > 0) {
    const cur = stack.pop()!
    const x = cur % W
    const y = (cur - x) / W
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
        const ni = ny * W + nx
        if (visited[ni]) continue
        if (suppressed[ni]! >= low) {
          out[ni] = 1
          visited[ni] = 1
          stack.push(ni)
        }
      }
    }
  }
  return out
}

function dilateMask(mask: Uint8Array, W: number, H: number, radius: number): void {
  const tmp = new Uint8Array(mask.length)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let any = 0
      for (let dy = -radius; dy <= radius && !any; dy++) {
        for (let dx = -radius; dx <= radius && !any; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
          if (mask[ny * W + nx]) { any = 1; break }
        }
      }
      tmp[y * W + x] = any
    }
  }
  mask.set(tmp)
}

/* ------------------------------------------------------------------ *
 * 形态学闭运算 = 膨胀 + 腐蚀（3x3 kernel，1 轮）
 * ------------------------------------------------------------------ */
function morphologicalClose(mask: Uint8Array, W: number, H: number, radius: number, iterations: number): void {
  for (let i = 0; i < iterations; i++) {
    dilateMask(mask, W, H, radius)
    erodeMask(mask, W, H, radius)
  }
}

function erodeMask(mask: Uint8Array, W: number, H: number, radius: number): void {
  const tmp = new Uint8Array(mask.length)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let all = 1
      for (let dy = -radius; dy <= radius && all; dy++) {
        for (let dx = -radius; dx <= radius && all; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) {
            all = 0; break
          }
          if (!mask[ny * W + nx]) { all = 0; break }
        }
      }
      tmp[y * W + x] = all
    }
  }
  mask.set(tmp)
}

/* ------------------------------------------------------------------ *
 * 连通域标记（两遍 + union-find）
 * ------------------------------------------------------------------ */
interface Component {
  label: number
  pixelCount: number
  bbox: { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number }
  border: Pt[]
}

/**
 * 提取面积最大的 `maxCount` 个连通域（按像素数降序）。
 *
 * 之所以「取 Top-N」而不是只取最大的一个：真实场景里最大的前景往往不是纸——
 * 比如整幅亮桌面、拉开到画面边缘的床单、发亮的墙带。这些背景连通域面积巨大，
 * 只在「最大连通域」策略下必然压过纸张；把前几大都拿来评分，让「矩形度 × 反背景
 * （贴画框）× 面积」的复合分去决定谁更像纸，才能从大背景里把真正的文档捞出来。
 *
 * 只对返回的 Top-N 计算边界点（凸包 / DP 的输入），避免为大量小碎块做无谓开销。
 */
function topComponents(mask: Uint8Array, W: number, H: number, maxCount: number): Component[] {
  const n = W * H
  const labels = new Int32Array(n)
  const parent: number[] = [0]
  let nextLabel = 1

  function find(x: number): number {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    let cur = x
    while (parent[cur] !== r) {
      const next = parent[cur]!
      parent[cur] = r
      cur = next
    }
    return r
  }
  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!mask[i]) continue
      const top = y > 0 ? labels[(y - 1) * W + x]! : 0
      const left = x > 0 ? labels[y * W + (x - 1)]! : 0
      if (top === 0 && left === 0) {
        labels[i] = nextLabel
        parent[nextLabel] = nextLabel
        nextLabel++
      } else if (top !== 0 && left === 0) {
        labels[i] = top
      } else if (top === 0 && left !== 0) {
        labels[i] = left
      } else {
        const min = Math.min(top, left)
        labels[i] = min
        if (top !== left) union(top, left)
      }
    }
  }

  const rootOf = new Int32Array(nextLabel)
  for (let i = 1; i < nextLabel; i++) rootOf[i] = find(i)

  const pixelCount = new Map<number, number>()
  const bboxMinX = new Map<number, number>()
  const bboxMaxX = new Map<number, number>()
  const bboxMinY = new Map<number, number>()
  const bboxMaxY = new Map<number, number>()

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = labels[y * W + x]!
      if (!l) continue
      const r = rootOf[l]!
      pixelCount.set(r, (pixelCount.get(r) ?? 0) + 1)
      bboxMinX.set(r, Math.min(bboxMinX.get(r) ?? x, x))
      bboxMaxX.set(r, Math.max(bboxMaxX.get(r) ?? x, x))
      bboxMinY.set(r, Math.min(bboxMinY.get(r) ?? y, y))
      bboxMaxY.set(r, Math.max(bboxMaxY.get(r) ?? y, y))
    }
  }

  const all: Component[] = []
  for (const [label, count] of pixelCount) {
    all.push({
      label,
      pixelCount: count,
      bbox: {
        minX: bboxMinX.get(label) ?? 0,
        minY: bboxMinY.get(label) ?? 0,
        maxX: bboxMaxX.get(label) ?? 0,
        maxY: bboxMaxY.get(label) ?? 0,
        w: (bboxMaxX.get(label) ?? 0) - (bboxMinX.get(label) ?? 0) + 1,
        h: (bboxMaxY.get(label) ?? 0) - (bboxMinY.get(label) ?? 0) + 1,
      },
      border: [],
    })
  }
  all.sort((a, b) => b.pixelCount - a.pixelCount)
  const top = all.slice(0, maxCount)

  for (const comp of top) {
    comp.border = buildComponentBorder(comp, labels, rootOf, mask, W)
  }
  return top
}

/** 收集单个连通域的边界像素（凸包 / Douglas-Peucker 的输入）。 */
function buildComponentBorder(
  comp: Component,
  labels: Int32Array,
  rootOf: Int32Array,
  mask: Uint8Array,
  W: number,
): Pt[] {
  const b = comp.bbox
  const border: Pt[] = []
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) {
      if (rootOf[labels[y * W + x]!] !== comp.label) continue
      if (
        x === b.minX
        || x === b.maxX
        || y === b.minY
        || y === b.maxY
        || !mask[(y - 1) * W + x]
        || !mask[(y + 1) * W + x]
        || !mask[y * W + (x - 1)]
        || !mask[y * W + (x + 1)]
      ) {
        border.push({ x, y })
      }
    }
  }
  return border
}

/* ------------------------------------------------------------------ *
 * 最终化：凸包 + Douglas-Peucker + 排序 + 质量评分
 * ------------------------------------------------------------------ */

/**
 * 检测四边形与画面边框的贴合程度（0..1）。
 * 背景/桌面等大块区域通常有大量边界像素贴在画面边框上，纸张通常不会——
 * 用于压低「把整个背景当成纸」的候选。
 */
function frameContactRatio(comp: Component, W: number, H: number): number {
  // 用连通域 bbox 是否贴着画面边框来度量（形态学闭会削掉边框上的像素环，
  // 用 border 像素数会漏判整幅背景）。背景/桌面通常四边贴框，纸张通常留白。
  let sides = 0
  if (comp.bbox.minX <= 4) sides++
  if (comp.bbox.minY <= 4) sides++
  if (comp.bbox.maxX >= W - 5) sides++
  if (comp.bbox.maxY >= H - 5) sides++
  return sides / 4
}

/**
 * 连通域边界像素贴合拟合四边形四条边的比例（0..1）。
 * 干净矩形 ≈ 0.85+，杂散团块明显更低 —— 用于把「矩形度」编进置信度。
 */
function edgeSupportRatio(border: Pt[], quad: Pt[], tol: number): number {
  if (border.length === 0) return 0
  const n = quad.length
  let matched = 0
  for (const p of border) {
    let minDist = Infinity
    for (let i = 0; i < n; i++) {
      const a = quad[i]!
      const b = quad[(i + 1) % n]!
      const d = perpDist(p, a, b)
      if (d < minDist) minDist = d
    }
    if (minDist <= tol) matched++
  }
  return matched / border.length
}

/**
 * 最终化一个候选：凸包 → DP 简化到 4 角 → 面积/宽高比/亮度极性过滤 →
 * 以面积 × 紧凑度 × 矩形度（边缘贴合）× 反背景（边框接触）编出置信度。
 * strategy 用于结果标记（'bright' / 'edge'）；polarity 只影响亮度一致性门槛。
 */
function finalizeDetection(
  largest: Component,
  gray: Uint8Array,
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number },
  t0: number,
  strategy: 'bright' | 'edge',
  polarity: Polarity | 'edge',
): PaperDetection | null {
  const totalPx = W * H
  // Edge components contain only a thin outline, not the enclosed paper pixels.
  if (largest.bbox.w * largest.bbox.h / totalPx < opts.minAreaRatio) return null

  const rawHull = convexHull(largest.border)
  if (rawHull.length < 4) return null
  // Closed DP always retains its starting point. The leftmost pixel can lie
  // halfway down a near-vertical edge after blur; anchor near a real corner.
  let anchor = 0
  for (let i = 1; i < rawHull.length; i++) {
    if (rawHull[i]!.x + rawHull[i]!.y < rawHull[anchor]!.x + rawHull[anchor]!.y) anchor = i
  }
  const hull = [...rawHull.slice(anchor), ...rawHull.slice(0, anchor)]

  // DP 化简到 4 个角点：容差从 0.5% 起步、逐步放大到 3%，让厚边带也能合并到 4 角
  let simplified: Pt[] = []
  const maxEdge = Math.max(W, H)
  for (const tol of [0.005, 0.01, 0.02, 0.03].map(m => m * maxEdge)) {
    const corners = douglasPeucker(hull, tol)
    if (corners.length !== 4) continue
    simplified = corners
    // A tight simplification may retain a rounded morphology corner. Try the
    // next tolerance if all four image edges cannot support that approximation.
    const refined = refinePaperQuad(gray, W, H, [corners[0]!, corners[1]!, corners[2]!, corners[3]!])
    if (refined) {
      simplified = [...refined]
      break
    }
  }
  if (simplified.length !== 4) return null

  const areaRatio = polygonArea(simplified) / totalPx
  if (areaRatio < opts.minAreaRatio || areaRatio > opts.maxAreaRatio) return null
  const normalized = simplified.map(p => ({ x: p.x / W, y: p.y / H }))
  const sorted = sortQuad(normalized as unknown as Quad)

  const aspect = quadAspect(simplified as unknown as Quad)
  if (aspect < opts.minAspect || aspect > opts.maxAspect) return null

  // 亮度一致性：亮极性候选应确实亮、暗极性候选应确实暗（防噪点把背景当纸）
  const avgBrightness = avgRegionBrightness(gray, W, largest)
  if (polarity === 'white' && avgBrightness < 96) return null
  if (polarity === 'dark' && avgBrightness > 255 - 96) return null

  const convexArea = polygonArea(simplified)
  const bboxArea = largest.bbox.w * largest.bbox.h
  const compactness = bboxArea > 0 ? convexArea / bboxArea : 0

  // 质量分：矩形度 × 反背景（越贴边框越像背景，压低置信度）。
  // 反背景用平方关系重罚：整幅背景/桌面通常贴画框 2~4 条边，面积虽大，
  // 但被 (1-contact)² 抵消后会被真正的纸张（贴边少）压下去。
  const contact = frameContactRatio(largest, W, H)
  // 大面积 + 贴画框多条边 → 几乎肯定是整幅背景/桌面，而非纸张，直接拒绝。
  if (contact >= 0.5 && areaRatio > 0.6) return null
  const support = edgeSupportRatio(largest.border, simplified, Math.max(1.5, 0.008 * maxEdge))
  const backgroundFactor = Math.max(0.1, (1 - contact) * (1 - contact))
  const quality = clamp01((0.6 + 0.4 * support) * backgroundFactor)

  // 评分：面积 × 紧凑度 × 矩形质量 × 策略权重（edge 在低对比场景更可靠）
  const strategyWeight = strategy === 'edge' ? 1.05 : 1.0
  const confidence = clamp01(areaRatio * compactness * 1.4 * strategyWeight * quality)

  return {
    quad: sorted,
    confidence,
    ms: performanceNow() - t0,
    strategy,
  }
}

function avgRegionBrightness(gray: Uint8Array, W: number, comp: Component): number {
  // 用连通域的边界像素估计平均亮度（避免扫整个 bbox）
  if (comp.border.length === 0) return 128
  let sum = 0
  for (const p of comp.border) {
    sum += gray[p.y * W + p.x]!
  }
  return sum / comp.border.length
}

/* ------------------------------------------------------------------ *
 * 凸包（Andrew's monotone chain）+ Douglas-Peucker
 * ------------------------------------------------------------------ */
function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice()
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y))
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function douglasPeucker(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  const closed = pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.y === pts[pts.length - 1]!.y
  const arr = closed ? pts.slice() : pts.concat([pts[0]!])

  function dp(start: number, end: number, keep: boolean[]): void {
    let maxDist = 0
    let maxIdx = -1
    const a = arr[start]!
    const b = arr[end]!
    for (let i = start + 1; i < end; i++) {
      const d = perpDist(arr[i]!, a, b)
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxIdx !== -1 && maxDist > tolerance) {
      keep[maxIdx] = true
      dp(start, maxIdx, keep)
      dp(maxIdx, end, keep)
    }
  }

  const keep = new Array<boolean>(arr.length).fill(false)
  keep[0] = true
  keep[arr.length - 1] = true
  dp(0, arr.length - 1, keep)
  const result = arr.filter((_, i) => keep[i])
  if (
    result.length >= 2
    && result[0]!.x === result[result.length - 1]!.x
    && result[0]!.y === result[result.length - 1]!.y
  ) {
    result.pop()
  }
  return result
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

/* ------------------------------------------------------------------ *
 * 排序为 TL/TR/BR/BL + 宽高比
 * ------------------------------------------------------------------ */
function sortQuad(quad: Quad): Quad {
  const pts: Pt[] = [...quad]
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let startIdx = 0
  let minSum = Infinity
  for (let i = 0; i < 4; i++) {
    const s = pts[i]!.x + pts[i]!.y
    if (s < minSum) {
      minSum = s
      startIdx = i
    }
  }
  const rotated = [...pts.slice(startIdx), ...pts.slice(0, startIdx)]
  return [rotated[0]!, rotated[1]!, rotated[2]!, rotated[3]!]
}

function quadAspect(quad: Quad): number {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  const [tl, tr, br, bl] = quad
  const width = (dist(tl, tr) + dist(bl, br)) / 2
  const height = (dist(tl, bl) + dist(tr, br)) / 2
  if (height <= 0) return 1
  return width / height
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function polygonArea(pts: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
