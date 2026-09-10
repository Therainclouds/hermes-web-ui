/**
 * PDF text extractor using pdfjs-dist (v5 legacy build via dynamic import).
 *
 * The legacy build is required because pdfjs-dist v5 ships only ESM, and
 * the server compiles to CJS. The legacy build provides a CJS-compatible
 * entry via `pdfjs-dist/legacy/build/pdf.mjs` (loaded with dynamic import).
 *
 * Corrupt or password-protected PDFs throw `ExtractError({ kind: 'corrupt' })`.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

// pdfjs-dist types (loaded dynamically).
interface PdfjsModule {
  getDocument: (data: Uint8Array) => {
    promise: Promise<{
      numPages: number
      getPage(pageNum: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str: string }> }>
      }>
    }>
  }
}

let _pdfjs: PdfjsModule | null = null

async function loadPdfjs(): Promise<PdfjsModule> {
  if (_pdfjs) return _pdfjs
  try {
    // pdfjs-dist v5 is ESM-only; use the legacy build for Node/CJS.
    _pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule
    return _pdfjs
  } catch (err) {
    throw new ExtractError('Failed to load pdfjs-dist — is the dependency installed?', {
      kind: 'io',
      cause: err,
    })
  }
}

export async function pdfExtractor(filePath: string): Promise<ExtractResult> {
  const pdfjs = await loadPdfjs()

  let data: Uint8Array
  try {
    const buf = await readFile(filePath)
    data = new Uint8Array(buf)
  } catch (err) {
    throw new ExtractError(`Failed to read PDF file: ${filePath}`, {
      kind: 'io',
      cause: err,
    })
  }

  let doc: { numPages: number; getPage(pageNum: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str: string }> }> }> }
  try {
    doc = await pdfjs.getDocument(data).promise
  } catch (err) {
    throw new ExtractError(`Failed to parse PDF: ${filePath}`, {
      kind: 'corrupt',
      cause: err,
    })
  }

  const textParts: string[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items.map((item) => item.str).join(' ')
      textParts.push(pageText)
    }
  } catch (err) {
    throw new ExtractError(`Failed to extract text from PDF pages: ${filePath}`, {
      kind: 'corrupt',
      cause: err,
    })
  }

  const text = textParts.join('\n').trim()
  return {
    text,
    tokenCount: countTokens(text),
  }
}
