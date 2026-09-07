import rough from 'roughjs'
import { PDFDocument } from 'pdf-lib'
import type { Annotation } from './api'
export async function imageElement(data: string) {
  const blob = await (await fetch(data)).blob()
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image(); img.src = url; await img.decode(); return img
  } finally { URL.revokeObjectURL(url) }
}
export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, handDrawn: boolean) {
  const [x, y, w, h] = a.bbox
  const color = a.color || '#dc2626'; const lineWidth = a.width || 3
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lineWidth
  const rc = rough.canvas(ctx.canvas)
  const options = { stroke: color, strokeWidth: lineWidth, roughness: handDrawn ? 1.4 : 0, seed: 17 }
  if (a.kind === 'circle') rc.ellipse(x + w / 2, y + h / 2, w, h, options)
  else if (a.kind === 'cross') { rc.line(x, y, x + w, y + h, options); rc.line(x + w, y, x, y + h, options) }
  else if (a.kind === 'underline') rc.line(x, y + h, x + w, y + h, options)
  else if (a.kind === 'pen' && a.points) {
    ctx.beginPath(); for (let i = 0; i < a.points.length; i += 2) { if (i === 0) ctx.moveTo(a.points[i]!, a.points[i + 1]!); else ctx.lineTo(a.points[i]!, a.points[i + 1]!) } ctx.stroke()
  } else {
    ctx.font = `${Math.max(16, Math.min(28, h * .7))}px sans-serif`
    let line = ''; let row = 0
    for (const char of a.content) {
      if (char === '\n' || ctx.measureText(line + char).width > w) { ctx.fillText(line, x, y + 24 + row * 30); row++; line = char === '\n' ? '' : char } else line += char
    }
    ctx.fillText(line, x, y + 24 + row * 30)
  }
  ctx.restore()
}
export async function renderPage(image: string, annotations: Annotation[], handDrawn: boolean) {
  const img = await imageElement(image); const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0)
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
