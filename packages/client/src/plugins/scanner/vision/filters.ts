import type { GrayImage, RgbaImage } from './types'

/**
 * 基础图像滤波器：灰度、模糊、Otsu 阈值、双线性缩放。
 * 供图像增强链路（enhance）使用；全部为纯函数，操作 typed array，无 DOM 依赖。
 */

/** RGBA -> 亮度灰度（Rec.601 加权）。 */
export function rgbaToGray(src: RgbaImage): GrayImage {
  const { width, height, data } = src
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!)
  }
  return { width, height, data: out }
}

/** 三通道灰度化（RGB 相同），alpha 不变。 */
export function toGrayscaleRgba(src: RgbaImage): RgbaImage {
  const gray = rgbaToGray(src)
  const out = new Uint8ClampedArray(src.width * src.height * 4)
  for (let i = 0; i < gray.data.length; i++) {
    const g = gray.data[i]!
    const o = i * 4
    out[o] = g
    out[o + 1] = g
    out[o + 2] = g
    out[o + 3] = 255
  }
  return { width: src.width, height: src.height, data: out }
}

/** 可分离 box blur（整型累加），radius >= 0。 */
export function boxBlur(gray: GrayImage, radius: number): GrayImage {
  const { width, height, data } = gray
  const out = new Uint8ClampedArray(width * height)
  if (radius <= 0) {
    out.set(data)
    return { width, height, data: out }
  }
  const tmp = new Uint8ClampedArray(width * height)
  const win = radius * 2 + 1
  // 横向
  for (let y = 0; y < height; y++) {
    const rowStart = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x++) {
      const cx = clampIndex(x, width)
      sum += data[rowStart + cx]!
    }
    for (let x = 0; x < width; x++) {
      tmp[rowStart + x] = sum / win
      const add = clampIndex(x + radius + 1, width)
      const sub = clampIndex(x - radius, width)
      sum += data[rowStart + add]! - data[rowStart + sub]!
    }
  }
  // 纵向
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let y = -radius; y <= radius; y++) {
      const cy = clampIndex(y, height)
      sum += tmp[cy * width + x]!
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / win
      const add = clampIndex(y + radius + 1, height)
      const sub = clampIndex(y - radius, height)
      sum += tmp[add * width + x]! - tmp[sub * width + x]!
    }
  }
  return { width, height, data: out }
}

function clampIndex(v: number, max: number): number {
  return v < 0 ? 0 : v >= max ? max - 1 : v
}

/** Otsu 全局阈值（输入为 0..255 灰度直方图源）。 */
export function otsuThreshold(values: Uint8ClampedArray | Uint8Array): number {
  const hist = new Float64Array(256)
  const n = values.length
  if (n === 0) return 128
  for (let i = 0; i < n; i++) hist[values[i]!]!++
  let total = n
  let sumAll = 0
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }
  return threshold
}

/**
 * 双线性缩放 RGBA 图像。dstW/dstH 必须已按宽高比算好。
 */
export function resizeRgba(src: RgbaImage, dstW: number, dstH: number): RgbaImage {
  if (dstW === src.width && dstH === src.height) {
    return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
  }
  const out = new Uint8ClampedArray(dstW * dstH * 4)
  const { data, width: sw, height: sh } = src
  const xRatio = sw / dstW
  const yRatio = sh / dstH
  for (let y = 0; y < dstH; y++) {
    const srcY = (y + 0.5) * yRatio - 0.5
    const y0 = Math.max(0, Math.floor(srcY))
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = srcY - y0
    for (let x = 0; x < dstW; x++) {
      const srcX = (x + 0.5) * xRatio - 0.5
      const x0 = Math.max(0, Math.floor(srcX))
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = srcX - x0
      const i00 = (y0 * sw + x0) * 4
      const i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      const o = (y * dstW + x) * 4
      for (let ch = 0; ch < 4; ch++) {
        const top = data[i00 + ch]! * (1 - fx) + data[i10 + ch]! * fx
        const bottom = data[i01 + ch]! * (1 - fx) + data[i11 + ch]! * fx
        out[o + ch] = top * (1 - fy) + bottom * fy
      }
    }
  }
  return { width: dstW, height: dstH, data: out }
}

/** 按长边限制等比缩放 RGBA。 */
export function resizeRgbaMaxEdge(src: RgbaImage, maxEdge: number): RgbaImage {
  const longEdge = Math.max(src.width, src.height)
  if (longEdge <= maxEdge) {
    return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
  }
  const scale = maxEdge / longEdge
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  return resizeRgba(src, w, h)
}
