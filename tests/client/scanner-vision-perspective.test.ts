import { describe, expect, it } from 'vitest'
import {
  computeWarpOutputSize,
  estimateQuadAspect,
  homography,
  warpQuad,
} from '@/plugins/scanner/vision/perspective'
import type { Pt, Quad } from '@/plugins/scanner/vision/types'

interface RgbaBuf {
  width: number
  height: number
  data: Uint8ClampedArray
}

function makeBlackImage(
  width: number,
  height: number,
  fill: [number, number, number] = [40, 40, 40],
): RgbaBuf {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]
    data[i + 1] = fill[1]
    data[i + 2] = fill[2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

/**
 * 在图像中画一个白矩形（指定 4 角点）。
 */
function drawPaper(
  img: RgbaBuf,
  quad: Quad,
  color: [number, number, number] = [240, 240, 240],
): void {
  const { width: W, height: H, data } = img
  const minX = Math.max(0, Math.floor(Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x)))
  const maxX = Math.min(W - 1, Math.ceil(Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x)))
  const minY = Math.max(0, Math.floor(Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y)))
  const maxY = Math.min(H - 1, Math.ceil(Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y)))
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = (y * W + x) * 4
      data[i] = color[0]
      data[i + 1] = color[1]
      data[i + 2] = color[2]
      data[i + 3] = 255
    }
  }
}

describe('perspective warp', () => {
  it('computes output size matching the source quad', () => {
    const src: Quad = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ]
    const size = computeWarpOutputSize(src, { maxEdge: 1000 })
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
  })

  it('produces an image of the configured dimensions', () => {
    const src: Quad = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ]
    const img = makeBlackImage(200, 100)
    drawPaper(img, src)
    const out = warpQuad(img, src, { maxEdge: 400 })
    expect(out.width).toBeGreaterThan(0)
    expect(out.height).toBeGreaterThan(0)
    // 矫正后中心像素应是纸色（白色），不是底色（黑）
    const cx = Math.floor(out.width / 2)
    const cy = Math.floor(out.height / 2)
    const i = (cy * out.width + cx) * 4
    const r = out.data[i]!
    expect(r).toBeGreaterThan(150)
  })

  it('clamps maxEdge to the source size for small inputs', () => {
    const src: Quad = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
    ]
    const size = computeWarpOutputSize(src, { maxEdge: 10000 })
    expect(size.width).toBeLessThanOrEqual(50)
    expect(size.height).toBeLessThanOrEqual(50)
  })
})
/* ------------------------------------------------------------------ *
 * 真透视（单应性）回归
 * ------------------------------------------------------------------ */

/** 用给定 3x3 单应性把源点映射到目标点。 */
function applyH(H: number[], x: number, y: number): { x: number; y: number } {
  const w = H[6]! * x + H[7]! * y + H[8]!
  return { x: (H[0]! * x + H[1]! * y + H[2]!) / w, y: (H[3]! * x + H[4]! * y + H[5]!) / w }
}

/**
 * 合成一张「斜拍」图：把 planeW x planeH 的棋盘按透视投影画到画布上，
 * 同时返回纸张四角在画布上的位置。用来验证矫正后棋盘重新变方。
 */
