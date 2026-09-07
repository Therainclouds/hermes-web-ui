import {
  boxBlur,
  estimateBackground,
  otsuThreshold,
  rgbaToGray,
  sauvolaBinarize,
  toGrayscaleRgba,
} from './filters'
import type { EnhanceParams, GrayImage, RgbaImage } from './types'

/**
 * 文档扫描图像增强（纯 TS，typed-array，无 DOM）。
 *
 * 处理链（预设 'scan' / 'bw' 走完整扫描件流程）：
 *   1. 去阴影（flat-field）：估计光照背景层后做除法归一化 —— 这是让
 *      「桌面拍摄件」看起来像电子版的关键一步，能同时压掉手影、灯罩阴影
 *      和镜头暗角，输出接近纯白的纸面；
 *   2. 白点/黑点校正：按分位数把纸面推到 255、笔画推到接近 0；
 *   3. 二值化：Sauvola 局部自适应阈值（比 Otsu 全局阈值抗阴影）。
 *
 * 预设语义：
 *   none  原样（只走对比度/亮度/锐化滑杆）
 *   auto  自动色阶（彩色保留）
 *   gray  灰度
 *   scan  去阴影 + 白底增强的灰度扫描件（默认推荐，文字锐利、底纯白）
 *   bw    去阴影 + Sauvola 二值化（纯黑白，体积最小、最像传真/电子版）
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
  if (factor === 1 && offset === 0) {
    for (let i = 3; i < data.length; i += 4) data[i] = 255
    return { width: src.width, height: src.height, data }
  }
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
 * 去阴影（flat-field 归一化）：value / background * 255。
 *
 * 背景层来自 estimateBackground（膨胀 + 大半径模糊），代表「这块纸如果
 * 是空白的话应该有多亮」。逐像素除以它，就把不均匀光照、手影、暗角
 * 全部抹平，纸面统一到接近 255，而笔画因为远低于局部背景仍然是深色。
 */
export function removeShadowGray(gray: GrayImage, radius?: number): GrayImage {
  const bg = estimateBackground(gray, radius)
  const { width, height, data } = gray
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0; i < data.length; i++) {
    const b = bg.data[i]!
    // 背景太暗（整块欠曝）时给一个下限，避免除法炸出满屏噪点
    const denom = b < 24 ? 24 : b
    out[i] = clamp255(Math.round((data[i]! / denom) * 255))
  }
  return { width, height, data: out }
}

/**
 * 白点 / 黑点校正：按分位数确定纸面白点与笔画黑点后线性拉伸。
 * whiteQuantile 附近及以上全部推到 255（纸面纯白），黑点推到 0。
 */
export function normalizePaper(
  gray: GrayImage,
  options: { whiteQuantile?: number; blackQuantile?: number } = {},
): GrayImage {
  const { width, height, data } = gray
  const whiteQ = options.whiteQuantile ?? 0.82
  const blackQ = options.blackQuantile ?? 0.02
  const hist = new Float64Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]!]!++
  const total = data.length || 1
  const quantile = (q: number): number => {
    let acc = 0
    const target = total * q
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!
      if (acc >= target) return v
    }
    return 255
  }
  let black = quantile(blackQ)
  let white = quantile(whiteQ)
  if (white - black < 16) {
    // 动态范围过小（几乎空白页 / 全黑页）：不拉伸，避免把噪点放大成脏点
    return { width, height, data: new Uint8ClampedArray(data) }
  }
  // 略微留白余量，避免把浅灰笔画一起吃掉
  black = Math.max(0, black - 6)
  white = Math.min(255, white + 2)
  const scale = 255 / (white - black)
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0; i < data.length; i++) {
    out[i] = clamp255(Math.round((data[i]! - black) * scale))
  }
  return { width, height, data: out }
}

function grayToRgba(gray: GrayImage): RgbaImage {
  const out = new Uint8ClampedArray(gray.width * gray.height * 4)
  for (let i = 0; i < gray.data.length; i++) {
    const v = gray.data[i]!
    const o = i * 4
    out[o] = v
    out[o + 1] = v
    out[o + 2] = v
    out[o + 3] = 255
  }
  return { width: gray.width, height: gray.height, data: out }
}

/**
 * 扫描件灰度化：去阴影 + 白底归一化 + 轻度局部对比增强。
 * 结果是「灰度电子版」观感：底纯白、字深、灰阶层次保留（照片/印章不会被拍平）。
 */
export function toScanGray(src: RgbaImage): RgbaImage {
  const gray = rgbaToGray(src)
  const flat = removeShadowGray(gray)
  const normalized = normalizePaper(flat)
  return grayToRgba(localContrastGray(normalized, 0.35))
}

/**
 * 轻量局部对比增强（unsharp on luma，大半径）：把笔画边缘压深、纸面留白，
 * 视觉上更接近真实扫描仪输出。amount 0..1。
 */
export function localContrastGray(gray: GrayImage, amount: number): GrayImage {
  if (amount <= 0) return { width: gray.width, height: gray.height, data: new Uint8ClampedArray(gray.data) }
  const radius = Math.max(1, Math.round(Math.min(gray.width, gray.height) / 200))
  const blurred = boxBlur(gray, radius)
  const out = new Uint8ClampedArray(gray.data.length)
  for (let i = 0; i < gray.data.length; i++) {
    const v = gray.data[i]!
    out[i] = clamp255(Math.round(v + amount * (v - blurred.data[i]!)))
  }
  return { width: gray.width, height: gray.height, data: out }
}

/**
 * 黑白文档化：去阴影后走 Sauvola 局部自适应阈值。
 *
 * 之前是「灰度 + Otsu 全局阈值」，一旦画面里有阴影或双页亮度不一致，
 * 暗的那半页会整块变黑。现在先 flat-field 去阴影再局部阈值，阴影区
 * 也能正确分出文字。极端低对比时回退到 Otsu，避免纯噪点输出。
 */
export function toBlackAndWhite(src: RgbaImage): RgbaImage {
  const gray = rgbaToGray(src)
  const flat = removeShadowGray(gray)
  const binary = sauvolaBinarize(flat)
  let black = 0
  for (let i = 0; i < binary.data.length; i++) if (binary.data[i] === 0) black++
  const ratio = binary.data.length > 0 ? black / binary.data.length : 0
  // 全白（漏字）或近全黑（噪点爆炸）时回退到全局 Otsu
  if (ratio < 0.0005 || ratio > 0.6) {
    const t = otsuThreshold(flat.data)
    const out = new Uint8ClampedArray(flat.data.length)
    for (let i = 0; i < flat.data.length; i++) out[i] = flat.data[i]! > t ? 255 : 0
    return grayToRgba({ width: src.width, height: src.height, data: out })
  }
  return grayToRgba(binary)
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
 *   contrast/brightness 线性调整 → 预设（auto 色阶 / gray / scan / bw）→ 锐化。
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
    case 'scan':
      img = toScanGray(img)
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

/** 判断某预设的输出是否为纯黑白（PDF 可用 1bpp 无损嵌入）。 */
export function isBilevelPreset(preset: EnhanceParams['preset']): boolean {
  return preset === 'bw'
}
