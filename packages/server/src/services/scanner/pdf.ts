import { logger } from '../logger'

/**
 * 极简 PDF 生成器（仅支持嵌入 JPEG / PNG 图片）。
 *
 * 故意不引入 pdf-lib 等依赖：扫描插件的 PDF 由「扫描图」构成主体，OCR 文本
 * 单独以 Markdown / TXT 形式保存（用户可手动归档 / 二次导出）。这避免了
 * 不带中文字体导致的 '?' 占位问题，也省去了 ~200KB 的额外依赖。
 *
 * 输出结构（PDF 1.4）：
 *   %PDF-1.4
 *   1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
 *   2 0 obj << /Type /Pages /Kids [...] /Count N >> endobj
 *   3..N+2 0 obj << /Type /Page ... /Contents ... >> endobj
 *   N+3..2N+2 0 obj << /Length L >> stream ... >> endobj
 *   xref ... trailer << /Size ... /Root 1 0 R >> startxref ... %%EOF
 *
 * 图片居中、保持纵横比，按 A4 页面内边距排版。JPEG 走 DCTDecode 直通，
 * PNG 走 FlateDecode 直通（不重新压缩）。
 */

const A4_WIDTH_PT = 595
const A4_HEIGHT_PT = 842
const MARGIN_PT = 36

export interface ScannerPdfImagePage {
  buffer: Buffer
  mime: string
}

interface CompiledImage {
  buffer: Buffer
  width: number
  height: number
  filter: 'DCTDecode' | 'FlateDecode'
}

function pickImageFilter(mime: string): 'DCTDecode' | 'FlateDecode' {
  if (mime === 'image/png') return 'FlateDecode'
  return 'DCTDecode'
}

/** 保持纵横比地把图片放进 A4 页面内边距区域。 */
function fitImage(width: number, height: number) {
  const innerW = A4_WIDTH_PT - MARGIN_PT * 2
  const innerH = A4_HEIGHT_PT - MARGIN_PT * 2
  const ratio = Math.min(innerW / width, innerH / height, 1)
  return { w: Math.max(1, width * ratio), h: Math.max(1, height * ratio) }
}

interface ImageDims { width: number; height: number }

function readImageDimensions(buf: Buffer, mime: string): ImageDims {
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    let offset = 2
    while (offset < buf.length - 9) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      if (marker === 0xc0 || marker === 0xc2 || marker === 0xc1) {
        const height = buf.readUInt16BE(offset + 5)
        const width = buf.readUInt16BE(offset + 7)
        return { width, height }
      }
      const len = buf.readUInt16BE(offset + 2)
      offset += 2 + len
    }
  } else if (mime === 'image/png') {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      return { width, height }
    }
  }
  return { width: 1280, height: 960 }
}

/**
 * 把图片居中放置在 PDF 页面内的 cm/Draw 矩阵参数。
 * 输出格式：`W 0 0 H X Y cm`（PDF 操作符 cm = concat matrix）。
 */
function buildContentStream(image: { width: number; height: number; name: string }): string {
  const { w, h } = fitImage(image.width, image.height)
  const x = MARGIN_PT + ((A4_WIDTH_PT - MARGIN_PT * 2) - w) / 2
  const y = MARGIN_PT + ((A4_HEIGHT_PT - MARGIN_PT * 2) - h) / 2
  return [
    'q',
    `${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm`,
    `/${image.name} Do`,
    'Q',
  ].join('\n')
}

export function buildScannerImagePdf(images: ScannerPdfImagePage[]): Buffer {
  if (!images || images.length === 0) {
    const err: any = new Error('scanner: no images to build PDF')
    err.status = 400
    err.code = 'scanner_pdf_no_images'
    throw err
  }
  const compiled: CompiledImage[] = images.map((img) => {
    const dims = readImageDimensions(img.buffer, img.mime)
    return { buffer: img.buffer, width: dims.width, height: dims.height, filter: pickImageFilter(img.mime) }
  })

  // Object index layout:
  //   1: Catalog
  //   2: Pages
  //   3..3+N-1: Image XObjects (one per page)
  //   3+N..3+2N-1: Page objects
  //   3+2N..3+3N-1: Content streams (one per page)
  const N = compiled.length
  const totalObjects = 3 + N * 3

  const offsets: number[] = new Array(totalObjects).fill(0)
  let body = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')

  function append(chunk: Buffer) { body = Buffer.concat([body, chunk]) }
  function recordObject(index: number, content: Buffer) {
    offsets[index] = body.length
    append(Buffer.from(`${index} 0 obj\n`, 'binary'))
    append(content)
    append(Buffer.from('\nendobj\n', 'binary'))
  }

  recordObject(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'binary'))
  const kids = Array.from({ length: N }, (_, i) => `${3 + N + i} 0 R`).join(' ')
  recordObject(2, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${N} >>`, 'binary'))

  // Image XObjects
  for (let i = 0; i < N; i += 1) {
    const img = compiled[i]!
    const idx = 3 + i
    const dict = `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${img.filter} /Length ${img.buffer.length} >>`
    offsets[idx] = body.length
    append(Buffer.from(`${idx} 0 obj\n${dict}\nstream\n`, 'binary'))
    append(img.buffer)
    append(Buffer.from('\nendstream\nendobj\n', 'binary'))
  }

  // Page objects
  for (let i = 0; i < N; i += 1) {
    const pageIndex = 3 + N + i
    const contentIndex = 3 + 2 * N + i
    const imgObjIndex = 3 + i
    const pageDict = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}] /Resources << /XObject << /Im0 ${imgObjIndex} 0 R >> >> /Contents ${contentIndex} 0 R >>`
    recordObject(pageIndex, Buffer.from(pageDict, 'binary'))
  }

  // Content streams
  for (let i = 0; i < N; i += 1) {
    const contentIndex = 3 + 2 * N + i
    const stream = Buffer.from(buildContentStream({ width: compiled[i]!.width, height: compiled[i]!.height, name: 'Im0' }) + '\n', 'binary')
    const dict = `<< /Length ${stream.length} >>`
    offsets[contentIndex] = body.length
    append(Buffer.from(`${contentIndex} 0 obj\n${dict}\nstream\n`, 'binary'))
    append(stream)
    append(Buffer.from('\nendstream\nendobj\n', 'binary'))
  }

  // xref
  const xrefOffset = body.length
  const xrefLines: string[] = ['xref', `0 ${totalObjects}`, '0000000000 65535 f ']
  for (let i = 1; i < totalObjects; i += 1) {
    xrefLines.push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n `)
  }
  const trailer = `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  append(Buffer.from(xrefLines.join('\n') + '\n' + trailer, 'binary'))

  return body
}