function renderPerspectiveBoard(opts: {
  imageWidth: number
  imageHeight: number
  planeWidth: number
  planeHeight: number
  cell: number
  yaw: number
  pitch: number
  distance: number
  focal: number
}): { image: RgbaBuf; quad: Quad } {
  const { imageWidth: W, imageHeight: H, planeWidth: pw, planeHeight: ph, cell } = opts
  const cx = W / 2
  const cy = H / 2
  const cosY = Math.cos(opts.yaw)
  const sinY = Math.sin(opts.yaw)
  const cosX = Math.cos(opts.pitch)
  const sinX = Math.sin(opts.pitch)
  // plane point (u, v) in [0,pw]x[0,ph] -> camera -> image
  const project = (u: number, v: number) => {
    const x = u - pw / 2
    const y = v - ph / 2
    // rotate around Y then X
    let X = cosY * x
    let Y = y
    let Z = -sinY * x
    const Y2 = cosX * Y - sinX * Z
    const Z2 = sinX * Y + cosX * Z
    Y = Y2
    Z = Z2 + opts.distance
    return { x: cx + (opts.focal * X) / Z, y: cy + (opts.focal * Y) / Z }
  }
  const corners: Quad = [project(0, 0), project(pw, 0), project(pw, ph), project(0, ph)]
  // 反向映射：图像像素 -> 平面坐标（用四角解单应性即可，投影是精确的）
  const Hinv = homography(
    [corners[0], corners[1], corners[2], corners[3]],
    [
      { x: 0, y: 0 },
      { x: pw, y: 0 },
      { x: pw, y: ph },
      { x: 0, y: ph },
    ],
  )!
  const image = makeBlackImage(W, H, [30, 30, 30])
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const p = applyH(Hinv, px + 0.5, py + 0.5)
      if (p.x < 0 || p.y < 0 || p.x >= pw || p.y >= ph) continue
      const dark = (Math.floor(p.x / cell) + Math.floor(p.y / cell)) % 2 === 0
      const v = dark ? 25 : 235
      const i = (py * W + px) * 4
      image.data[i] = v
      image.data[i + 1] = v
      image.data[i + 2] = v
      image.data[i + 3] = 255
    }
  }
  return { image, quad: corners }
}

describe('perspective warp: real homography', () => {
  it('solves a homography that maps all four corners exactly', () => {
    const src: Pt[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ]
    const dst: Pt[] = [
      { x: 12, y: 9 },
      { x: 180, y: 30 },
      { x: 165, y: 140 },
      { x: 25, y: 120 },
    ]
    const H = homography(src, dst)!
    expect(H).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      const mapped = applyH(H, src[i]!.x, src[i]!.y)
      expect(mapped.x).toBeCloseTo(dst[i]!.x, 6)
      expect(mapped.y).toBeCloseTo(dst[i]!.y, 6)
    }
  })

  it('recovers the true aspect ratio of a slanted rectangle from vanishing points', () => {
    const { quad } = renderPerspectiveBoard({
      imageWidth: 320,
      imageHeight: 200,
      planeWidth: 300,
      planeHeight: 200,
      cell: 25,
      yaw: 0.5,
      pitch: 0.35,
      distance: 900,
      focal: 1200,
    })
    const aspect = estimateQuadAspect(quad, 320, 200)!
    expect(aspect).not.toBeNull()
    expect(aspect).toBeCloseTo(1.5, 1)
  })

  it('rectifies a trapezoid so the checkerboard becomes square again', () => {
    const { image, quad } = renderPerspectiveBoard({
      imageWidth: 420,
      imageHeight: 300,
      planeWidth: 300,
      planeHeight: 200,
      cell: 25,
      yaw: 0.45,
      pitch: 0.3,
      distance: 1000,
      focal: 1300,
    })
    const out = warpQuad(image, quad, { maxEdge: 300 })
    // 输出比例应接近纸张真实比例 1.5（仿射近似做不到，会明显偏离）
    expect(out.width / out.height).toBeCloseTo(1.5, 1)

    // 每个格子在输出图里应该等宽：沿中线扫一行，统计黑白跳变的间距
    const midY = Math.floor(out.height / 2)
    const lumaAtX = (x: number) => out.data[(midY * out.width + x) * 4]!
    const edges: number[] = []
    for (let x = 2; x < out.width - 2; x++) {
      const a = lumaAtX(x - 1) > 128
      const b = lumaAtX(x) > 128
      if (a !== b) edges.push(x)
    }
    expect(edges.length).toBeGreaterThanOrEqual(8)
    const gaps: number[] = []
    for (let i = 1; i < edges.length; i++) gaps.push(edges[i]! - edges[i - 1]!)
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    for (const gap of gaps) {
      // 透视矫正正确时格宽均匀；仿射近似下近端/远端格宽会差 30% 以上
      expect(Math.abs(gap - mean) / mean).toBeLessThan(0.2)
    }
  })
})
