import { setImmediate as yieldToServer } from 'node:timers/promises'
import { getEncoding } from 'js-tiktoken'
import type { Snapshot } from './recap'

let encoding: ReturnType<typeof getEncoding> | undefined
/** Budget estimator, not a claim about the selected provider's exact tokenizer. */
export function tokens(value: unknown): number {
  encoding ??= getEncoding('cl100k_base')
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  // Bound BPE work even for pathological ASR without punctuation/whitespace.
  // Window boundaries can overestimate tokens slightly, which is safe for budgeting.
  let count = 0
  const windows = new Map<string, number>()
  for (let i = 0; i < text.length; i += 64) {
    const window = text.slice(i, i + 64)
    let cost = windows.get(window)
    if (cost === undefined) { cost = encoding.encode(window).length; windows.set(window, cost) }
    count += cost
  }
  return count
}
export interface Range { from: number; to: number }
export interface Material extends Range {
  kind: 'story' | 'tabletalk'
  title: string
  facts: string
  dialogueIndices: number[]
}
export interface Correction extends Range { targetFrom: number; targetTo: number; text: string }
export interface Extraction {
  segments: Material[]
  corrections: Correction[]
  memory: string
}
export interface ChapterPlan { title: string; guide: string }
export interface SceneDraft { body: string; continuity: string; warnings: string[]; covered: number[] }
export function invalid(detail: string): never {
  throw Object.assign(new Error('novel_invalid_output'), { detail })
}
export function boundedText(value: unknown, max: number, field: string, empty = false, truncate = false): string {
  if (typeof value !== 'string') invalid(field)
  if (value.length > max) return truncate ? value.slice(0, max) : invalid(field)
  if (!empty && !value.trim()) invalid(field)
  return value as string
}
export function assertRange(v: Range, from: number, to: number) {
  if (!Number.isInteger(v?.from) || !Number.isInteger(v?.to) || v.from < from || v.to < v.from || v.to > to) invalid('source range')
}
export function sourceRows(source: Snapshot, range: Range) {
  return source.sentences.slice(range.from, range.to + 1).map((s, i) => ({ index: range.from + i, ...s }))
}
/** Non-overlapping ownership; callers supply neighbouring sentences as context only. */
export async function splitTranscript(source: Snapshot, budget = 5500): Promise<Range[]> {
  const chunks: Range[] = []
  let from = 0, size = 0
  for (let i = 0; i < source.sentences.length; i++) {
    // Long recordings must not monopolize the server that is still ingesting ASR.
    if (i % 32 === 0) await yieldToServer()
    const cost = tokens({ index: i, ...source.sentences[i] }) + 2
    if (i > from && (size + cost > budget || i - from >= 120)) {
      chunks.push({ from, to: i - 1 }); from = i; size = 0
    }
    // An unusually long single ASR utterance is kept intact, never truncated.
    if (cost > 16000) invalid('single utterance exceeds input budget')
    size += cost
  }
  chunks.push({ from, to: source.sentences.length - 1 })
  return chunks
}
export function validateExtraction(v: any, range: Range): Extraction {
  if (!Array.isArray(v?.segments) || !v.segments.length || v.segments.length > 120) invalid('segments')
  let next = range.from
  const segments: Material[] = v.segments.map((s: any) => {
    assertRange(s, range.from, range.to)
    if (s.from !== next) invalid('segments must cover every owned sentence exactly once, including table talk')
    next = s.to + 1
    if (!['story', 'tabletalk'].includes(s.kind)) invalid('segment kind')
    if (!Array.isArray(s.dialogueIndices) || s.dialogueIndices.length > 120 || s.dialogueIndices.some((i: unknown) => !Number.isInteger(i) || Number(i) < s.from || Number(i) > s.to)) invalid('dialogue evidence indices')
    return { from: s.from, to: s.to, kind: s.kind, title: boundedText(s.title, 160, 'segment title'), facts: boundedText(s.facts, 1800, 'segment facts', false, true), dialogueIndices: [...new Set(s.dialogueIndices as number[])] }
  })
  if (next !== range.to + 1) invalid('unprocessed sentences')
  if (!Array.isArray(v.corrections) || v.corrections.length > 30) invalid('corrections')
  const corrections = v.corrections.map((c: any) => {
    assertRange(c, range.from, range.to)
    assertRange({ from: c.targetFrom, to: c.targetTo }, 0, c.to)
    return { from: c.from, to: c.to, targetFrom: c.targetFrom, targetTo: c.targetTo, text: boundedText(c.text, 700, 'correction text', false, true) }
  })
  return { segments, corrections, memory: boundedText(v.memory, 6000, 'rolling factual memory', true, true) }
}
export function validatePlan(v: any): ChapterPlan {
  return { title: boundedText(v?.title, 160, 'chapter title'), guide: boundedText(v?.guide, 2500, 'chapter guide', false, true) }
}
export function validateDraft(v: any, range: Range): SceneDraft {
  const body = boundedText(v?.body, 7000, 'scene body', false, true)
  if (/```|<\/?[a-z][^>]*>|^#{1,2}\s/m.test(body)) invalid('body must be prose paragraphs without HTML, code fences or book/chapter headings')
  if (!Array.isArray(v.warnings) || v.warnings.length > 20) invalid('warnings')
  if (!Array.isArray(v.covered) || v.covered.length > 120) invalid('covered source indices')
  // Tolerate out-of-range indices silently: models sometimes confuse the scene
  // range with correction indices or the prior scene's range. Filtering is safe
  // because the dialogue-coverage guard (review step) enforces scene.dialogueIndices.
  // Numeric strings are accepted for the same reason `citations()` accepts them: providers
  // routinely serialise indices as strings, and rejecting them discards a correct list.
  const covered = [...new Set(
    (v.covered as unknown[]).map(i => typeof i === 'string' && /^\d+$/.test(i) ? Number(i) : i)
      .filter((i: unknown): i is number =>
        Number.isInteger(i) && Number(i) >= range.from && Number(i) <= range.to
      )
  )]
  return { body, continuity: boundedText(v.continuity, 4000, 'continuity', true, true), warnings: v.warnings.map((w: unknown) => boundedText(w, 500, 'warning', false, true)), covered }
}

/** Code owns the dialogue-coverage invariant.
 *
 *  `covered` is bookkeeping metadata, not proof: the independent audit is what proves the
 *  manuscript reflects the source. Asking the model to restate a set of source indices was a
 *  reproducible stall — when it dropped any index the step failed validation with no usable
 *  feedback, retried four times, and repeated on every resume (one live job burned four full
 *  review calls per resume). Code can enumerate the scene's dialogue indices, so it unions them
 *  in and returns the ones the model omitted for the caller to record as an advisory warning.
 *  A reviewer that genuinely deleted a line is still caught by the audit and by the omission
 *  warnings; the harness never silently treats the union as evidence. */
export function withDialogueCoverage(draft: SceneDraft, dialogueIndices: number[]): { draft: SceneDraft; missing: number[] } {
  const present = new Set(draft.covered)
  const missing = dialogueIndices.filter(index => !present.has(index))
  if (!missing.length) return { draft, missing }
  return { draft: { ...draft, covered: [...new Set([...draft.covered, ...dialogueIndices])] }, missing }
}
