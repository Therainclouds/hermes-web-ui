import type { WritingSettings } from './trpg-writing'
export const recapModes = ['literary', 'documentary', 'journal', 'long_novel'] as const
export const recapTones = ['epic', 'gritty', 'comedic', 'noir', 'mystery'] as const
/** Illustration slots a chronicle can carry: the book cover or a chapter illustration. */
export const recapImageKinds = ['cover', 'content'] as const
export const recapImageMimes = ['image/png', 'image/jpeg', 'image/webp'] as const
export type RecapImageKind = typeof recapImageKinds[number]
export type RecapImageMime = typeof recapImageMimes[number]
/**
 * Metadata for one chronicle illustration. The bytes live beside the Markdown
 * chronicle (`recaps/`), so the reader page can fetch them through the same
 * profile-scoped API; the entry only records what exists.
 */
export interface RecapImage {
  kind: RecapImageKind
  /** Content images may be bound to one chapter; absent means "whole chronicle". */
  chapterId?: string
  mime: RecapImageMime
  createdAt: number
  /** Image model/provider label for display; never required. */
  model?: string
  /** The prompt used, so the reader can show/redo the same picture. */
  prompt?: string
}
export interface RecapOptions {
  writing?: WritingSettings
  mode: typeof recapModes[number]
  tone: typeof recapTones[number]
  chapterHint?: number
  /** Long novel target; actual length depends on usable source material. */
  targetChars?: number
  characters: { id: string; name: string; player?: string; appearance?: string }[]
  setting: string
  style: string
}
export interface RecapEntry extends RecapOptions {
  id: string
  meetingId: string
  title: string
  chapters: { id: string; title: string; startQuote: string; endQuote: string; body: string; highlights: { characterId: string; name: string; action: string; evidence: string }[] }[]
  timeline: { time: string; text: string }[]
  /** Chronicle illustrations; old entries have none. */
  images?: RecapImage[]
  generatedAt: number
  skillUsed: string
}
