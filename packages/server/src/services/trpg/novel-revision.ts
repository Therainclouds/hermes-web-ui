import { invalid, validateDraft, type SceneDraft, type Range } from './novel-material'
/** One paragraph split rule shared by audits, editor reads and patches.
 *  Paragraphs are trimmed and empty ones dropped, so a paragraph number always
 *  names the same text in the audit report and in an editor patch. Splitting the
 *  raw body in only one of those places lets the two disagree whenever the model
 *  emits a whitespace-only paragraph. */
export function paragraphsOf(body: string): string[] {
  return body.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean)
}
/** Replace or delete only named paragraphs; untouched prose remains byte-for-byte unchanged.
 *  `text: ""` or `delete: true` removes a paragraph. Audits routinely require deleting a
 *  duplicated paragraph or plot that belongs to another scene; without a delete verb the
 *  editor can only claim the deletion in `continuity` and the scene stalls. Deletion
 *  renumbers later paragraphs, so every edit in one call uses the numbers of the body it
 *  was shown; code applies the whole patch before any renumbering is observable. */
export function applyParagraphEdits(raw: any, draft: SceneDraft, scene: Range): SceneDraft {
  if (!Array.isArray(raw?.edits) || !raw.edits.length || raw.edits.length > 100) invalid('paragraph edits required')
  const paragraphs = paragraphsOf(draft.body), seen = new Set<number>()
  for (const edit of raw.edits) {
    if (!Number.isInteger(edit?.paragraph) || edit.paragraph < 0 || edit.paragraph >= paragraphs.length || seen.has(edit.paragraph)) invalid('invalid or duplicate paragraph edit')
    seen.add(edit.paragraph)
    if (edit.delete != null && typeof edit.delete !== 'boolean') invalid('invalid or duplicate paragraph edit')
    if (edit.delete === true || edit.text === '') { paragraphs[edit.paragraph] = ''; continue }
    if (typeof edit.text !== 'string' || edit.text.length > 7000) invalid('invalid or duplicate paragraph edit')
    paragraphs[edit.paragraph] = edit.text.trim()
  }
  const body = paragraphs.filter(Boolean).join('\n\n')
  if (!body) invalid('paragraph edits removed the whole scene body')
  return validateDraft({ body, continuity: raw.continuity ?? draft.continuity, warnings: raw.warnings ?? draft.warnings, covered: [...new Set([...draft.covered, ...(Array.isArray(raw.covered) ? raw.covered : [])])] }, scene)
}

/** Only manuscript prose is checked. Source/ledger attribution must retain GM. */
export function narratorIssues(body: string): { detail: string }[] {
  return paragraphsOf(body).flatMap((text, paragraph) => /【\s*(?:GM|主持人|旁白GM)\s*】|(?:^|\n)\s*(?:GM|主持人)\s*[:：]|(?:GM|主持人)\s*(?:说道|说：|说:|宣布|描述道)/i.test(text)
    ? [{ detail: `[正文叙事] 第 ${paragraph} 段把 GM/主持人写成了角色。将场景描写、时间和裁决改为叙述者的小说文字；去掉口头填充和面向玩家的“你们”，但保留原意。NPC 配音仅在身份明确时归给该 NPC，否则中性转述。不能仅删掉 GM 标签而留下主持人逐字对白；不要修改原文、事实账本中的 GM 标识。` }] : [])
}
