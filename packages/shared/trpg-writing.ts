export const writingStages = ['extract', 'plan', 'write', 'review', 'vision'] as const
export type WritingStage = typeof writingStages[number]
export interface WritingModel { model: string; provider: string }
export interface WritingSettings {
  economy?: boolean
  concurrency?: number
  targetChars?: number
  defaultModel?: WritingModel
  stages?: Partial<Record<WritingStage, WritingModel>>
  pauseAfterOutline?: boolean
  pauseAfterChapter?: boolean
  /** `warn` (default) records unresolved factual contradictions and keeps writing; `block`
   *  stops the job on the scene instead. */
  consistency?: 'warn' | 'block'
}
export interface VisualReference { id: string; description: string; evidence: { index: number; quote: string }[] }
export interface ChapterDirection {
  visualReferences?: VisualReference[]
  title: string
  guide: string
  pov: string
  pacing: 'balanced' | 'slow' | 'fast'
  focus: string
  avoid: string
  targetChars?: number
}
export interface HarnessControls {
  revision: number
  settings: WritingSettings
  chapters: Record<string, ChapterDirection>
  epochs: Record<string, number>
  approvedOutline: boolean
  approvedChapters: number[]
}
/** Shared whitelist: configuration stores model identities, never credentials. */
export function parseWritingSettings(raw: unknown): WritingSettings {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_writing_settings')
  const v = raw as Record<string, any>
  const route = (r: any): WritingModel | undefined => {
    if (r == null) return undefined
    if (typeof r !== 'object' || typeof r.model !== 'string' || typeof r.provider !== 'string' || !r.model.trim() || !r.provider.trim() || r.model.length > 200 || r.provider.length > 100 || /[\r\n]/.test(r.model + r.provider)) throw new Error('invalid_writing_settings')
    return { model: r.model.trim(), provider: r.provider.trim() }
  }
  const result: WritingSettings = {}
  if (v.targetChars != null) {
    if (!Number.isInteger(v.targetChars) || v.targetChars < 5000 || v.targetChars > 60000) throw new Error('invalid_writing_settings')
    result.targetChars = v.targetChars
  }
  if (v.concurrency != null) {
    if (!Number.isInteger(v.concurrency) || v.concurrency < 1 || v.concurrency > 4) throw new Error('invalid_writing_settings')
    result.concurrency = v.concurrency
  }
  const defaultModel = route(v.defaultModel)
  if (defaultModel) result.defaultModel = defaultModel
  if (v.stages != null) {
    if (typeof v.stages !== 'object' || Array.isArray(v.stages) || Object.keys(v.stages).some(k => !writingStages.includes(k as WritingStage))) throw new Error('invalid_writing_settings')
    result.stages = {}
    for (const key of writingStages) { const selected = route(v.stages[key]); if (selected) result.stages[key] = selected }
  }
  for (const key of ['pauseAfterOutline', 'pauseAfterChapter', 'economy'] as const) {
    if (v[key] != null) { if (typeof v[key] !== 'boolean') throw new Error('invalid_writing_settings'); result[key] = v[key] }
  }
  if (v.consistency != null) {
    if (!['warn', 'block'].includes(v.consistency)) throw new Error('invalid_writing_settings')
    result.consistency = v.consistency
  }
  return result
}
export function selectWritingModel(settings: WritingSettings, stage: WritingStage): WritingModel | undefined {
  return settings.stages?.[stage] ?? settings.defaultModel
}
