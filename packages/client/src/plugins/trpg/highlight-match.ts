/**
 * Does a highlight actually belong to a scene of the novel?
 *
 * Highlight transcripts and novel scene ranges are both slices of the same ASR
 * stream, but they are captured at different times and ASR wording drifts, so an
 * exact sentence-index match is impossible. This module answers the weaker,
 * still useful question — "is there enough shared wording that this picture
 * illustrates this scene?" — with a framework-free heuristic that can be unit
 * tested without the panel, IndexedDB or the server.
 *
 * The score is the fraction of the highlight's sentences that have a counterpart
 * in the candidate rows, so a highlight copied from a scene scores 1 and a
 * highlight about a different scene scores near 0.
 */

/** One transcript row handed to the matcher (mirrors the novel evidence rows). */
export interface SourceRow {
  index: number
  text: string
  speaker?: string
}

export interface HighlightMatch {
  /** 0..1 fraction of comparable highlight sentences found in the rows. */
  score: number
  /** Rows the highlight appears to be about, in transcript order. */
  matched: SourceRow[]
  /** Convenience flag for the UI; true when `score` reaches the related threshold. */
  related: boolean
}

/** Sentences shorter than this carry too little signal and are ignored. */
const MIN_SENTENCE_CHARS = 6
/** Share of a sentence's character bigrams the row must contain to count as a hit. */
const BIGRAM_HIT_RATIO = 0.6
/** Default score at which a highlight is considered related to a scene. */
export const HIGHLIGHT_RELATED_SCORE = 0.34

/**
 * Fold a sentence to comparable content: drop the leading `[speaker]` marker and
 * every space, punctuation mark or symbol. CJK text has no spaces, so stripping
 * punctuation is what makes two ASR variants line up.
 */
export function normalizeForMatch(value: string): string {
  return (value || '')
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

function bigrams(value: string): string[] {
  const grams: string[] = []
  for (let i = 0; i + 2 <= value.length; i++) grams.push(value.slice(i, i + 2))
  return grams
}

/**
 * Share of the shorter text's character bigrams contained in the longer text.
 * Returns 1 for strict containment of a long enough fragment, so a short quote
 * inside a long row still counts.
 */
export function textOverlap(left: string, right: string): number {
  const a = normalizeForMatch(left)
  const b = normalizeForMatch(right)
  if (!a || !b) return 0
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < MIN_SENTENCE_CHARS) return 0
  if (long.includes(short)) return 1
  const grams = bigrams(short)
  if (!grams.length) return 0
  const hits = grams.reduce((count, gram) => count + (long.includes(gram) ? 1 : 0), 0)
  return hits / grams.length
}

/** Split a stored highlight transcript into its non-empty lines. */
export function highlightSentences(text: string): string[] {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

/**
 * Match one highlight text against the candidate rows of a scene.
 *
 * `threshold` is the related-score cut-off, exposed so a caller can be stricter
 * for automatic binding and looser for a manual suggestion list.
 */
export function matchHighlight(text: string, rows: SourceRow[], threshold = HIGHLIGHT_RELATED_SCORE): HighlightMatch {
  const sentences = highlightSentences(text).filter(sentence => normalizeForMatch(sentence).length >= MIN_SENTENCE_CHARS)
  const matched = new Map<number, SourceRow>()
  let hits = 0
  for (const sentence of sentences) {
    let hit = false
    for (const row of rows || []) {
      if (textOverlap(sentence, row.text) >= BIGRAM_HIT_RATIO) {
        matched.set(row.index, row)
        hit = true
      }
    }
    if (hit) hits++
  }
  const score = sentences.length ? hits / sentences.length : 0
  return { score, matched: [...matched.values()].sort((a, b) => a.index - b.index), related: score >= threshold }
}

/** Human-readable percentage for the card badge. */
export function matchPercent(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100)
}
