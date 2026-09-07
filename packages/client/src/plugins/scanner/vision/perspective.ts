import type { Pt, Quad } from './types'

/**
 * 纯 JS 透视矫正（真正的 3x3 单应性 / homography）。
 *
 * 之前这里用「沿对角线拆两个三角形 + 仿射」近似，四个角点虽然落位正确，
 * 但三角形内部是线性插值 —— 梯形形变（近大远小）根本没被解掉，还会在
 * 对角线上留下折痕。文档扫描必须用投影变换，所以现在的算法是主流方案：
 *
 *   1. 由「输出矩形 4 角 -> 源四边形 4 角」直接解 8 参数单应性矩阵 H
 *      （dst -> src，正好是反向映射所需的方向，省一次求逆）；
 *   2. 逐输出像素做 (x, y, 1) -> H -> (u/w, v/w) 的投影反查 + 双线性采样；
 *   3. 输出尺寸：默认按「消隐点法」估计纸张真实宽高比（Zhang & He,
 *      Whiteboard scanning），避免把斜拍的页面压成扁的；估计不稳定时
 *      回退到对边最大长度（OpenCV four-point transform 的经典做法）。
 */

export interface WarpOptions {
  /** 输出长边像素上限，默认 2000。 */
  maxEdge?: number
  /** 强制输出宽高比（宽/高）。null = 自动（消隐点估计 + 边长回退）。 */
  aspectRatio?: number | null
  /**
   * 源图像尺寸（像素）。提供后才能用消隐点法估计真实宽高比（需要主点 ≈ 图像中心）。
   * warpQuad 会自动带上，外部单独调用 computeWarpOutputSize 时可选。
   */
  imageSize?: { width: number; height: number } | null
}

/** 由源四边形与选项计算输出像素尺寸（不实际渲染）。 */
export function computeWarpOutputSize(
  srcQuad: Quad,
  opts: WarpOptions = {},
): { width: number; height: number } {
  const maxEdge = opts.maxEdge ?? 2000
  const natural = quadNaturalSize(srcQuad)
  if (natural.width < 1 || natural.height < 1) return { width: 2, height: 2 }

  const forced = opts.aspectRatio && opts.aspectRatio > 0 ? opts.aspectRatio : null
  const estimated = forced
    ? null
    : (opts.imageSize ? estimateQuadAspect(srcQuad, opts.imageSize.width, opts.imageSize.height) : null)
  const aspect = forced ?? estimated

  let width = natural.width
  let height = natural.height
  if (aspect) {
    // 保留信息量：不缩小任一维度，只把另一维度按目标比例放大。
    width = Math.max(width, height * aspect)
    height = width / aspect
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  }
}

interface SourceImage {
  width: number
  height: number
  /** RGBA8888 像素，长 = width * height * 4。 */
  data: Uint8ClampedArray
}

/**
 * 把 srcQuad 投影矫正成正矩形，返回 RGBA 像素缓冲（含输出尺寸）。
 * 输入支持任何带 { width, height, data } 形状的对象（ImageData / Canvas getImageData）。
 */
export function warpQuad(
  source: SourceImage,
  srcQuad: Quad,
  opts: WarpOptions = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  const { width: W, height: H } = computeWarpOutputSize(srcQuad, {
    ...opts,
    imageSize: opts.imageSize ?? { width: source.width, height: source.height },
  })
  const dst = new Uint8ClampedArray(W * H * 4)

  // dst 矩形 -> src 四边形的单应性（直接就是反向映射矩阵）
  const H3 = homography(
    [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ],
    srcQuad,
  )
  if (!H3) return { width: W, height: H, data: dst }

  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H3 as [
    number, number, number, number, number, number, number, number, number,
  ]

  for (let y = 0; y < H; y++) {
    const py = y + 0.5
    let i = y * W * 4
    for (let x = 0; x < W; x++, i += 4) {
      const px = x + 0.5
      const w = h6 * px + h7 * py + h8
      if (w === 0) continue
      const sx = (h0 * px + h1 * py + h2) / w
      const sy = (h3 * px + h4 * py + h5) / w
      bilinearSampleInto(source, sx - 0.5, sy - 0.5, dst, i)
    }
  }

  return { width: W, height: H, data: dst }
}

/* ------------------------------------------------------------------ *
 * 单应性求解
 * ------------------------------------------------------------------ */
/**
 * 由 4 对点解 3x3 单应性（h8 固定为 1，8 未知量高斯消元）。
 * 返回行优先的 9 个元素；退化配置返回 null。
 */
export function homography(from: readonly Pt[], to: readonly Pt[]): number[] | null {
  if (from.length < 4 || to.length < 4) return null
  // A * h = b，A 为 8x8
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const s = from[i]!
    const d = to[i]!
    A.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x])
    b.push(d.x)
    A.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y])
    b.push(d.y)
  }
  const h = solveLinearSystem(A, b)
  if (!h) return null
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1]
}

