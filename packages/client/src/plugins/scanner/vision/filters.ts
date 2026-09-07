import type { GrayImage, RgbaImage, RotateDirection } from './types'

/**
 * 基础图像滤波器：灰度、模糊、Otsu 阈值、双线性缩放、中值去噪。
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

export function rotateRgba90(src: RgbaImage, direction: RotateDirection): RgbaImage {
  const width = src.height
  const height = src.width
  const data = new Uint8ClampedArray(width * height * 4)
  const clockwise = direction === 'right'

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const targetX = clockwise ? src.height - 1 - y : y
      const targetY = clockwise ? x : src.width - 1 - x
      const sourceOffset = (y * src.width + x) * 4
      const targetOffset = (targetY * width + targetX) * 4
      data[targetOffset] = src.data[sourceOffset]!
      data[targetOffset + 1] = src.data[sourceOffset + 1]!
      data[targetOffset + 2] = src.data[sourceOffset + 2]!
      data[targetOffset + 3] = src.data[sourceOffset + 3]!
    }
  }

  return { width, height, data }
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

/**
 * 积分图（和 + 平方和），用于 O(1) 求任意矩形窗口的均值/方差。
 * 尺寸为 (w+1) x (h+1)，第 0 行/列为 0，便于取窗口时不用判边界。
 */
export function integralImages(gray: GrayImage): {
  width: number
  height: number
  sum: Float64Array
  sumSq: Float64Array
} {
  const { width, height, data } = gray
  const iw = width + 1
  const ih = height + 1
  const sum = new Float64Array(iw * ih)
  const sumSq = new Float64Array(iw * ih)
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    let rowSumSq = 0
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x]!
      rowSum += v
      rowSumSq += v * v
      const i = (y + 1) * iw + (x + 1)
      sum[i] = sum[i - iw]! + rowSum
      sumSq[i] = sumSq[i - iw]! + rowSumSq
    }
  }
  return { width: iw, height: ih, sum, sumSq }
}

/**
 * Sauvola 局部自适应二值化（文档扫描的主流二值化算法）。
 *
 * threshold(x, y) = mean * (1 + k * (std / R - 1))
 *
 * 相比 Otsu 全局阈值，它对「一半亮一半暗」「有阴影」「纸张泛黄」的
 * 拍摄件稳定得多：阈值跟随局部均值走，阴影区域不会整块糊成黑。
 * 用积分图实现，复杂度与窗口大小无关。
 *
 * @param window 局部窗口边长（像素，自动取奇数）。默认按图像尺寸推导。
 * @param k 阈值收紧系数，越大保留的黑越少。默认 0.2（论文推荐值）。
 */
export function sauvolaBinarize(
  gray: GrayImage,
  options: { window?: number; k?: number } = {},
): GrayImage {
  const { width, height, data } = gray
  const out = new Uint8ClampedArray(width * height)
  if (width < 1 || height < 1) return { width, height, data: out }
  const autoWindow = Math.max(15, Math.round(Math.min(width, height) / 24))
  const win = Math.max(3, (options.window ?? autoWindow) | 1)
  const k = options.k ?? 0.2
  const R = 128
  const radius = (win - 1) / 2
  const { width: iw, sum, sumSq } = integralImages(gray)

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const a = y0 * iw + x0
      const b = y0 * iw + (x1 + 1)
      const c = (y1 + 1) * iw + x0
      const d = (y1 + 1) * iw + (x1 + 1)
      const total = sum[d]! - sum[b]! - sum[c]! + sum[a]!
      const totalSq = sumSq[d]! - sumSq[b]! - sumSq[c]! + sumSq[a]!
      const mean = total / area
      const variance = Math.max(0, totalSq / area - mean * mean)
      const std = Math.sqrt(variance)
      const threshold = mean * (1 + k * (std / R - 1))
      out[y * width + x] = data[y * width + x]! > threshold ? 255 : 0
    }
  }
  return { width, height, data: out }
}

