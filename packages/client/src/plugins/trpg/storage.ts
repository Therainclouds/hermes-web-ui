import type { NovelVisualAnalysis } from '../../../../shared/trpg-visual'
import { parseWritingSettings, type WritingSettings } from '../../../../shared/trpg-writing'
import { cleanSheet, type CharacterSheet } from '../../../../shared/trpg'
export interface CharacterCard {
  id: string; name: string; player: string; appearance: string; card: string
  sheet?: CharacterSheet
  image?: Blob; imageName?: string
}
export interface Highlight {
  novelAssociation?: { image?: Blob; jobId: string; prompt: string; transcript: string; analysis: NovelVisualAnalysis }
  id: string; prompt: string; createdAt: number; transcript: string
  image?: Blob; imageModel?: string; referenceNames?: string[]
  /** Original filename when the image was uploaded by hand rather than generated. */
  imageName?: string
  /**
   * Short human label shown on the card. Auto highlights leave it empty and let
   * the panel fall back to a timestamp; highlights written by hand in the novel
   * workbench use it as the note that travels with the illustration.
   */
  title?: string
  /** `manual` records created in the workbench, `auto` (or absent) the ASR ones. */
  source?: 'auto' | 'manual'
  actions: { characterId: string; name: string; action: string; evidence: string }[]
}
/**
 * Highlights kept in the panel are never discarded any more: the gallery simply
 * shows this many newest cards at first and lets the user expand the rest.
 */
export const HIGHLIGHT_RECENT_LIMIT = 30
export interface ImageSettings {
  enabled: boolean; provider: string; model: string; size: string; quality: string; useReferences: boolean
  /** Opt-in: generate through the ChatGPT web project (browser bridge) instead of the image API. */
  useChatGptWeb: boolean
  /** Optional per-campaign project URL; empty means "use the server-side default". */
  chatGptWebProjectUrl: string
}
export const defaultImageSettings = (): ImageSettings => ({ enabled: false, provider: '', model: '', size: '1536x1024', quality: 'auto', useReferences: true, useChatGptWeb: false, chatGptWebProjectUrl: '' })

/**
 * Which slice of the ASR transcript feeds a generation.
 *
 * - `all`: every finalized sentence (the chronicle default — a chronicle should
 *   cover the whole session).
 * - `recent`: the last `recentCount` sentences (the highlight default — a scene
 *   image only needs the current moment).
 * - `segments`: explicit sentence ranges picked from the paragraph picker, so a
 *   user can point the model at exactly the paragraphs that matter.
 */
export type AsrScopeMode = 'all' | 'recent' | 'segments'
export interface AsrSegment { from: number; to: number }
export interface AsrScope { mode: AsrScopeMode; recentCount: number; segments: AsrSegment[] }
export interface AsrSettings { highlight: AsrScope; recap: AsrScope }
export const defaultAsrScope = (mode: AsrScopeMode, recentCount = 60): AsrScope => ({ mode, recentCount, segments: [] })
export const defaultAsrSettings = (): AsrSettings => ({ highlight: defaultAsrScope('recent', 60), recap: defaultAsrScope('all', 60) })
/** Sentence counts offered by the scope dialog; the numeric input also accepts a custom value. */
export const ASR_RECENT_PRESETS = [10, 20, 40, 60, 100, 200] as const
export const ASR_MAX_RECENT = 2000
export interface Paragraph { id: string; from: number; to: number; speaker: string; preview: string; chars: number }
interface Sentence { text: string; speaker?: string; timestamp?: number }

export interface Campaign { writingSettings?: WritingSettings; imageSettings?: ImageSettings; asrSettings?: AsrSettings; cameraId?: string; characters: CharacterCard[]; setting: string; style: string; highlights: Highlight[] }
export const emptyCampaign = (): Campaign => ({ characters: [], setting: '', style: '', highlights: [] })

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hermes-plugin-trpg', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('campaigns')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function campaignStorage(key: string, value?: Campaign): Promise<Campaign> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('campaigns', value ? 'readwrite' : 'readonly')
      const store = tx.objectStore('campaigns')
      const request = value ? store.put(value, key) : store.get(key)
      tx.oncomplete = () => resolve(value ?? request.result ?? emptyCampaign())
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

export function recentTranscript(sentences: Sentence[]): string {
  return scopedTranscript(sentences, defaultAsrScope('recent', 60))
}

function clampSegment(segment: AsrSegment, total: number): AsrSegment | null {
  const rawFrom = Number.isFinite(segment?.from) ? Math.trunc(segment.from) : NaN
  const rawTo = Number.isFinite(segment?.to) ? Math.trunc(segment.to) : rawFrom
  if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawTo < rawFrom || total <= 0) return null
  const from = Math.max(0, Math.min(rawFrom, total - 1))
  const to = Math.max(0, Math.min(rawTo, total - 1))
  return from <= to ? { from, to } : null
}
/** Coerce, sort and merge overlapping/adjacent ranges so a transcript cannot repeat a sentence. */
export function mergeSegments(segments: AsrSegment[], total: number): AsrSegment[] {
  const clean = (segments || []).map(segment => clampSegment(segment, total)).filter((segment): segment is AsrSegment => !!segment).sort((a, b) => a.from - b.from)
  const merged: AsrSegment[] = []
  for (const segment of clean) {
    const last = merged[merged.length - 1]
    if (last && segment.from <= last.to + 1) last.to = Math.max(last.to, segment.to)
    else merged.push({ ...segment })
  }
  return merged
}
/** The sentences an ASR scope resolves to, always in transcript order. */
export function scopedSentences(sentences: Sentence[], scope: AsrScope | undefined): Sentence[] {
  if (!sentences.length) return []
  const mode = scope?.mode ?? 'all'
  if (mode === 'recent') {
    const count = Math.max(1, Math.min(Math.trunc(scope?.recentCount || 1) || 1, sentences.length))
    return sentences.slice(-count)
  }
  if (mode === 'segments') {
    const picked: Sentence[] = []
    for (const segment of mergeSegments(scope?.segments || [], sentences.length)) picked.push(...sentences.slice(segment.from, segment.to + 1))
    return picked
  }
  return sentences
}
function sentenceLine(sentence: Sentence): string {
  return `${sentence.speaker ? `[${sentence.speaker}] ` : ''}${sentence.text}`
}
/**
 * Render the scoped transcript for a model request. The character cap keeps the
 * request inside the server's 12000-character validation limit and is applied
 * from the end, so the most recent narration always survives.
 */
