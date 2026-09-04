import { describe, expect, it } from 'vitest'
import {
  computeWarpOutputSize,
  warpQuad,
} from '@/plugins/scanner/vision/perspective'
import type { Quad } from '@/plugins/scanner/vision/types'

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