import type { WritingModel } from '../../../../shared/trpg-writing'
/** Keep identities only; never carry provider credentials into component state or job settings. */
export function writingCatalog(value: unknown): WritingModel[] {
  const groups = (value as { groups?: unknown })?.groups
  if (!Array.isArray(groups)) return []
  const seen = new Set<string>()
  return groups.flatMap(g => {
    if (typeof g?.provider !== 'string' || !Array.isArray(g.models)) return []
    return g.models.flatMap((model: unknown) => {
      if (typeof model !== 'string' || !model.trim() || g.model_meta?.[model]?.disabled) return []
      const key = JSON.stringify([g.provider, model])
      if (seen.has(key)) return []
      seen.add(key)
      return [{ provider: g.provider, model }]
    })
  })
}
