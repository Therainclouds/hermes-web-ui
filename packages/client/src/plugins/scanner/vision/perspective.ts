import type { Pt, Quad } from './types'

/**
 * 纯 JS 透视矫正（仿射近似）。
 *
 * 不依赖 Canvas2D.setTransform 的双三角形仿射，对"接近平摊在桌面"
 * 的文档已足够（误差 < 1 像素）；若需全 3x3 单应性矩阵，可换 WebGL。
 *
 * 算法：
 *   1. 由 4 个源角点 + 4 个目标角点（外接矩形）算出输出宽高；
 *   2. 把四边形拆成两个三角形（沿对角线），逐三角形做仿射变换；
 *   3. 像素级反向映射 + 双线性采样写出。
 */

export interface WarpOptions {
  /** 输出长边像素上限，默认 2000。 */
  maxEdge?: number
  /** 强制输出宽高比（宽/高）。null = 按四边形自然比例。 */
  aspectRatio?: number | null
}

/** 由源四边形与选项计算输出像素尺寸（不实际渲染）。 */
export function computeWarpOutputSize(
  srcQuad: Quad,
  opts: WarpOptions = {},
): { width: number; height: number } {
  const maxEdge = opts.maxEdge ?? 2000
  const natural = quadNaturalSize(srcQuad)
  if (natural.width < 1 || natural.height < 1) return { width: 2, height: 2 }
  const scale = Math.min(1, maxEdge / Math.max(natural.width, natural.height))
  let width = Math.max(2, Math.round(natural.width * scale))
  let height = Math.max(2, Math.round(natural.height * scale))
  const aspect = opts.aspectRatio && opts.aspectRatio > 0 ? opts.aspectRatio : null
  if (aspect) {
    const area = width * height
    width = Math.max(2, Math.round(Math.sqrt(area * aspect)))
    height = Math.max(2, Math.round(Math.sqrt(area / aspect)))
  }
  return { width, height }
}

interface SourceImage {
  width: number
  height: number
  /** RGBA8888 像素，长 = width * height * 4。 */
  data: Uint8ClampedArray
}

/**
 * 把 srcQuad 透视矫正为外接矩形，返回 RGBA 像素缓冲（含输出尺寸）。
 * 输入支持任何带 { width, height, data } 形状的对象（ImageData / Canvas getImageData）。
 */
export function warpQuad(
  source: SourceImage,
  srcQuad: Quad,
  opts: WarpOptions = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  const { width: W, height: H } = computeWarpOutputSize(srcQuad, opts)
  const dst = new Uint8ClampedArray(W * H * 4)

  const [srcTL, srcTR, srcBR, srcBL] = srcQuad
  const tri1Src: [Pt, Pt, Pt] = [srcTL, srcTR, srcBL]
  const tri1Dst: [Pt, Pt, Pt] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: 0, y: H },
  ]
  const tri2Src: [Pt, Pt, Pt] = [srcTR, srcBR, srcBL]
  const tri2Dst: [Pt, Pt, Pt] = [
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ]

  rasterTriangle(source, dst, W, H, tri1Src, tri1Dst)
  rasterTriangle(source, dst, W, H, tri2Src, tri2Dst)

  return { width: W, height: H, data: dst }
}

/* ------------------------------------------------------------------ *
 * 三角形光栅化（仿射 + 双线性采样）
 * ------------------------------------------------------------------ */
function rasterTriangle(
  source: SourceImage,
  dst: Uint8ClampedArray,
  W: number,
  H: number,
  srcTri: [Pt, Pt, Pt],
  dstTri: [Pt, Pt, Pt],
): void {
  // 计算 dst → src 的仿射矩阵（6 参数）
  const invM = inverseAffineFromTriangles(srcTri, dstTri)

  // 计算 dst 三角形的 bounding box
  const minX = clampInt(Math.floor(Math.min(dstTri[0].x, dstTri[1].x, dstTri[2].x)), 0, W - 1)
  const maxX = clampInt(Math.ceil(Math.max(dstTri[0].x, dstTri[1].x, dstTri[2].x)), 0, W - 1)
  const minY = clampInt(Math.floor(Math.min(dstTri[0].y, dstTri[1].y, dstTri[2].y)), 0, H - 1)
  const maxY = clampInt(Math.ceil(Math.max(dstTri[0].y, dstTri[1].y, dstTri[2].y)), 0, H - 1)

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // 重心坐标：检查点是否在 dst 三角形内
      const u = barycentric(x, y, dstTri[0], dstTri[1], dstTri[2])
      if (u.lam1 < 0 || u.lam2 < 0 || u.lam3 < 0) continue

      // 源坐标 = invM * (x, y)
      const sx = invM[0] * x + invM[1] * y + invM[2]
      const sy = invM[3] * x + invM[4] * y + invM[5]

      const i = (y * W + x) * 4
      const sampled = bilinearSample(source, sx, sy)
      dst[i] = sampled[0]
      dst[i + 1] = sampled[1]
      dst[i + 2] = sampled[2]
      dst[i + 3] = sampled[3]
    }
  }
}

