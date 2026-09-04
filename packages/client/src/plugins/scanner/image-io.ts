import { applyEnhance } from './vision/enhance'
import type { EnhanceParams, RgbaImage } from './vision/types'

/**
 * Canvas <-> typed-array / dataURL 转换与增强辅助。
 * 这些是仅浏览器的 DOM 封装；算法本身在 vision/ 里保持纯函数。
 */

/** 从 <video> 取一帧画到新 canvas（长边受 maxEdge 限制）。未就绪返回 null。 */
export function drawVideoFrame(video: HTMLVideoElement, maxEdge = 2400): HTMLCanvasElement | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
  const scale = Math.min(1, maxEdge / Math.max(vw, vh))
  const w = Math.max(1, Math.round(vw * scale))
  const h = Math.max(1, Math.round(vh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, w, h)
  return canvas
}

/** 等比缩小 canvas（分析用，省 OpenCV 内存与时间）。 */
export function downscaleCanvas(source: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  if (scale === 1) return source
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(source, 0, 0, w, h)
  return canvas
}

/** 把 dataURL / <img> 绘制到 canvas（长边受 maxEdge 限制，可选）。 */
export async function canvasFromImageSource(
  source: string | HTMLImageElement | HTMLCanvasElement,
  maxEdge?: number,
): Promise<HTMLCanvasElement | null> {
  if (typeof source === 'string') {
    const img = await loadImage(source)
    return imgToCanvas(img, maxEdge)
  }
  if (source instanceof HTMLCanvasElement) {
    return maxEdge ? downscaleCanvas(source, maxEdge) : source
  }
  return imgToCanvas(source, maxEdge)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image load failed: ${url.slice(0, 60)}`))
    img.src = url
  })
}

function imgToCanvas(img: HTMLImageElement, maxEdge?: number): HTMLCanvasElement {
  const scale = maxEdge
    ? Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
    : 1
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(img, 0, 0, w, h)
  return canvas
}

/** canvas -> RGBA typed buffer。 */
export function canvasToRgba(canvas: HTMLCanvasElement): RgbaImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const data = ctx
    ? ctx.getImageData(0, 0, canvas.width, canvas.height).data
    : new Uint8ClampedArray(canvas.width * canvas.height * 4)
  return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(data) }
}

/** RGBA typed buffer -> 新 canvas。 */
export function rgbaToCanvas(img: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
    ctx.putImageData(imageData, 0, 0)
  }
  return canvas
}

/** canvas -> JPEG dataURL。 */
export function canvasToDataUrl(canvas: HTMLCanvasElement, quality = 0.92): string {
  return canvas.toDataURL('image/jpeg', quality)
}

/** 按增强参数处理 canvas，返回新 canvas（算法在 vision/enhance）。 */
export function enhanceCanvas(canvas: HTMLCanvasElement, params: EnhanceParams): HTMLCanvasElement {
  const enhanced = applyEnhance(canvasToRgba(canvas), params)
  return rgbaToCanvas(enhanced)
}

/** dataURL -> 增强 -> 新 dataURL（异步，长边可选限制）。 */
export async function enhanceDataUrl(
  source: string,
  params: EnhanceParams,
  maxEdge?: number,
): Promise<string | null> {
  try {
    const canvas = await canvasFromImageSource(source, maxEdge)
    if (!canvas) return null
    return canvasToDataUrl(enhanceCanvas(canvas, params))
  } catch {
    return null
  }
}
