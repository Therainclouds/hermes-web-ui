/**
 * Content-aware text chunker for the knowledge plugin.
 *
 * Two modes:
 *   - 'markdown': splits at heading boundaries (## / ###); oversized sections
 *     fall back to paragraph breaks.
 *   - 'plaintext': sliding window of `chunkSize` tokens with `chunkOverlap`
 *     tokens of overlap.
 *
 * Each chunk carries a stable `contentHash = sha256(content)` so re-indexing
 * can detect drift without comparing full text.
 *
 * Token counts use `js-tiktoken` / `cl100k_base` exclusively (audit P2-8).
 */

import { createHash } from 'crypto'
import { getEncoding, type Encoding } from 'js-tiktoken'

// --- Types ---

export type ChunkKind = 'markdown' | 'plaintext'

export interface Chunk {
  content: string
  tokenCount: number
  contentHash: string
}

export interface ChunkConfig {
  /** Sliding window size in tokens (default 500). */
  chunkSize: number
  /** Overlap between windows in tokens (default 50). */
  chunkOverlap: number
  /** Markdown fallback: split section at paragraphs if section exceeds this (default 800). */
  chunkFallbackSize: number
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  chunkSize: 500,
  chunkOverlap: 50,
  chunkFallbackSize: 800,
}

// --- Internal helpers ---

let _encoding: Encoding | null = null

function getCl100k(): Encoding {
  if (!_encoding) {
    _encoding = getEncoding('cl100k_base')
  }
  return _encoding
}

function countTokens(text: string): number {
  if (!text) return 0
  return getCl100k().encode(text).length
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeChunk(content: string): Chunk {
  return {
    content,
    tokenCount: countTokens(content),
    contentHash: hashContent(content),
  }
}

// --- Markdown chunking ---

/**
 * Split markdown text at heading boundaries. A section that exceeds
 * `fallbackSize` tokens is further split at paragraph boundaries.
 */
function chunkMarkdown(text: string, config: ChunkConfig): Chunk[] {
  const { chunkFallbackSize } = config

  // Split on heading lines (## / ### / etc). We keep the heading text as
  // part of the section content.
  const headingRegex = /^(#{1,6})\s+.*$/gm

  // Find all heading positions.
  const headingPositions: number[] = []
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(text)) !== null) {
    headingPositions.push(match.index)
  }

  // Build sections from heading boundaries.
  const sections: string[] = []
  if (headingPositions.length === 0) {
    // No headings — treat the whole text as one section.
    sections.push(text)
  } else {
    // Text before the first heading (preamble) is its own section.
    if (headingPositions[0] > 0) {
      sections.push(text.slice(0, headingPositions[0]))
    }
    for (let i = 0; i < headingPositions.length; i++) {
      const start = headingPositions[i]
      const end = i + 1 < headingPositions.length ? headingPositions[i + 1] : text.length
      sections.push(text.slice(start, end))
    }
  }

  const chunks: Chunk[] = []

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    const tokens = countTokens(trimmed)
    if (tokens <= chunkFallbackSize) {
      chunks.push(makeChunk(trimmed))
    } else {
      // Oversized section — split at paragraph boundaries.
      const paragraphs = trimmed.split(/\n\n+/)
      let buffer = ''

      for (const para of paragraphs) {
        const candidate = buffer ? buffer + '\n\n' + para : para
        const candidateTokens = countTokens(candidate)

        if (candidateTokens <= chunkFallbackSize) {
          buffer = candidate
        } else {
          // Flush buffer if non-empty.
          if (buffer) {
            chunks.push(makeChunk(buffer.trim()))
          }
          // If a single paragraph exceeds fallbackSize, emit it as its own
          // chunk anyway (we don't want to lose content).
          buffer = para
        }
      }

      // Flush remaining.
      if (buffer.trim()) {
        chunks.push(makeChunk(buffer.trim()))
      }
    }
  }

  return chunks
}

// --- Plain text chunking (sliding window) ---

/**
 * Slide a window of `chunkSize` tokens across the text with `chunkOverlap`
 * tokens of overlap between consecutive windows.
 */
function chunkPlaintext(text: string, config: ChunkConfig): Chunk[] {
  const { chunkSize, chunkOverlap } = config

  if (!text.trim()) return []

  const encoding = getCl100k()
  const allTokens = encoding.encode(text)

  if (allTokens.length <= chunkSize) {
    return [makeChunk(text.trim())]
  }

  const chunks: Chunk[] = []
  const step = chunkSize - chunkOverlap
  let start = 0

  while (start < allTokens.length) {
    const end = Math.min(start + chunkSize, allTokens.length)
    const windowTokens = allTokens.slice(start, end)
    const content = encoding.decode(windowTokens).trim()

    if (content) {
      chunks.push(makeChunk(content))
    }

    if (end >= allTokens.length) break
    start += step
  }

  return chunks
}

// --- Public API ---

/**
 * Chunk text according to the specified kind and configuration.
 * Pure function: same input + config → same output in the same order.
 *
 * Empty input produces zero chunks (caller treats as metadata-only per §10.2).
 */
export function chunkText(
  text: string,
  kind: ChunkKind,
  config: Partial<ChunkConfig> = {},
): Chunk[] {
  const cfg: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...config }

  if (!text || !text.trim()) return []

  switch (kind) {
    case 'markdown':
      return chunkMarkdown(text, cfg)
    case 'plaintext':
      return chunkPlaintext(text, cfg)
    default:
      return chunkPlaintext(text, cfg)
  }
}