/** 求 srcTri → dstTri 的仿射矩阵，并返回其逆矩阵（dst → src）。 */
function inverseAffineFromTriangles(
  srcTri: [Pt, Pt, Pt],
  dstTri: [Pt, Pt, Pt],
): number[] {
  // M * src = dst，其中 M 是 2x3 仿射
  // 6 个方程：srcTri + dstTri 各 3 点
  // 直接求逆：M 是 2x3，没有完整逆，所以分两步：
  //   1) 先用 3 点算出 M
  //   2) 求 M 的"伪逆"（左边 2x2 部分）
  const M = affineFromTriangles(srcTri, dstTri)
  // [a b c; d e f] 的左上 2x2 求逆
  const det = M[0] * M[4] - M[1] * M[3]
  if (Math.abs(det) < 1e-12) {
    // 退化三角形：返回单位矩阵（不会到达此分支）
    return [1, 0, 0, 0, 1, 0]
  }
  const invDet = 1 / det
  const a = M[4] * invDet
  const b = -M[1] * invDet
  const d = -M[3] * invDet
  const e = M[0] * invDet
  // 翻译部分：-inv(M_2x2) * (c, f)
  const c = -(a * M[2] + b * M[5])
  const f = -(d * M[2] + e * M[5])
  return [a, b, c, d, e, f]
}

/** 由 3 对点解 2x3 仿射矩阵（Cramer's rule）。 */
function affineFromTriangles(
  srcTri: [Pt, Pt, Pt],
  dstTri: [Pt, Pt, Pt],
): number[] {
  const [s0, s1, s2] = srcTri
  const [d0, d1, d2] = dstTri

  // 6 方程：d_x = a*s_x + b*s_y + c, d_y = d*s_x + e*s_y + f
  // 拆成两个 3x3 线性系统：一个求 (a, b, c)，一个求 (d, e, f)
  const det = det3(s0.x, s0.y, 1, s1.x, s1.y, 1, s2.x, s2.y, 1)
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0]
  const a = det3(d0.x, s0.y, 1, d1.x, s1.y, 1, d2.x, s2.y, 1) / det
  const b = det3(s0.x, d0.x, 1, s1.x, d1.x, 1, s2.x, d2.x, 1) / det
  const c = det3(s0.x, s0.y, d0.x, s1.x, s1.y, d1.x, s2.x, s2.y, d2.x) / det
  const d = det3(d0.y, s0.y, 1, d1.y, s1.y, 1, d2.y, s2.y, 1) / det
  const e = det3(s0.x, d0.y, 1, s1.x, d1.y, 1, s2.x, d2.y, 1) / det
  const f = det3(s0.x, s0.y, d0.y, s1.x, s1.y, d1.y, s2.x, s2.y, d2.y) / det
  return [a, b, c, d, e, f]
}

function det3(
  a00: number, a01: number, a02: number,
  a10: number, a11: number, a12: number,
  a20: number, a21: number, a22: number,
): number {
  return (
    a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20)
  )
}

/** 重心坐标 + 三角形内部判定。 */
function barycentric(
  x: number,
  y: number,
  a: Pt,
  b: Pt,
  c: Pt,
): { lam1: number; lam2: number; lam3: number } {
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
  if (Math.abs(det) < 1e-12) return { lam1: -1, lam2: -1, lam3: -1 }
  const lam1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det
  const lam2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det
  const lam3 = 1 - lam1 - lam2
  return { lam1, lam2, lam3 }
}

/** 双线性采样，返回 RGBA（缺像素返回透明黑）。 */
function bilinearSample(source: SourceImage, x: number, y: number): [number, number, number, number] {
  const { width: W, height: H, data } = source
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return [0, 0, 0, 0]
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, W - 1)
  const y1 = Math.min(y0 + 1, H - 1)
  const fx = x - x0
  const fy = y - y0

  const i00 = (y0 * W + x0) * 4
  const i10 = (y0 * W + x1) * 4
  const i01 = (y1 * W + x0) * 4
  const i11 = (y1 * W + x1) * 4

  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy

  return [
    Math.round(data[i00]! * w00 + data[i10]! * w10 + data[i01]! * w01 + data[i11]! * w11),
    Math.round(data[i00 + 1]! * w00 + data[i10 + 1]! * w10 + data[i01 + 1]! * w01 + data[i11 + 1]! * w11),
    Math.round(data[i00 + 2]! * w00 + data[i10 + 2]! * w10 + data[i01 + 2]! * w01 + data[i11 + 2]! * w11),
    Math.round(data[i00 + 3]! * w00 + data[i10 + 3]! * w10 + data[i01 + 3]! * w01 + data[i11 + 3]! * w11),
  ]
}

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v | 0
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