/**
 * 3×3 中值滤波（RGBA，逐通道）。文档拍摄件去「椒盐噪点/纸张斑点」的主力。
 *
 * 9 元素用排序网络求中值（固定 19 次比较，无分支预测抖动）。
 * strength 0..100 为与原图的混合比例：低强度只软化噪点，100 = 完全替换。
 */
export function medianRgba(src: RgbaImage, strength: number): RgbaImage {
  const s = Math.min(1, Math.max(0, strength / 100))
  if (s <= 0 || src.width < 3 || src.height < 3) {
    return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
  }
  const { width, height, data } = src
  const out = new Uint8ClampedArray(data.length)
  const win = new Uint8Array(9)
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0
    const y2 = y < height - 1 ? y + 1 : height - 1
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0
      const x2 = x < width - 1 ? x + 1 : width - 1
      const o = (y * width + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        win[0] = data[(y0 * width + x0) * 4 + ch]!
        win[1] = data[(y0 * width + x) * 4 + ch]!
        win[2] = data[(y0 * width + x2) * 4 + ch]!
        win[3] = data[(y * width + x0) * 4 + ch]!
        win[4] = data[o + ch]!
        win[5] = data[(y * width + x2) * 4 + ch]!
        win[6] = data[(y2 * width + x0) * 4 + ch]!
        win[7] = data[(y2 * width + x) * 4 + ch]!
        win[8] = data[(y2 * width + x2) * 4 + ch]!
        const median = median9(win)
        out[o + ch] = data[o + ch]! + s * (median - data[o + ch]!)
      }
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

/** 排序网络求 9 元素中值（最优 19 次比较交换）。 */
function median9(w: Uint8Array): number {
  let t: number
  if (w[0]! > w[1]!) { t = w[0]!; w[0] = w[1]!; w[1] = t }
  if (w[3]! > w[4]!) { t = w[3]!; w[3] = w[4]!; w[4] = t }
  if (w[6]! > w[7]!) { t = w[6]!; w[6] = w[7]!; w[7] = t }
  if (w[1]! > w[2]!) { t = w[1]!; w[1] = w[2]!; w[2] = t }
  if (w[4]! > w[5]!) { t = w[4]!; w[4] = w[5]!; w[5] = t }
  if (w[7]! > w[8]!) { t = w[7]!; w[7] = w[8]!; w[8] = t }
  if (w[0]! > w[3]!) { t = w[0]!; w[0] = w[3]!; w[3] = t }
  if (w[5]! > w[8]!) { t = w[5]!; w[5] = w[8]!; w[8] = t }
  if (w[4]! > w[7]!) { t = w[4]!; w[4] = w[7]!; w[7] = t }
  if (w[3]! > w[6]!) { t = w[3]!; w[3] = w[6]!; w[6] = t }
  if (w[1]! > w[4]!) { t = w[1]!; w[1] = w[4]!; w[4] = t }
  if (w[2]! > w[5]!) { t = w[2]!; w[2] = w[5]!; w[5] = t }
  if (w[4]! > w[7]!) { t = w[4]!; w[4] = w[7]!; w[7] = t }
  if (w[4]! > w[2]!) { t = w[4]!; w[4] = w[2]!; w[2] = t }
  if (w[6]! > w[4]!) { t = w[6]!; w[6] = w[4]!; w[4] = t }
  return w[4]!
}

/**
 * 二值图斑点清除（3×3 多数滤波）：邻域内黑像素 ≥5 判黑，否则判白。
 * 只在黑白预设输出后使用，能吃掉孤立黑点/白点而不伤笔画边缘。
 * strength < 60 时只处理「与全部 8 个邻居都不同色」的孤立点（温和模式）。
 */
export function despeckleBinary(binary: GrayImage, strength: number): GrayImage {
  const s = Math.min(100, Math.max(0, strength))
  if (s <= 0 || binary.width < 3 || binary.height < 3) {
    return { width: binary.width, height: binary.height, data: new Uint8ClampedArray(binary.data) }
  }
  const { width, height, data } = binary
  const out = new Uint8ClampedArray(data.length)
  const strict = s < 60
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0
    const y2 = y < height - 1 ? y + 1 : height - 1
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0
      const x2 = x < width - 1 ? x + 1 : width - 1
      const p = y * width + x
      const v = data[p]!
      let black = 0
      for (let sy = y0; sy <= y2; sy++) {
        const row = sy * width
        for (let sx = x0; sx <= x2; sx++) {
          if (data[row + sx]! < 128) black++
        }
      }
      const isBlack = v < 128
      const blackNeighbors = isBlack ? black - 1 : black
      if (strict) {
        const flipped = isBlack ? blackNeighbors === 0 : blackNeighbors === 8
        out[p] = flipped ? (isBlack ? 255 : 0) : v
      } else {
        out[p] = black >= 5 ? 0 : 255
      }
    }
  }
  return { width, height, data: out }
}

