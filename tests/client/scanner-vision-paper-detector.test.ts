import { describe, expect, it } from 'vitest'
import { detectPaper, type PaperDetection } from '@/plugins/scanner/vision/paper-detector'

/**
 * 合成一张指定宽高的 RGBA 图像：把 `rect` 区域填白，其余填黑。
 * 测试场景：白纸 + 黑底 = Otsu 自动分开。
 */
function makeSyntheticPaper(
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 20
    data[i + 1] = 20
    data[i + 2] = 20
    data[i + 3] = 255
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * width + x) * 4
      data[i] = 240
      data[i + 1] = 240
      data[i + 2] = 240
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('paper-detector', () => {
  it('returns null for tiny input', () => {
    const img = makeSyntheticPaper(8, 8, { x: 0, y: 0, w: 4, h: 4 })
    expect(detectPaper(img)).toBeNull()
  })

  it('detects a centered white rectangle on dark background', () => {
    const W = 200
    const H = 200
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    const img = makeSyntheticPaper(W, H, rect)
    const result = detectPaper(img)

    expect(result).not.toBeNull()
    const r = result as PaperDetection
    expect(r.confidence).toBeGreaterThan(0)
    expect(r.ms).toBeGreaterThan(0)

    // 归一化 4 个角点近似等于矩形
    const expected = {
      tl: { x: rect.x / W, y: rect.y / H },
      tr: { x: (rect.x + rect.w) / W, y: rect.y / H },
      br: { x: (rect.x + rect.w) / W, y: (rect.y + rect.h) / H },
      bl: { x: rect.x / W, y: (rect.y + rect.h) / H },
    }
    const eps = 0.03
    expect(r.quad[0].x).toBeCloseTo(expected.tl.x, 1)
    expect(r.quad[0].y).toBeCloseTo(expected.tl.y, 1)
    expect(r.quad[1].x).toBeCloseTo(expected.tr.x, 1)
    expect(r.quad[1].y).toBeCloseTo(expected.tr.y, 1)
    expect(r.quad[2].x).toBeCloseTo(expected.br.x, 1)
    expect(r.quad[2].y).toBeCloseTo(expected.br.y, 1)
    expect(r.quad[3].x).toBeCloseTo(expected.bl.x, 1)
    expect(r.quad[3].y).toBeCloseTo(expected.bl.y, 1)
    expect(eps).toBeGreaterThan(0)
  })

  it('returns null for an all-dark image (no paper)', () => {
    const data = new Uint8ClampedArray(100 * 100 * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 10
      data[i + 1] = 10
      data[i + 2] = 10
      data[i + 3] = 255
    }
    expect(detectPaper({ width: 100, height: 100, data })).toBeNull()
  })

  it('returns null for a paper that is too small', () => {
    const W = 200
    const H = 200
    const rect = { x: 95, y: 95, w: 10, h: 10 } // 2.5% of frame
    const img = makeSyntheticPaper(W, H, rect)
    expect(detectPaper(img)).toBeNull()
  })

  it('rejects overly-wide aspect ratios', () => {
    const W = 300
    const H = 100
    const rect = { x: 10, y: 10, w: 280, h: 80 } // aspect 3.5
    const img = makeSyntheticPaper(W, H, rect)
    expect(detectPaper(img)).toBeNull()
  })
})