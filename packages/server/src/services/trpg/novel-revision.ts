import { invalid, validateDraft, type SceneDraft, type Range } from './novel-material'
/** Replace only named paragraphs; untouched prose remains byte-for-byte unchanged. */
export function applyParagraphEdits(raw: any, draft: SceneDraft, scene: Range): SceneDraft {
  if (!Array.isArray(raw?.edits) || !raw.edits.length || raw.edits.length > 100) invalid('paragraph edits required')
  const paragraphs = draft.body.split(/\n\s*\n/), seen = new Set<number>()
  for (const edit of raw.edits) {
    if (!Number.isInteger(edit?.paragraph) || edit.paragraph < 0 || edit.paragraph >= paragraphs.length || seen.has(edit.paragraph) || typeof edit.text !== 'string' || edit.text.length > 7000) invalid('invalid or duplicate paragraph edit')
    seen.add(edit.paragraph); paragraphs[edit.paragraph] = edit.text
  }
  return validateDraft({ body: paragraphs.filter(Boolean).join('\n\n'), continuity: raw.continuity ?? draft.continuity, warnings: raw.warnings ?? draft.warnings, covered: raw.covered ?? draft.covered }, scene)
}