export function scopedTranscript(sentences: Sentence[], scope: AsrScope | undefined, maxChars = 12000): string {
  return scopedSentences(sentences, scope).map(sentenceLine).join('\n').slice(-maxChars)
}
export interface ScopeStats { count: number; chars: number }
export function scopeStats(sentences: Sentence[], scope: AsrScope | undefined): ScopeStats {
  const picked = scopedSentences(sentences, scope)
  return { count: picked.length, chars: picked.reduce((sum, sentence) => sum + sentence.text.length, 0) }
}
export interface ParagraphOptions { maxSentences?: number; maxChars?: number; timeGapMs?: number }
/**
 * Group a flat sentence list into readable paragraphs for the scope picker.
 * A new paragraph starts when the speaker changes, the recording pauses for more
 * than `timeGapMs`, or the current paragraph reaches its sentence/character cap.
 */
export function buildParagraphs(sentences: Sentence[], options: ParagraphOptions = {}): Paragraph[] {
  const maxSentences = options.maxSentences ?? 8
  const maxChars = options.maxChars ?? 360
  const timeGapMs = options.timeGapMs ?? 45000
  const paragraphs: Paragraph[] = []
  let current: Paragraph | null = null
  const flush = () => { if (current) paragraphs.push(current); current = null }
  sentences.forEach((sentence, index) => {
    const speaker = (sentence.speaker || '').trim()
    const gap = index > 0 && typeof sentence.timestamp === 'number' && typeof sentences[index - 1].timestamp === 'number'
      ? sentence.timestamp - (sentences[index - 1].timestamp as number)
      : 0
    if (!current || current.speaker !== speaker || gap > timeGapMs
      || (index - current.from) >= maxSentences
      || (current.chars + sentence.text.length > maxChars && current.chars > 0)) {
      flush()
      current = { id: `${index}-${index}`, from: index, to: index, speaker, preview: sentence.text, chars: sentence.text.length }
      return
    }
    current.to = index
    current.chars += sentence.text.length
    current.preview = `${current.preview}${sentence.text}`.slice(0, 80)
    current.id = `${current.from}-${current.to}`
  })
  flush()
  return paragraphs
}

/** Build a plain IndexedDB record even after reactive arrays were filtered/replaced. */
export function snapshotCampaign(value: Campaign): Campaign {
  const asr = value.asrSettings
  return {
    writingSettings: parseWritingSettings(value.writingSettings),
    setting: value.setting, style: value.style, cameraId: value.cameraId || '',
    imageSettings: { ...defaultImageSettings(), ...value.imageSettings },
    asrSettings: {
      highlight: asr?.highlight ? { ...asr.highlight, segments: (asr.highlight.segments || []).map(segment => ({ ...segment })) } : defaultAsrScope('recent', 60),
      recap: asr?.recap ? { ...asr.recap, segments: (asr.recap.segments || []).map(segment => ({ ...segment })) } : defaultAsrScope('all', 60),
    },
    characters: value.characters.map(c => ({ id: c.id, name: c.name, player: c.player, appearance: c.appearance, card: c.card, image: c.image, imageName: c.imageName, sheet: cleanSheet(c.sheet) })),
    highlights: value.highlights.map(h => ({ novelAssociation: h.novelAssociation ? { ...JSON.parse(JSON.stringify({ ...h.novelAssociation, image: undefined })), image: h.novelAssociation.image } : undefined, id: h.id, prompt: h.prompt, createdAt: h.createdAt, transcript: h.transcript, image: h.image, imageName: h.imageName, imageModel: h.imageModel, title: h.title, source: h.source, referenceNames: h.referenceNames ? [...h.referenceNames] : [],
      actions: (h.actions || []).map(a => ({ characterId: a.characterId, name: a.name, action: a.action, evidence: a.evidence })) })),
  }
}
/** Merge stored settings with defaults so records written before a field existed still load. */
export function normalizeCampaign(value: Campaign): Campaign {
  const asr = value.asrSettings
  return {
    ...value,
    imageSettings: { ...defaultImageSettings(), ...value.imageSettings },
    asrSettings: {
      highlight: { mode: asr?.highlight?.mode || 'recent', recentCount: asr?.highlight?.recentCount || 60, segments: asr?.highlight?.segments || [] },
      recap: { mode: asr?.recap?.mode || 'all', recentCount: asr?.recap?.recentCount || 60, segments: asr?.recap?.segments || [] },
    },
  }
}
