/**
 * DOCX text extractor.
 *
 * The `docx` npm package is for creating DOCX files, not reading them.
 * DOCX is a ZIP archive with `word/document.xml` inside; we use `jszip`
 * (already a transitive dep) to unzip and extract text from `<w:t>` runs.
 *
 * Corrupt DOCX files throw `ExtractError({ kind: 'corrupt' })`.
 */

import { readFile } from 'fs/promises'
import { ExtractError, countTokens, type ExtractResult } from './index'

interface JSZipModule {
  loadAsync(data: Uint8Array): Promise<{
    file(name: string): { async(type: 'string'): Promise<string> } | null
    files: Record<string, unknown>
  }>
  new (): unknown
}

interface JSZipStatic {
  loadAsync(data: Uint8Array): Promise<{
    file(name: string): { async(type: 'string'): Promise<string> } | null
    files: Record<string, unknown>
  }>
}

let _jszip: JSZipStatic | null = null

async function loadJszip(): Promise<JSZipStatic> {
  if (_jszip) return _jszip
  // Dynamic import because jszip is CJS and vitest transforms source to ESM.
  const mod = (await import('jszip')) as unknown as { default: JSZipStatic } & JSZipStatic
  // jszip exports itself as both default and named — handle both shapes.
  _jszip = mod.default ?? mod
  return _jszip
}

/**
 * Extract text content from DOCX XML. The `<w:t>` tags inside `<w:r>` runs
 * hold the visible text. We join them with newlines between paragraphs
 * (each `<w:p>` becomes a paragraph break).
 */
function extractTextFromDocxXml(xml: string): string {
  const paragraphs: string[] = []

  // Match each paragraph element.
  const paragraphRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g
  let pMatch: RegExpExecArray | null
  while ((pMatch = paragraphRegex.exec(xml)) !== null) {
    const paragraphXml = pMatch[0]
    // Extract all <w:t ...>text</w:t> runs in this paragraph.
    const textRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let tMatch: RegExpExecArray | null
    const runs: string[] = []
    while ((tMatch = textRegex.exec(paragraphXml)) !== null) {
      runs.push(tMatch[1])
    }
    if (runs.length > 0) {
      paragraphs.push(runs.join(''))
    }
  }

  return paragraphs.join('\n')
}

export async function docxExtractor(filePath: string): Promise<ExtractResult> {
  const JSZip = await loadJszip()

  let data: Uint8Array
  try {
    const buf = await readFile(filePath)
    data = new Uint8Array(buf)
  } catch (err) {
    throw new ExtractError(`Failed to read DOCX file: ${filePath}`, {
      kind: 'io',
      cause: err,
    })
  }

  let zip: Awaited<ReturnType<JSZipStatic['loadAsync']>>
  try {
    zip = await JSZip.loadAsync(data)
  } catch (err) {
    throw new ExtractError(`Failed to unzip DOCX: ${filePath}`, {
      kind: 'corrupt',
      cause: err,
    })
  }

  const docXmlFile = zip.file('word/document.xml')
  if (!docXmlFile) {
    throw new ExtractError(`Invalid DOCX (missing word/document.xml): ${filePath}`, {
      kind: 'corrupt',
    })
  }

  let xml: string
  try {
    xml = await docXmlFile.async('string')
  } catch (err) {
    throw new ExtractError(`Failed to read DOCX XML: ${filePath}`, {
      kind: 'corrupt',
      cause: err,
    })
  }

  const text = extractTextFromDocxXml(xml).trim()
  return {
    text,
    tokenCount: countTokens(text),
  }
}
