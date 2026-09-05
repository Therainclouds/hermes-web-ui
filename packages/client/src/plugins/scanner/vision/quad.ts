import type { Pt, Quad } from './types'

/**
 * 四边形小工具：像素/归一化坐标换算、面积/边长/相似度。
 * 纯函数，供 engine（OpenCV 检测结果）与选框 UI 共用。
 */

/** jscanify / OpenCV 风格的四个角点命名。 */
export interface QuadCorners {
  topLeft: Pt
  topRight: Pt
  bottomRight: Pt
  bottomLeft: Pt
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 鞋带公式面积（输入坐标单位一致即可，如像素或归一化）。 */
export function quadArea(quad: Quad): number {
  const [a, b, c, d] = quad
  return Math.abs(
    (a.x * b.y - b.x * a.y)
    + (b.x * c.y - c.x * b.y)
    + (c.x * d.y - d.x * c.y)
    + (d.x * a.y - a.x * d.y),
  ) / 2
}

/** 由自然边长估计宽高（长边分别取对边均值）。 */
export function quadNaturalSize(quad: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = quad
  return {
    width: Math.max(dist(tl, tr), dist(bl, br)),
    height: Math.max(dist(tl, bl), dist(tr, br)),
  }
}

export function cornersToQuad(corners: QuadCorners): Quad {
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
}

export function quadToCorners(quad: Quad): QuadCorners {
  const [tl, tr, br, bl] = quad
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl }
}

/** 按比例缩放四边形（例如分析帧坐标 → 全分辨率坐标）。 */
export function scaleQuad(quad: Quad, sx: number, sy: number): Quad {
  const mapped = quad.map(p => ({ x: p.x * sx, y: p.y * sy }))
  return [mapped[0]!, mapped[1]!, mapped[2]!, mapped[3]!]
}

/**
 * 平均角点位移。a/b 需在同一坐标系（归一化或像素）。用于动态捕捉稳定性判定。
 */
export function quadCornerDelta(a: Quad, b: Quad): number {
  let sum = 0
  for (let i = 0; i < 4; i++) sum += dist(a[i]!, b[i]!)
  return sum / 4
}

/** 四边形的自然宽高比（宽/高）。 */
export function quadAspectRatio(quad: Quad): number {
  const { width, height } = quadNaturalSize(quad)
  if (height <= 0) return 1
  return width / height
}

/**
 * 计算透视矫正的输出像素尺寸。
 * 默认按四边形的自然宽高；aspectRatio 传入时保持面积量级、对齐指定宽高比。
 * maxEdge 限制输出长边。
 */
export function computeOutputSize(
  quad: Quad,
  opts: { maxEdge?: number; aspectRatio?: number | null } = {},
): { width: number; height: number } {
  const maxEdge = opts.maxEdge || 2000
  const natural = quadNaturalSize(quad)
  if (natural.width < 1 || natural.height < 1) {
    return { width: 2, height: 2 }
  }
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
