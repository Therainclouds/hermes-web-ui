import { PDFDocument } from 'pdf-lib'
import type { Annotation } from './api'
export async function imageElement(data: string) {
  const blob = await (await fetch(data)).blob()
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image(); img.src = url; await img.decode(); return img
  } finally { URL.revokeObjectURL(url) }
}

/** 手写批改字体栈（中英文文书手写风），canvas 直接可用。 */
const HAND_FONT = `"Kaiti SC","KaiTi","STKaiti","FZKai-Z03","Kaiti","cursive"`
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of String(text || '').split('\n')) {
    let line = ''
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxWidth) { lines.push(line); line = ch } else line += ch
    }
    lines.push(line)
  }
  return lines
}
/** 依 "score/fullMark" 给分数标签上色：得满分=绿，0 分=红，其余=琥珀。 */
function badgeColor(content: string, fallback: string): string {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(content || '')
  if (!m) return fallback
  const score = Number(m[1]); const full = Number(m[2])
  if (full <= 0) return fallback
  if (score >= full) return '#16a34a'
  if (score <= 0) return '#dc2626'
  return '#d97706'
}

/**
 * 用「手写字体 + 虚线框」画批改痕迹，营造手写批改的错觉。
 * 支持 circle / cross / underline / pen / badge / comment。
 */
export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, handDrawn: boolean) {
  const [x, y, w, h] = a.bbox
  const color = a.color || '#dc2626'
  const lineWidth = a.width || 3
  ctx.save()
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lineWidth
  // 虚线框：模拟手画批改临摹线的脆感
  ctx.setLineDash(handDrawn ? [8, 6] : [5, 4])
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'

  if (a.kind === 'circle') {
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.globalAlpha = 0.1; ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
  } else if (a.kind === 'cross') {
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h); ctx.stroke()
  } else if (a.kind === 'underline') {
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke()
  } else if (a.kind === 'pen' && a.points) {
    ctx.setLineDash([])
    ctx.beginPath(); for (let i = 0; i < a.points.length; i += 2) { if (i === 0) ctx.moveTo(a.points[i]!, a.points[i + 1]!); else ctx.lineTo(a.points[i]!, a.points[i + 1]!) } ctx.stroke()
  } else if (a.kind === 'badge') {
    // 分数标签：虚线圆角芯片 + 手写字体分数，按对错着色
    const text = a.content || ''
    const chip = badgeColor(text, color)
    ctx.font = `600 16px ${HAND_FONT}`
    const tw = ctx.measureText(text).width
    const chipW = Math.max(tw + 16, 32); const chipH = 24
    ctx.globalAlpha = 0.18; ctx.fillStyle = chip; roundRect(ctx, x, y, chipW, chipH, 6); ctx.fill(); ctx.globalAlpha = 1
    ctx.setLineDash([4, 3]); ctx.strokeStyle = chip; roundRect(ctx, x, y, chipW, chipH, 6); ctx.stroke()
    ctx.fillStyle = chip; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
    ctx.fillText(text, x + chipW / 2, y + chipH / 2 + 1)
    ctx.textAlign = 'left'
  } else {
    // comment 评语：虚线圆角框 + 手写字体白字
    const text = a.content || ''
    const chip = a.color || '#0f172a'
    ctx.font = `400 15px ${HAND_FONT}`
    const maxW = Math.max(w, 110)
    const lines = wrapText(ctx, text, maxW)
    const boxH = 12 + lines.length * 22
    ctx.globalAlpha = 0.85; ctx.fillStyle = chip; roundRect(ctx, x, y, maxW, boxH, 8); ctx.fill(); ctx.globalAlpha = 1
    ctx.setLineDash([4, 3]); ctx.strokeStyle = chip; roundRect(ctx, x, y, maxW, boxH, 8); ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'
    lines.forEach((ln, i) => ctx.fillText(ln, x + 9, y + 7 + i * 22))
  }
  ctx.restore()
}
export async function renderPage(image: string, annotations: Annotation[], handDrawn: boolean) {
  const img = await imageElement(image); const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0)
  for (const annotation of annotations) drawAnnotation(ctx, annotation, handDrawn)
  return canvas
}
/**
 * 只渲染批改痕迹（不包含原识别件），背景默认白色（可直接打印）。
 * 传 `transparent: true` 得到透明底的叠加层图。
 */
export async function renderMarksOnly(image: string, annotations: Annotation[], handDrawn: boolean, transparent = false) {
  const img = await imageElement(image)
  const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height) }
  for (const annotation of annotations) drawAnnotation(ctx, annotation, handDrawn)
  return canvas
}
export async function pdfPages(pages: HTMLCanvasElement[]) {
  const pdf = await PDFDocument.create()
  for (const canvas of pages) {
    const img = await pdf.embedPng(canvas.toDataURL('image/png'))
    const width = 595.28; const height = width * canvas.height / canvas.width
    const page = pdf.addPage([width, height]); page.drawImage(img, { x: 0, y: 0, width, height })
  }
  return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' })
}
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000)
}
