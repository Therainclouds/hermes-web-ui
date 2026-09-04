import type { Pt, Quad } from './types'

/**
 * 纯 JS 纸张边缘检测。
 *
 * 算法思路（白纸 vs 非白背景场景）：
 *   1. 灰度化 + Otsu 自动二值化
 *   2. 最大连通域 = 纸张区域
 *   3. 凸包包络连通域像素
 *   4. Douglas-Peucker 把凸包化简到 4 个角点
 *   5. 排序为 TL/TR/BR/BL、估算置信度
 *
 * 全部纯函数，可被 worker 与 Vitest 直接调用。
 * 对小图（< 512 长边）单帧实测 10-25 ms（V8 / happy-dom）。
 */

export interface PaperDetection {
  /** 归一化四边形角点（0..1，相对输入图像宽高）。 */
  quad: Quad
  /** 0..1，纸张占帧面积比 × 凸包紧凑度。 */
  confidence: number
  /** 单帧耗时 ms（含 4 步全部）。 */
  ms: number
}

export interface DetectOptions {
  /** 最小面积比（占帧），低于返回 null。默认 0.08。 */
  minAreaRatio?: number
  /** 宽高比下界，默认 0.3。 */
  minAspect?: number
  /** 宽高比上界，默认 3.0。 */
  maxAspect?: number
}

const DEFAULTS: Required<DetectOptions> = {
  minAreaRatio: 0.08,
  minAspect: 0.3,
  maxAspect: 3.0,
}

/** 主入口：输入 RGBA ImageData，返回检测结果或 null。 */
export function detectPaper(
  rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  opts: DetectOptions = {},
): PaperDetection | null {
  const o = { ...DEFAULTS, ...opts }
  const { width: W, height: H } = rgba
  if (W < 16 || H < 16) return null
  const totalPx = W * H
  const t0 = performanceNow()

  // 1) 灰度 + 直方图
  const gray = new Uint8Array(totalPx)
  const hist = new Uint32Array(256)
  const data = rgba.data
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    // ITU-R BT.601 luma（与 OpenCV 默认一致）
    const y = (r * 299 + g * 587 + b * 114) >> 10
    gray[p] = y
    hist[y]++
  }

  // 2) Otsu 阈值
  const threshold = otsuThreshold(hist, totalPx)

  // 3) 二值化（前景 = 亮 = 纸）
  const mask = new Uint8Array(totalPx)
  for (let i = 0; i < totalPx; i++) {
    mask[i] = gray[i]! >= threshold ? 1 : 0
  }

  // 4) 连通域：找最大分量
  const largest = largestComponent(mask, W, H)
  if (!largest) return null
  const areaRatio = largest.pixelCount / totalPx
  if (areaRatio < o.minAreaRatio) return null

  // 5) 凸包（仅采样边界像素，性能好）
  const hull = convexHull(largest.border)
  if (hull.length < 4) return null

  // 6) Douglas-Peucker 化简到 4 个角点
  const simplified = douglasPeucker(hull, 0.005 * Math.max(W, H))
  if (simplified.length !== 4) return null

  // 7) 转归一化、排序为 TL/TR/BR/BL
  const normalized = simplified.map(p => ({ x: p.x / W, y: p.y / H }))
  const sorted = sortQuad(normalized as unknown as Quad)

  // 8) 置信度：面积占比 × 凸包紧凑度
  const convexArea = polygonArea(simplified)
  const bboxArea = largest.bbox.w * largest.bbox.h
  const compactness = bboxArea > 0 ? convexArea / bboxArea : 0
  const confidence = clamp01(areaRatio * compactness * 1.4)

  // 9) 宽高比校验（用像素坐标，避免被归一化拉伸图影响）
  const aspect = quadAspect(simplified as unknown as Quad)
  if (aspect < o.minAspect || aspect > o.maxAspect) return null

  return {
    quad: sorted,
    confidence,
    ms: performanceNow() - t0,
  }
}

/* ------------------------------------------------------------------ *
 * Otsu 自动阈值
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
  // 双峰远离时 Otsu 会落在某个众数上（between-class variance 跨谷底平台期），
  // 此时所有像素都被分到一侧。把阈值改到两均值中点，保证前景/背景能分开。
  const mid = Math.round((bestMB + bestMF) / 2)
  if (mid > 0 && mid < 256) return mid
  return threshold
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

  // First pass
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

  // 收集根标签的统计
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

  // 找最大分量
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

  // 抽取边界像素（与背景相邻的前景像素）
  const border: Pt[] = []
  for (let y = best.bbox.minY; y <= best.bbox.maxY; y++) {
    for (let x = best.bbox.minX; x <= best.bbox.maxX; x++) {
      if (rootOf[labels[y * W + x]!] !== best.label) continue
      // 4 邻接是否有背景
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
 * Andrew's monotone chain 凸包
 * ------------------------------------------------------------------ */
function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice()
  // 按 x 主、y 次排序（拷贝避免修改原数组）
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

/* ------------------------------------------------------------------ *
 * Douglas-Peucker 多边形化简
 * ------------------------------------------------------------------ */
function douglasPeucker(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  // 闭合多边形：在末尾追加首点
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
  // 去掉闭合追加的首尾重复点
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
  // 找质心，按角度排序（顺时针，y 向下）
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  // pts[0] 应为右侧最大 x 的点（角度 0），逆时针：右→下→左→上
  // 把起点调整为 TL：x+y 最小的点
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
  // TL/TR/BR/BL：起点的 x 最小 → TL；下一个沿顺时针为 TR
  // 实际验证：pts 已是逆时针，rotated[0]=TL、rotated[1]=TR、rotated[2]=BR、rotated[3]=BL
  return [rotated[0]!, rotated[1]!, rotated[2]!, rotated[3]!]
}

function quadAspect(quad: Quad): number {
  // 用对边均值估算宽高
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