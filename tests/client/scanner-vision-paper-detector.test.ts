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
describe('paper-detector classic enhancements', () => {
  it('detects a dark sheet on a light background (dark polarity)', async () => {
    const W = 200, H = 200
    // 亮桌面背景 + 深色纸张
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < data.length; i += 4) { data[i] = 225; data[i + 1] = 225; data[i + 2] = 225; data[i + 3] = 255 }
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = (y * W + x) * 4
        data[i] = 40; data[i + 1] = 40; data[i + 2] = 40
      }
    }
    const result = await detectPaper({ width: W, height: H, data }, { strategies: ['bright'] })
    expect(result).not.toBeNull()
    const r = result as PaperDetection
    // 深色极性候选应框住深色纸张，而不是整幅亮背景
    expect(r.quad[0].x).toBeCloseTo(rect.x / W, 1)
    expect(r.quad[0].y).toBeCloseTo(rect.y / H, 1)
    expect(r.quad[2].x).toBeCloseTo((rect.x + rect.w) / W, 1)
    expect(r.quad[2].y).toBeCloseTo((rect.y + rect.h) / H, 1)
  })

  it('prefers the paper sheet over a frame-filling bright background', async () => {
    const W = 200, H = 200
    // 中间一张「更亮」的白纸，四周是较亮但仍偏灰的桌面 —— 单极性会选中整幅桌面
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < data.length; i += 4) { data[i] = 150; data[i + 1] = 150; data[i + 2] = 150; data[i + 3] = 255 }
    const rect = { x: 40, y: 50, w: 120, h: 100 }
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = (y * W + x) * 4
        data[i] = 240; data[i + 1] = 240; data[i + 2] = 240
      }
    }
    const result = await detectPaper({ width: W, height: H, data })
    expect(result).not.toBeNull()
    const r = result as PaperDetection
    expect(r.quad[0].x).toBeCloseTo(rect.x / W, 1)
    expect(r.quad[0].y).toBeCloseTo(rect.y / H, 1)
    expect(r.quad[2].x).toBeCloseTo((rect.x + rect.w) / W, 1)
    expect(r.quad[2].y).toBeCloseTo((rect.y + rect.h) / H, 1)
  })

  it('picks a smaller clean sheet over a larger bright region that hugs the frame', async () => {
    // 回归：最大连通域不是纸 —— 画面底部有一条贴画面左/右/下三边的亮带（面积更大），
    // 上方是一张不贴边的白纸。旧代码只取最大连通域 → 框住底部的背景亮带；
    // 现在取 Top-N 一起评分，用「矩形度 × 反背景（贴画框）」把纸张捞出来。
    const W = 200, H = 200
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < data.length; i += 4) { data[i] = 20; data[i + 1] = 20; data[i + 2] = 20; data[i + 3] = 255 }
    const paint = (rect: { x: number; y: number; w: number; h: number }) => {
      for (let y = rect.y; y < rect.y + rect.h; y++)
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const i = (y * W + x) * 4
          data[i] = 240; data[i + 1] = 240; data[i + 2] = 240
        }
    }
    const sheet = { x: 60, y: 40, w: 90, h: 70 }        // 0.16 面积，不贴边
    const bottom = { x: 0, y: 130, w: 200, h: 70 }      // 0.35 面积，贴左/右/下三边
    paint(sheet)
    paint(bottom)

    const result = await detectPaper({ width: W, height: H, data }, { strategies: ['bright'] })
    expect(result).not.toBeNull()
    const r = result as PaperDetection
    const cx = (r.quad[0].x + r.quad[2].x) / 2
    const cy = (r.quad[0].y + r.quad[2].y) / 2
    // 选框中心应落在上方纸张（sheet），而不是底部背景亮带
    expect(cx).toBeCloseTo((sheet.x + sheet.w / 2) / W, 1)
    expect(cy).toBeCloseTo((sheet.y + sheet.h / 2) / H, 1)
  })
})

describe('paper-detector ROI tracking (priorQuad)', () => {
  const W = 400, H = 300
  /** 暗背景上左右两张白纸：A 在左、B 在右 */
  function twoSheets(): { width: number; height: number; data: Uint8ClampedArray } {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < data.length; i += 4) { data[i] = 20; data[i + 1] = 20; data[i + 2] = 20; data[i + 3] = 255 }
    const paint = (rect: { x: number; y: number; w: number; h: number }) => {
      for (let y = rect.y; y < rect.y + rect.h; y++)
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const i = (y * W + x) * 4
          data[i] = 240; data[i + 1] = 240; data[i + 2] = 240
        }
    }
    paint({ x: 30, y: 40, w: 140, h: 220 })   // A 中心 x=100
    paint({ x: 230, y: 40, w: 140, h: 220 })  // B 中心 x=300
    return { width: W, height: H, data }
  }
  const quadAt = (cx: number, cy: number, halfW: number, halfH: number): Quad => [
    { x: cx - halfW, y: cy - halfH },
    { x: cx + halfW, y: cy - halfH },
    { x: cx + halfW, y: cy + halfH },
    { x: cx - halfW, y: cy + halfH },
  ]

  it('without prior picks the largest sheet (A)', async () => {
    const r = await detectPaper(twoSheets(), { strategies: ['bright'] })
    expect(r).not.toBeNull()
    const cx = (r!.quad[0].x + r!.quad[2].x) / 2
    expect(cx).toBeCloseTo(100 / W, 1)
  })

  it('with prior near sheet B locks onto B instead of the larger/equal A', async () => {
    const r = await detectPaper(twoSheets(), {
      strategies: ['bright'],
      priorQuad: quadAt(300 / W, 150 / H, 0.12, 0.3),
    })
    expect(r).not.toBeNull()
    const cx = (r!.quad[0].x + r!.quad[2].x) / 2
    expect(cx).toBeCloseTo(300 / W, 1)
  })

  it('falls back to full-frame search when prior points at an empty region', async () => {
    const r = await detectPaper(twoSheets(), {
      strategies: ['bright'],
      priorQuad: quadAt(0.05, 0.05, 0.03, 0.03), // 左上角空白处
    })
    expect(r).not.toBeNull()
    const cx = (r!.quad[0].x + r!.quad[2].x) / 2
    expect(cx).toBeCloseTo(100 / W, 1) // 回退整帧 → 最大张 A
  })
})
