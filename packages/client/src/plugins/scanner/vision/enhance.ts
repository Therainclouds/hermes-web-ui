import { boxBlur, otsuThreshold, rgbaToGray, toGrayscaleRgba } from './filters'
import type { EnhanceParams, RgbaImage } from './types'

/**
 * 文档扫描图像增强（纯 TS，typed-array，无 DOM）：
 *   - 对比度 / 亮度线性调整
 *   - 自动色阶（1%–99% 分位拉伸）
 *   - 灰度 / 黑白（Otsu 二值化）文档化处理
 *   - 轻度 USM 锐化（基于亮度通道模糊，速度快、适合文档）
 *
 * 输出始终为不透明 RGBA。
 */

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/** 对比度 / 亮度线性调整（就地，RGB 通道）。contrast 0..200，100 中性；brightness -100..100。 */
export function adjustContrastBrightness(src: RgbaImage, contrast: number, brightness: number): RgbaImage {
  const factor = contrast / 100
  const offset = brightness
  const data = new Uint8ClampedArray(src.data)
  for (let i = 0; i < data.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const v = data[i + ch]!
      data[i + ch] = clamp255(Math.round((v - 128) * factor + 128 + offset))
    }
    data[i + 3] = 255
  }
  return { width: src.width, height: src.height, data }
}

/**
 * 自动色阶：分别对 R/G/B 做 1%–99% 分位拉伸。
 * 当动态范围本身很小时（high-low < 12）跳过该通道，避免放大噪点。
 */
export function autoLevels(src: RgbaImage): RgbaImage {
  const { width, height, data } = src
  const n = width * height
  const lows: number[] = []
  const highs: number[] = []
  for (let ch = 0; ch < 3; ch++) {
    const hist = new Float64Array(256)
    for (let i = ch; i < data.length; i += 4) hist[data[i]!]!++
    let lo = 0
    let acc = 0
    const loTarget = n * 0.01
    while (lo < 255 && acc < loTarget) {
      acc += hist[lo]!
      lo++
    }
    let hi = 255
    acc = 0
    const hiTarget = n * 0.01
    while (hi > 0 && acc < hiTarget) {
      acc += hist[hi]!
      hi--
    }
    if (hi - lo < 12) {
      lows.push(-1)
      highs.push(-1)
    } else {
      lows.push(lo)
      highs.push(hi)
    }
  }
  if (lows[0] === -1 && lows[1] === -1 && lows[2] === -1) {
    return { width, height, data: new Uint8ClampedArray(data) }
  }
  const out = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const lo = lows[ch]!
      const hi = highs[ch]!
      if (lo < 0) {
        out[i + ch] = data[i + ch]!
      } else {
        const v = data[i + ch]!
        const mapped = ((v - lo) * 255) / (hi - lo)
        out[i + ch] = clamp255(Math.round(mapped))
      }
    }
    out[i + 3] = 255
  }
  return { width, height, data: out }
}

/**
 * 黑白文档化：灰度 + Otsu 全局二值化。输出纯黑/纯白。
 */
export function toBlackAndWhite(src: RgbaImage): RgbaImage {
  const gray = rgbaToGray(src)
  const t = otsuThreshold(gray.data)
  const out = new Uint8ClampedArray(gray.data.length * 4)
  for (let i = 0; i < gray.data.length; i++) {
    const v = gray.data[i]! > t ? 255 : 0
    const o = i * 4
    out[o] = v
    out[o + 1] = v
    out[o + 2] = v
    out[o + 3] = 255
  }
  return { width: src.width, height: src.height, data: out }
}

/**
 * 轻度 USM 锐化：out = v + amount * (v - blurLuma)。
 * amount 由 sharpen（0..100）线性映射到 0..~1.2。
 */
export function sharpenRgba(src: RgbaImage, sharpen: number): RgbaImage {
  const amount = sharpen * 0.012
  if (amount <= 0) return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
  const gray = rgbaToGray(src)
  const blurred = boxBlur(gray, 1)
  const out = new Uint8ClampedArray(src.data)
  const { width, height } = src
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      const b = blurred.data[p]!
      const o = p * 4
      for (let ch = 0; ch < 3; ch++) {
        const v = out[o + ch]!
        out[o + ch] = clamp255(Math.round(v + amount * (v - b)))
      }
    }
  }
  return { width, height, data: out }
}

/**
 * 按预设 + 对比度/亮度/锐化参数对图像做完整增强流水线：
 *   contrast/brightness 线性调整 → 预设（auto 色阶 / gray / bw）→ 锐化。
 * 输出为不透明 RGBA。
 */
export function applyEnhance(src: RgbaImage, params: EnhanceParams): RgbaImage {
  let img = adjustContrastBrightness(src, params.contrast, params.brightness)
  switch (params.preset) {
    case 'none':
      break
    case 'auto':
      img = autoLevels(img)
      break
    case 'gray':
      img = toGrayscaleRgba(img)
      break
    case 'bw':
      img = toBlackAndWhite(img)
      break
  }
  if (params.sharpen > 0 && params.preset !== 'bw') {
    img = sharpenRgba(img, params.sharpen)
  }
  return img
}
