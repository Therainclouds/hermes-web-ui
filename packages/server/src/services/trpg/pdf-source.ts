import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const resolveModule = createRequire(__filename)
/** Extract locally so ordinary Hermes text models can read PDFs without a vendor PDF API. */
export async function extractPdfSource(bytes: Uint8Array): Promise<string> {
  // Keep PDF.js external: its worker and CMaps must resolve relative to the installed package.
  const entry = resolveModule.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  const root = dirname(resolveModule.resolve('pdfjs-dist/package.json'))
  const { getDocument } = await import(pathToFileURL(entry).href)
  const task = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false,
    cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts') + '/', useSystemFonts: true })
  try {
    const doc = await task.promise
    const pages: string[] = []
    let remaining = 80000
    for (let n = 1; n <= Math.min(doc.numPages, 20) && remaining > 0; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const lines = content.items.filter((i: any) => typeof i.str === 'string' && i.str.trim()).map((i: any) => `[${Math.round(i.transform[4])},${Math.round(i.transform[5])}] ${i.str}`).join('\n')
      if (lines) pages.push(`Page ${n} (PDF coordinates x,y; same coordinates describe nearby labels/values):\n${lines.slice(0, remaining)}`)
      remaining -= lines.length
      page.cleanup()
    }
    if (doc.numPages > 20 || remaining <= 0) pages.push('[Extraction truncated; consult the attached PDF for remaining content.]')
    return pages.join('\n\n')
  } finally { await task.destroy() }
}
