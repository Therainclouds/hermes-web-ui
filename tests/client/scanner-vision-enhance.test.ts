import { describe, expect, it } from 'vitest'
import { applyEnhance, adjustContrastBrightness, autoLevels, toBlackAndWhite } from '@/plugins/scanner/vision/enhance'
import { otsuThreshold, rgbaToGray, rotateRgba90, toGrayscaleRgba } from '@/plugins/scanner/vision/filters'
import { ENHANCE_DEFAULTS, type RgbaImage } from '@/plugins/scanner/vision/types'

function solidImage(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

/** 渐变测试图：每个像素 luma = x*255/(w-1)（灰阶）。 */
function rampImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x * 255) / Math.max(1, width - 1))
      const o = (y * width + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}

function pixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const o = (y * img.width + x) * 4
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!]
}

describe('scanner vision enhance', () => {
  it('applyEnhance with preset none keeps pixels unchanged', () => {
    const src = rampImage(8, 4)
    const out = applyEnhance(src, { ...ENHANCE_DEFAULTS.none })
    expect(out.data).toEqual(src.data)
  })

  it('contrast/brightness: neutral values are a no-op, high contrast spreads values', () => {
    const src = solidImage(2, 1, [100, 120, 140])
    const neutral = adjustContrastBrightness(src, 100, 0)
    expect(Array.from(neutral.data)).toEqual(Array.from(src.data))

    const boosted = adjustContrastBrightness(src, 200, 0)
    const [r, g, b] = pixel(boosted, 0, 0)
    // (v-128)*2+128：100 -> 72, 120 -> 112, 140 -> 152
    expect(r).toBe(72)
    expect(g).toBe(112)
    expect(b).toBe(152)

    const brightened = adjustContrastBrightness(src, 100, 40)
    expect(pixel(brightened, 0, 0)[0]).toBe(140)
  })

  it('contrast/brightness clamps to 0..255 and keeps alpha opaque', () => {
    const src = solidImage(1, 1, [250, 5, 128])
    const out = adjustContrastBrightness(src, 200, 80)
    const [r, g, b, a] = pixel(out, 0, 0)
    expect(r).toBe(255)
    expect(g).toBe(0)
    // b: (128-128)*2+128+80 = 208
    expect(b).toBe(208)
    expect(a).toBe(255)
  })

  it('auto levels stretches a narrow ramp towards full range', () => {
    const width = 64
    const height = 2
    const data = new Uint8ClampedArray(width * height * 4)
    for (let x = 0; x < width; x++) {
      const v = Math.round(90 + (x * 60) / (width - 1)) // 90..150
      for (let y = 0; y < height; y++) {
        const o = (y * width + x) * 4
        data[o] = v
        data[o + 1] = v
        data[o + 2] = v
        data[o + 3] = 255
      }
    }
    const src = { width, height, data }
    const out = autoLevels(src)
    const minV = Math.min(...Array.from(out.data).filter((_, i) => i % 4 === 0))
    const maxV = Math.max(...Array.from(out.data).filter((_, i) => i % 4 === 0))
    expect(minV).toBe(0)
    expect(maxV).toBe(255)
  })

  it('gray preset produces equal RGB channels (Rec.601 luma)', () => {
    const src = solidImage(2, 2, [200, 100, 50])
    const out = applyEnhance(src, { ...ENHANCE_DEFAULTS.gray })
    const [r, g, b] = pixel(out, 0, 0)
    const expected = Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50)
    expect(r).toBe(expected)
    expect(g).toBe(expected)
    expect(b).toBe(expected)
    expect(pixel(out, 0, 0)[3]).toBe(255)
  })

  it('bw preset outputs only pure black or white pixels', () => {
    const src = rampImage(32, 4)
    const out = applyEnhance(src, { ...ENHANCE_DEFAULTS.bw })
    let sawWhite = false
    let sawBlack = false
    for (let i = 0; i < out.data.length; i += 4) {
      const v = out.data[i]!
      expect([0, 255]).toContain(v)
      expect(out.data[i + 1]).toBe(v)
      expect(out.data[i + 2]).toBe(v)
      if (v === 255) sawWhite = true
      if (v === 0) sawBlack = true
    }
    expect(sawWhite).toBe(true)
    expect(sawBlack).toBe(true)
  })

  it('sharpen is bounded and keeps alpha', () => {
    const src = solidImage(6, 6, [128, 128, 128])
    const src2: RgbaImage = { ...src, data: new Uint8ClampedArray(src.data) }
    // 中间放一条亮线制造边缘
    for (let x = 2; x < 4; x++) {
      for (let y = 0; y < 6; y++) {
        const o = (y * 6 + x) * 4
        src2.data[o] = 200
        src2.data[o + 1] = 200
        src2.data[o + 2] = 200
      }
    }
    const out = applyEnhance(src2, { preset: 'none', contrast: 100, brightness: 0, sharpen: 100 })
    for (let i = 0; i < out.data.length; i++) {
      expect(out.data[i]!).toBeGreaterThanOrEqual(0)
      expect(out.data[i]!).toBeLessThanOrEqual(255)
    }
    // 边缘两侧应被锐化增强（亮线内部更亮或外部更暗，至少产生差异）
    const before = applyEnhance(src2, { ...ENHANCE_DEFAULTS.none })
    expect(out.data).not.toEqual(before.data)
  })

  it('toGrayscaleRgba / rgbaToGray / otsuThreshold agree on basic shapes', () => {
    const src = solidImage(3, 3, [10, 10, 10])
    const gray = rgbaToGray(src)
    expect(gray.data[0]).toBe(10)
    // Otsu 对均匀图给出合理阈值
    const t = otsuThreshold(gray.data)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t).toBeLessThanOrEqual(255)
    const g = toGrayscaleRgba(src)
    expect(pixel(g, 1, 1)[0]).toBe(10)
  })
})

