/**
 * Pure helpers behind the ancient-book chronicle reader.
 *
 * Everything here is framework-free so pagination and chapter splitting can be
 * unit-tested without a DOM. The Vue component owns the actual measurement and
 * flip animation; this module decides *what* goes on each page.
 */

export interface ChronicleChapter {
  /** Chapter heading text without the leading `##`. */
  title: string
  /** Chapter body markdown (no heading). */
  markdown: string
}

export interface TimelineRow {
  time: string
  text: string
}

/**
 * One illustration loaded for the reader. The bytes are fetched with auth
 * headers and exposed as an object URL; `chapterId` binds a content image to a
 * chapter, absent meaning "illustrates the whole chronicle".
 */
export interface BookImage {
  kind: 'cover' | 'content'
  chapterId?: string
  url: string
  label?: string
}

/** One paper face of the reader: cover, chronicle page, timeline appendix or filler. */
export interface BookPage {
  variant: 'cover' | 'content' | 'appendix' | 'blank'
  html?: string
  number?: number
}

export interface ChronicleDocument {
  title: string
  chapters: ChronicleChapter[]
}

/**
 * Split a chronicle Markdown document into its `#` title and `##` chapters.
 * Text before the first `##` (beyond the title) belongs to the cover, so it is
 * not duplicated into a chapter.
 */
export function splitChronicle(markdown: string): ChronicleDocument {
  const normalized = (markdown || '').replace(/\r\n/g, '\n').trim()
  const title = /^#\s+(.+)$/m.exec(normalized)?.[1]?.trim() ?? ''
  const chapters: ChronicleChapter[] = []
  let current: { title: string; body: string[] } | null = null
  for (const line of normalized.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) chapters.push({ title: current.title, markdown: current.body.join('\n').trim() })
      current = { title: heading[1].trim(), body: [] }
      continue
    }
    if (current) current.body.push(line)
  }
  if (current) chapters.push({ title: current.title, markdown: current.body.join('\n').trim() })
  return { title, chapters }
}

/**
 * Split a chapter body into Markdown blocks on blank lines. Fenced code blocks
 * stay together even when they contain blank lines.
 */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let buffer: string[] = []
  let fence = false
  const flush = () => {
    const value = buffer.join('\n').trim()
    if (value) blocks.push(value)
    buffer = []
  }
  for (const line of (markdown || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      buffer.push(line)
      continue
    }
    if (!fence && !line.trim()) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

/**
 * Split prose into sentence-sized units, keeping every character (the units
 * rejoin to the original). Used to fill a chapter-opening page so a `##`
 * heading is never stranded alone; an over-long single sentence stays whole and
 * falls back to `splitLongBlock`.
 */
export function splitSentences(block: string): string[] {
  const units = block.split(/(?<=[。！？!?；;…])/).filter(unit => unit.length > 0)
  return units.length ? units : [block]
}

/**
 * Break an over-long block at sentence boundaries so it can flow across pages.
 * A page cannot hold an atomic block, and clipping mid-sentence looks broken in
 * a book; splitting keeps every word, at the cost that Markdown emphasis which
 * spans the cut loses its markers. Generated chronicle prose is plain, so this
 * is a cosmetic edge case rather than a content change.
 */
export function splitLongBlock(block: string, budget: number): string[] {
  if (block.length <= budget) return [block]
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }
  for (const raw of block.split(/(?<=[。！？!?；;…])/)) {
    let sentence = raw
    while (sentence.length > budget) {
      // A single sentence longer than a whole page: split on a comma near the
      // budget, or hard-cut at 60% so we cannot loop forever.
      const comma = Math.max(sentence.lastIndexOf('，', budget), sentence.lastIndexOf(',', budget), sentence.lastIndexOf('、', budget))
      const cut = comma > budget * 0.4 ? comma : Math.floor(budget * 0.6)
      flush()
      chunks.push(sentence.slice(0, cut + 1).trim())
      sentence = sentence.slice(cut + 1)
    }
    if ((current + sentence).length > budget) flush()
    current += sentence
  }
  flush()
  return chunks.filter(Boolean)
}

/**
 * Character-budget pagination. Used as the fallback when the DOM measurer is
 * unavailable (for example in unit tests) and to derive a safe chunk size for
 * `splitLongBlock`.
 */
export function paginateByLength(blocks: string[], budget = 520): string[][] {
  const pages: string[][] = []
  let current: string[] = []
  let used = 0
  const flush = () => {
    if (current.length) {
      pages.push(current)
      current = []
      used = 0
    }
  }
  for (const block of blocks) {
    for (const piece of splitLongBlock(block, budget)) {
      if (current.length && used + piece.length > budget) flush()
      current.push(piece)
      used += piece.length
    }
  }
  flush()
  return pages
}
