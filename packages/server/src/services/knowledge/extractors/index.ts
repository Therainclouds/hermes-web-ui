/**
 * Text extractor registry for the knowledge plugin.
 *
 * Each extractor maps a lowercased file extension to an async function that
 * returns `{ text, tokenCount }`. Unknown extensions resolve to a metadata-only
 * sentinel (`{ text: '', tokenCount: 0 }`) — the document stays `status=indexed`
 * per architecture §10.2.
 *
 * Token counting uses `js-tiktoken` / `cl100k_base` exclusively (audit P2-8).
 */

import { createHash } from 'crypto'
import { extname } from 'path'
import { getEncoding, type Encoding } from 'js-tiktoken'
import { markdownExtractor } from './markdown'
import { textExtractor } from './text'
import { pdfExtractor } from './pdf'
import { docxExtractor } from './docx'

// --- Error class ---

export interface ExtractErrorOptions {
  kind: 'corrupt' | 'unsupported' | 'io'
  cause?: unknown
}

export class ExtractError extends Error {
  readonly kind: ExtractErrorOptions['kind']
  readonly cause?: unknown

  constructor(message: string, options: ExtractErrorOptions) {
    super(message)
    this.name = 'ExtractError'
    this.kind = options.kind
    this.cause = options.cause
  }
}

// --- Result type ---

export interface ExtractResult {
  text: string
  tokenCount: number
}

// --- Token counter (shared, lazy-init) ---

let _encoding: Encoding | null = null

function getCl100k(): Encoding {
  if (!_encoding) {
    _encoding = getEncoding('cl100k_base')
  }
  return _encoding
}

export function countTokens(text: string): number {
  if (!text) return 0
  return getCl100k().encode(text).length
}

// --- Extractor function type ---

export type ExtractorFn = (filePath: string) => Promise<ExtractResult>

// --- Registry ---

const registry = new Map<string, ExtractorFn>()

export function registerExtractor(ext: string, fn: ExtractorFn): void {
  registry.set(ext.toLowerCase(), fn)
}

export function getExtractor(ext: string): ExtractorFn | undefined {
  return registry.get(ext.toLowerCase())
}

export function getRegisteredExtensions(): string[] {
  return [...registry.keys()]
}

// --- Public dispatch ---

/**
 * Extract text from a file. Unknown extensions return the metadata-only
 * sentinel `{ text: '', tokenCount: 0 }` — not an error.
 */
export async function extract(filePath: string): Promise<ExtractResult> {
  const ext = extname(filePath).toLowerCase()
  const fn = registry.get(ext)
  if (!fn) {
    return { text: '', tokenCount: 0 }
  }
  return fn(filePath)
}

// --- Register built-in extractors ---

registerExtractor('.md', markdownExtractor)
registerExtractor('.markdown', markdownExtractor)
registerExtractor('.txt', textExtractor)
registerExtractor('.text', textExtractor)
registerExtractor('.pdf', pdfExtractor)
registerExtractor('.docx', docxExtractor)

/** Kept for backward compat with spec; extractors are registered at import time. */
export function ensureBuiltinExtractorsRegistered(): void {
  // no-op — extractors are registered eagerly on module load.
}

// --- Helpers re-exported for other modules ---

export { createHash }