/**
 * 合成「带阴影的拍摄件」：纸面亮度从左到右由 245 衰减到 70（手影/侧光），
 * 文字是等间距的深色横条（比局部纸面暗 ~90）。
 */
function shadowedPage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const paper = 245 - Math.round((x / Math.max(1, width - 1)) * 175)
      const isText = y % 12 >= 3 && y % 12 <= 6 && x > 6 && x < width - 6
      const v = isText ? Math.max(4, Math.round(paper * 0.35)) : paper
      const o = (y * width + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}

function lumaAt(img: RgbaImage, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4]!
}

describe('scanner enhance: shadow removal + adaptive binarization', () => {
  it('scan preset flattens uneven lighting to a near-white page on both sides', () => {
    const src = shadowedPage(240, 180)
    const out = applyEnhance(src, { ...ENHANCE_DEFAULTS.scan })
    // 纸面行（y % 12 === 0）左右两侧都应接近纯白
    expect(lumaAt(out, 20, 12)).toBeGreaterThan(225)
    expect(lumaAt(out, 220, 12)).toBeGreaterThan(225)
    // 文字行仍明显更深
    expect(lumaAt(out, 20, 16)).toBeLessThan(150)
    expect(lumaAt(out, 220, 16)).toBeLessThan(150)
  })

  it('bw preset keeps text on the shadowed side instead of flooding it black', () => {
    const src = shadowedPage(240, 180)
    const out = applyEnhance(src, { ...ENHANCE_DEFAULTS.bw })
    // 暗侧纸面必须是白（旧的全局 Otsu 会把这半页整块涂黑）
    expect(lumaAt(out, 225, 12)).toBe(255)
    expect(lumaAt(out, 20, 12)).toBe(255)
    // 两侧文字都保留为黑
    expect(lumaAt(out, 225, 16)).toBe(0)
    expect(lumaAt(out, 20, 16)).toBe(0)
  })

  it('bw preset output is strictly bilevel so it can ship as 1bpp in a PDF', () => {
    const out = applyEnhance(shadowedPage(120, 90), { ...ENHANCE_DEFAULTS.bw })
    for (let i = 0; i < out.data.length; i += 4) {
      expect([0, 255]).toContain(out.data[i]!)
    }
  })
})

describe('scanner rotate', () => {
  it('rotates a page clockwise and counter-clockwise with swapped dimensions', () => {
    const src: RgbaImage = {
      width: 3,
      height: 2,
      data: Uint8ClampedArray.from([
        1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255,
        4, 4, 4, 255, 5, 5, 5, 255, 6, 6, 6, 255,
      ]),
    }

    const right = rotateRgba90(src, 'right')
    expect([right.width, right.height]).toEqual([2, 3])
    expect(Array.from(right.data)).toEqual([
      4, 4, 4, 255, 1, 1, 1, 255,
      5, 5, 5, 255, 2, 2, 2, 255,
      6, 6, 6, 255, 3, 3, 3, 255,
    ])

    const left = rotateRgba90(src, 'left')
    expect([left.width, left.height]).toEqual([2, 3])
    expect(Array.from(left.data)).toEqual([
      3, 3, 3, 255, 6, 6, 6, 255,
      2, 2, 2, 255, 5, 5, 5, 255,
      1, 1, 1, 255, 4, 4, 4, 255,
    ])
  })

  it('returns the source pixels after four quarter turns', () => {
    const src = rampImage(7, 5)
    let rotated = src
    for (let i = 0; i < 4; i++) rotated = rotateRgba90(rotated, 'right')
    expect(rotated.width).toBe(src.width)
    expect(rotated.height).toBe(src.height)
    expect(Array.from(rotated.data)).toEqual(Array.from(src.data))
  })
})