/** 带部分选主元的高斯消元；奇异矩阵返回 null。 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    let best = Math.abs(m[col]![col]!)
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]![col]!)
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (best < 1e-12) return null
    if (pivot !== col) {
      const tmp = m[col]!
      m[col] = m[pivot]!
      m[pivot] = tmp
    }
    const pivotRow = m[col]!
    const inv = 1 / pivotRow[col]!
    for (let c = col; c <= n; c++) pivotRow[c] = pivotRow[c]! * inv
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const row = m[r]!
      const factor = row[col]!
      if (factor === 0) continue
      for (let c = col; c <= n; c++) row[c] = row[c]! - factor * pivotRow[c]!
    }
  }
  return m.map(row => row[n]!)
}

/* ------------------------------------------------------------------ *
 * 宽高比估计（消隐点法）
 * ------------------------------------------------------------------ */
/**
 * 由投影后的四边形反解原始矩形的宽高比（Zhang & He, Whiteboard scanning）。
 *
 * 思路：矩形的两组对边在图像里交于两个消隐点，消隐点约束了相机焦距 f；
 * 有了 f 就能算出真实的 宽/高。这样斜拍的 A4 才不会被拉成方的。
 *
 * 返回 null 表示估计不可用（近似平行四边形 / 数值不稳定 / 结果离谱）。
 * quad 与图像尺寸必须是同一坐标系（像素）。
 */
export function estimateQuadAspect(
  quad: Quad,
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (!(imageWidth > 1) || !(imageHeight > 1)) return null
  const cx = imageWidth / 2
  const cy = imageHeight / 2
  // 主点移到原点：m1=左上, m2=右上, m3=左下, m4=右下
  const m1: Vec3 = [quad[0].x - cx, quad[0].y - cy, 1]
  const m2: Vec3 = [quad[1].x - cx, quad[1].y - cy, 1]
  const m3: Vec3 = [quad[3].x - cx, quad[3].y - cy, 1]
  const m4: Vec3 = [quad[2].x - cx, quad[2].y - cy, 1]

  const k2Den = dot(cross(m2, m4), m3)
  const k3Den = dot(cross(m3, m4), m2)
  if (Math.abs(k2Den) < 1e-9 || Math.abs(k3Den) < 1e-9) return null
  const k2 = dot(cross(m1, m4), m3) / k2Den
  const k3 = dot(cross(m1, m4), m2) / k3Den

  // k ≈ 1 表示对边在图像里仍然平行（正拍 / 平行四边形）：没有透视信息可用
  if (Math.abs(k2 - 1) < 1e-3 && Math.abs(k3 - 1) < 1e-3) return null

  const n2: Vec3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]]
  const n3: Vec3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]]
  const denom = n2[2] * n3[2]
  if (Math.abs(denom) < 1e-9) return null
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / denom
  if (!Number.isFinite(f2) || f2 <= 1e-6) return null

  const num = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2]
  const den = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2]
  if (!(den > 1e-12) || !(num > 1e-12)) return null
  const aspect = Math.sqrt(num / den)
  if (!Number.isFinite(aspect) || aspect < 0.15 || aspect > 6.5) return null
  return aspect
}

type Vec3 = [number, number, number]

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/* ------------------------------------------------------------------ *
 * 采样
 * ------------------------------------------------------------------ */
/** 双线性采样并写入目标缓冲（越界写不透明白，避免 PDF 里出现黑边）。 */
function bilinearSampleInto(
  source: SourceImage,
  x: number,
  y: number,
  dst: Uint8ClampedArray,
  o: number,
): void {
  const { width: W, height: H, data } = source
  if (x < -1 || y < -1 || x > W || y > H) {
    dst[o] = 255
    dst[o + 1] = 255
    dst[o + 2] = 255
    dst[o + 3] = 255
    return
  }
  const cx = x < 0 ? 0 : x > W - 1 ? W - 1 : x
  const cy = y < 0 ? 0 : y > H - 1 ? H - 1 : y
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, W - 1)
  const y1 = Math.min(y0 + 1, H - 1)
  const fx = cx - x0
  const fy = cy - y0

  const i00 = (y0 * W + x0) * 4
  const i10 = (y0 * W + x1) * 4
  const i01 = (y1 * W + x0) * 4
  const i11 = (y1 * W + x1) * 4

  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy

  dst[o] = data[i00]! * w00 + data[i10]! * w10 + data[i01]! * w01 + data[i11]! * w11
  dst[o + 1] = data[i00 + 1]! * w00 + data[i10 + 1]! * w10 + data[i01 + 1]! * w01 + data[i11 + 1]! * w11
  dst[o + 2] = data[i00 + 2]! * w00 + data[i10 + 2]! * w10 + data[i01 + 2]! * w01 + data[i11 + 2]! * w11
  dst[o + 3] = 255
}

function quadNaturalSize(quad: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = quad
  const w = Math.max(dist(tl, tr), dist(bl, br))
  const h = Math.max(dist(tl, bl), dist(tr, br))
  return { width: w, height: h }
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