/**
 * 光照/阴影背景估计：在缩略图上做「局部最大值（膨胀）+ 均值模糊」，
 * 再插值回原尺寸。
 *
 * - 先膨胀：把文字笔画填掉，否则模糊会把文字糊进背景，除法后字被一起提亮；
 * - 在缩略图上算：背景层本身是超低频信号，缩到 ~256px 算完再插值回去，
 *   视觉上完全等价，但把 O(w·h·r) 的膨胀从「秒级」压到「毫秒级」
 *   （2200px 全尺寸直接膨胀会卡住主线程）。
 */
export function estimateBackground(gray: GrayImage, radius?: number): GrayImage {
  const { width, height } = gray
  if (width < 4 || height < 4) return { width, height, data: new Uint8ClampedArray(gray.data) }
  const workEdge = 256
  const scale = Math.min(1, workEdge / Math.max(width, height))
  const sw = Math.max(2, Math.round(width * scale))
  const sh = Math.max(2, Math.round(height * scale))
  const small = resizeGray(gray, sw, sh)
  // 缩略图上的等效半径：默认覆盖约 1/8 短边（比任何字号都大，比阴影梯度小）
  const smallRadius = Math.max(2, Math.round((radius ?? Math.min(width, height) / 8) * scale))
  const filled = dilateGray(small, Math.max(1, Math.round(smallRadius / 2)))
  const blurred = boxBlur(filled, smallRadius)
  return resizeGray(blurred, width, height)
}

/** 双线性缩放灰度图。 */
export function resizeGray(src: GrayImage, dstW: number, dstH: number): GrayImage {
  if (dstW === src.width && dstH === src.height) {
    return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
  }
  const { data, width: sw, height: sh } = src
  const out = new Uint8ClampedArray(dstW * dstH)
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
      const top = data[y0 * sw + x0]! * (1 - fx) + data[y0 * sw + x1]! * fx
      const bottom = data[y1 * sw + x0]! * (1 - fx) + data[y1 * sw + x1]! * fx
      out[y * dstW + x] = top * (1 - fy) + bottom * fy
    }
  }
  return { width: dstW, height: dstH, data: out }
}

/** 灰度膨胀（取窗口最大值，可分离），用于填掉文字笔画。 */
export function dilateGray(gray: GrayImage, radius: number): GrayImage {
  const { width, height, data } = gray
  if (radius <= 0) return { width, height, data: new Uint8ClampedArray(data) }
  const tmp = new Uint8ClampedArray(width * height)
  const out = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let max = 0
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      for (let sx = x0; sx <= x1; sx++) {
        const v = data[row + sx]!
        if (v > max) max = v
      }
      tmp[row + x] = max
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let max = 0
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      for (let sy = y0; sy <= y1; sy++) {
        const v = tmp[sy * width + x]!
        if (v > max) max = v
      }
      out[y * width + x] = max
    }
  }
  return { width, height, data: out }
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
