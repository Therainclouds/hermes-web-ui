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
  it('returns null for tiny input', async () => {
    const img = makeSyntheticPaper(8, 8, { x: 0, y: 0, w: 4, h: 4 })
    expect(await detectPaper(img)).toBeNull()
  })

  it('detects a centered white rectangle on dark background', async () => {
    const W = 200
    const H = 200
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    const img = makeSyntheticPaper(W, H, rect)
    const result = await detectPaper(img)

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
    expect(r.quad[0].x).toBeCloseTo(expected.tl.x, 1)
    expect(r.quad[0].y).toBeCloseTo(expected.tl.y, 1)
    expect(r.quad[1].x).toBeCloseTo(expected.tr.x, 1)
    expect(r.quad[1].y).toBeCloseTo(expected.tr.y, 1)
    expect(r.quad[2].x).toBeCloseTo(expected.br.x, 1)
    expect(r.quad[2].y).toBeCloseTo(expected.br.y, 1)
    expect(r.quad[3].x).toBeCloseTo(expected.bl.x, 1)
    expect(r.quad[3].y).toBeCloseTo(expected.bl.y, 1)
  })

  it('returns null for an all-dark image (no paper)', async () => {
    const data = new Uint8ClampedArray(100 * 100 * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 10
      data[i + 1] = 10
      data[i + 2] = 10
      data[i + 3] = 255
    }
    expect(await detectPaper({ width: 100, height: 100, data })).toBeNull()
  })

  it('returns null for a paper that is too small', async () => {
    const W = 200
    const H = 200
    const rect = { x: 95, y: 95, w: 10, h: 10 } // 2.5% of frame
    const img = makeSyntheticPaper(W, H, rect)
    expect(await detectPaper(img)).toBeNull()
  })

  it('rejects overly-wide aspect ratios', async () => {
    const W = 300
    const H = 100
    const rect = { x: 10, y: 10, w: 280, h: 80 } // aspect 3.5
    const img = makeSyntheticPaper(W, H, rect)
    expect(await detectPaper(img)).toBeNull()
  })

  it('uses morphological closing to recover paper with holes (text inside)', async () => {
    // 白纸上散几个黑字（打洞前景），闭运算应填洞
    const W = 200, H = 200
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    const img = makeSyntheticPaper(W, H, rect)
    // 在纸内挖 3 个 6x6 的黑点（模拟文字）
    const holes = [
      { x: 60, y: 70, w: 8, h: 6 },
      { x: 100, y: 90, w: 8, h: 6 },
      { x: 130, y: 120, w: 8, h: 6 },
    ]
    for (const h of holes) {
      for (let y = h.y; y < h.y + h.h; y++) {
        for (let x = h.x; x < h.x + h.w; x++) {
          const i = (y * W + x) * 4
          img.data[i] = 20
          img.data[i + 1] = 20
          img.data[i + 2] = 20
        }
      }
    }
    const result = await detectPaper(img)
    expect(result).not.toBeNull()
    const r = result as PaperDetection
    // 闭运算应填回这些小洞
    expect(r.quad[0].x).toBeCloseTo(rect.x / W, 1)
    expect(r.quad[0].y).toBeCloseTo(rect.y / H, 1)
  })

  it('edge-based detection works on a moderate-contrast synthetic document', async () => {
    // 强制只跑 edge 策略（验证 edge 路径独立可用）
    const W = 200, H = 200
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    const img = makeSyntheticPaper(W, H, rect)
    const result = await detectPaper(img, { strategies: ['edge'] })
    expect(result).not.toBeNull()
    const r = result as PaperDetection
    expect(r.strategy).toBe('edge')
    expect(r.quad[0].x).toBeCloseTo(rect.x / W, 1)
    expect(r.quad[0].y).toBeCloseTo(rect.y / H, 1)
  })

  it('rejects paper covering nearly the entire frame (maxAreaRatio)', async () => {
    // 整张图几乎都是白，maxAreaRatio=0.85 应该拒绝
    const W = 100, H = 100
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 240; data[i + 1] = 240; data[i + 2] = 240; data[i + 3] = 255
    }
    expect(await detectPaper({ width: W, height: H, data })).toBeNull()
  })

  it('returns detection with ms and strategy fields', async () => {
    const W = 200, H = 200
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    const img = makeSyntheticPaper(W, H, rect)
    const result = await detectPaper(img)
    expect(result).not.toBeNull()
    expect(typeof (result as PaperDetection).ms).toBe('number')
    expect(['bright', 'edge']).toContain((result as PaperDetection).strategy)
  })

  it('ML strategy returns null when transformers module is unavailable', async () => {
    // ML 策略：transformers.js 在 vitest 环境里加载会失败（wasm header 缺失），
    // 应安静退化为 null（不抛错），不影响其它策略
    const W = 200, H = 200
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    const img = makeSyntheticPaper(W, H, rect)
    const result = await detectPaper(img, { strategies: ['ml'] })
    // 在 Node 环境里 ML 会失败，但 bright 不会（已被 ml-only 排除）
    // 期望：detection 为 null（ML 退化为 null 而非抛出）
    if (result !== null) {
      // 如果某个环境让 ML 跑通了，验证结构
      expect(result.strategy).toBe('ml')
      expect(result.quad).toHaveLength(4)
    }
    // 关键断言：没有抛错就是成功
    expect(result === null || result.strategy === 'ml').toBe(true)
  })
})