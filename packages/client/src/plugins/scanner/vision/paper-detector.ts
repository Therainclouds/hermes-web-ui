import type { Pt, Quad } from './types'

/**
 * 纯 JS 纸张边缘检测（多策略投票版）。
 *
 * 输入：RGBA 像素。输出：归一化 4 角点 + 置信度 + 耗时。
 *
 * 三策略并行投票：
 *   1) bright：白纸 vs 暗背景  → 灰度 + 高斯 + Otsu + 形态学闭 + 连通域
 *   2) dark  ：暗纸 vs 亮背景  → bright 策略 + 像素反相
 *   3) edge  ：Canny 边缘 + 膨胀 + 连通域（弱对比、图案背景的兜底）
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
  strategy: 'bright' | 'edge'
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
  /** 仅跑指定策略（调试用）。默认 ['bright', 'edge']。 */
  strategies?: ReadonlyArray<'bright' | 'edge'>
}

const DEFAULTS: Required<Omit<DetectOptions, 'strategies'>> & { strategies: ReadonlyArray<'bright' | 'edge'> } = {
  minAreaRatio: 0.05,
  maxAreaRatio: 0.85,
  minAspect: 0.3,
  maxAspect: 3.0,
  strategies: ['bright', 'edge'],
}

/** 主入口：输入 RGBA ImageData，返回最佳检测结果或 null。 */
export function detectPaper(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  opts: DetectOptions = {},
): PaperDetection | null {
  const merged = {
    minAreaRatio: opts.minAreaRatio ?? DEFAULTS.minAreaRatio,
    maxAreaRatio: opts.maxAreaRatio ?? DEFAULTS.maxAreaRatio,
    minAspect: opts.minAspect ?? DEFAULTS.minAspect,
    maxAspect: opts.maxAspect ?? DEFAULTS.maxAspect,
    strategies: opts.strategies ?? DEFAULTS.strategies,
  }
  const { width: W, height: H } = rgba
  if (W < 16 || H < 16) return null
  const t0 = performanceNow()

  // 0) 灰度 + 5x5 高斯模糊（多策略共用预处理）
  const gray = grayscale(rgba)
  const blurred = gaussianBlur5x5(gray, W, H)

  // 1) 多策略并行投票
  const candidates: PaperDetection[] = []
  for (const strategy of merged.strategies) {
    const grayForStrategy = blurred
    const result = strategy === 'edge'
      ? detectByEdges(grayForStrategy, W, H, merged, t0)
      : detectByBrightness(grayForStrategy, W, H, merged, t0, strategy)
    if (result) candidates.push(result)
  }

  if (candidates.length === 0) return null

  // 2) 按 (confidence) 选最优
  candidates.sort((a, b) => b.confidence - a.confidence)
  const best = candidates[0]!
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
 * 策略 1：亮度二值化（白纸）
 * ------------------------------------------------------------------ */
function detectByBrightness(
  gray: Uint8Array,
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number },
  t0: number,
  strategy: 'bright',
): PaperDetection | null {
  const totalPx = W * H
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++
  const threshold = otsuThreshold(hist, totalPx)

  // bright 策略：前景 = 高于阈值（白纸对暗背景）
  const mask = new Uint8Array(totalPx)
  for (let i = 0; i < totalPx; i++) {
    mask[i] = gray[i]! >= threshold ? 1 : 0
  }
  morphologicalClose(mask, W, H, 3, 1)
  const largest = largestComponent(mask, W, H)
  if (!largest) return null
  return finalizeDetection(largest, gray, W, H, opts, t0, strategy)
}

/* ------------------------------------------------------------------ *
 * 策略 3：Canny 边缘 + 膨胀 + 连通域
 * ------------------------------------------------------------------ */
function detectByEdges(
  gray: Uint8Array,
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number },
  t0: number,
): PaperDetection | null {
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

  // 6) 连通域
  const largest = largestComponent(edges, W, H)
  if (!largest) return null
  return finalizeDetection(largest, gray, W, H, opts, t0, 'edge')
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
      // 方向量化为 0/45/90/135°
      if (gx === 0 && gy === 0) {
        dir[i] = 0
      } else if (Math.abs(gx) >= Math.abs(gy)) {
        // 水平 / 135 度
        dir[i] = gx * gy >= 0 ? 0 : 3
      } else {
        // 垂直 / 45 度
        dir[i] = gx * gy >= 0 ? 1 : 2
      }
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

function largestComponent(mask: Uint8Array, W: number, H: number): Component | null {
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

  let best: Component | null = null
  for (const [label, count] of pixelCount) {
    if (best && count <= best.pixelCount) continue
    best = {
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
    }
  }
  if (!best) return null

  const border: Pt[] = []
  for (let y = best.bbox.minY; y <= best.bbox.maxY; y++) {
    for (let x = best.bbox.minX; x <= best.bbox.maxX; x++) {
      if (rootOf[labels[y * W + x]!] !== best.label) continue
      if (
        x === best.bbox.minX
        || x === best.bbox.maxX
        || y === best.bbox.minY
        || y === best.bbox.maxY
        || !mask[(y - 1) * W + x]
        || !mask[(y + 1) * W + x]
        || !mask[y * W + (x - 1)]
        || !mask[y * W + (x + 1)]
      ) {
        border.push({ x, y })
      }
    }
  }
  best.border = border
  return best
}

/* ------------------------------------------------------------------ *
 * 最终化：凸包 + Douglas-Peucker + 排序 + 评分
 * ------------------------------------------------------------------ */
function finalizeDetection(
  largest: Component,
  gray: Uint8Array,
  W: number,
  H: number,
  opts: { minAreaRatio: number; maxAreaRatio: number; minAspect: number; maxAspect: number },
  t0: number,
  strategy: 'bright' | 'edge',
): PaperDetection | null {
  const totalPx = W * H
  const areaRatio = largest.pixelCount / totalPx
  if (areaRatio < opts.minAreaRatio) return null
  if (areaRatio > opts.maxAreaRatio) return null

  const hull = convexHull(largest.border)
  if (hull.length < 4) return null

  // DP 化简到 4 个角点：容差从 0.5% 起步、逐步放大到 3%，让厚边带也能合并到 4 角
  let simplified: Pt[] = []
  const maxEdge = Math.max(W, H)
  for (const tol of [0.005, 0.01, 0.02, 0.03].map(m => m * maxEdge)) {
    simplified = douglasPeucker(hull, tol)
    if (simplified.length === 4) break
  }
  if (simplified.length !== 4) return null

  const normalized = simplified.map(p => ({ x: p.x / W, y: p.y / H }))
  const sorted = sortQuad(normalized as unknown as Quad)

  const aspect = quadAspect(simplified as unknown as Quad)
  if (aspect < opts.minAspect || aspect > opts.maxAspect) return null

  // 亮度一致性：bright 策略的检测区域应确实亮（防止噪点把暗区当纸）
  const avgBrightness = avgRegionBrightness(gray, W, largest)
  if (strategy === 'bright' && avgBrightness < 96) return null

  const convexArea = polygonArea(simplified)
  const bboxArea = largest.bbox.w * largest.bbox.h
  const compactness = bboxArea > 0 ? convexArea / bboxArea : 0
  // 评分：面积 × 紧凑度 × 策略权重（edge 在低对比场景更可靠）
  const strategyWeight = strategy === 'edge' ? 1.05 : 1.0
  const confidence = clamp01(areaRatio * compactness * 1.4 * strategyWeight)

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
function polygonArea(pts: Pt[]): number {
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