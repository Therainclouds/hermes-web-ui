import { invalid, validateDraft, type SceneDraft, type Range } from './novel-material'
/** One paragraph split rule shared by audits, editor reads and patches.
 *  Paragraphs are trimmed and empty ones dropped, so a paragraph number always
 *  names the same text in the audit report and in an editor patch. Splitting the
 *  raw body in only one of those places lets the two disagree whenever the model
 *  emits a whitespace-only paragraph. */
export function paragraphsOf(body: string): string[] {
  return body.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean)
}
/** Apply a bounded editor patch. Two shapes are accepted, never mixed in one patch:
 *
 *  - **Exact-excerpt edits** (`{find, replace?}`): the preferred direct edit. The model quotes
 *    text it can see instead of counting paragraphs, so it cannot drift onto a stale index or
 *    accidentally delete the whole scene. `find` must occur exactly once in the current body;
 *    `replace: ""` deletes that excerpt. Every edit in the patch is applied in order.
 *  - **Paragraph edits** (`{paragraph, text?, delete?}`): replace or delete a numbered
 *    paragraph when the numbered view is clearer. Non-empty `text` wins over a `delete` flag,
 *    because models routinely echo the replacement together with `delete: true`.
 *
 *  Untouched prose stays byte-for-byte unchanged, and an empty result is always refused. */
export function applyParagraphEdits(raw: any, draft: SceneDraft, scene: Range): SceneDraft {
  if (!Array.isArray(raw?.edits) || !raw.edits.length || raw.edits.length > 100) invalid('paragraph edits required')
  const hasFind = raw.edits.some((edit: any) => edit?.find !== undefined)
  if (hasFind && raw.edits.some((edit: any) => edit?.find === undefined)) invalid('do not mix excerpt edits with paragraph edits in one patch')
  let body = draft.body
  if (hasFind) {
    for (const edit of raw.edits) {
      const find = edit?.find
      if (typeof find !== 'string' || find.length < 4 || find.length > 2000) invalid('excerpt edit requires a 4–2000 character exact excerpt')
      if (edit.replace !== undefined && (typeof edit.replace !== 'string' || edit.replace.length > 7000)) invalid('invalid or duplicate paragraph edit')
      const replace = typeof edit.replace === 'string' ? edit.replace : ''
      const first = body.indexOf(find)
      if (first < 0) invalid('excerpt edit text does not occur in the manuscript; quote it exactly as shown')
      if (body.indexOf(find, first + find.length) >= 0) invalid('excerpt edit text occurs more than once; include more surrounding text')
      body = `${body.slice(0, first)}${replace}${body.slice(first + find.length)}`
    }
  } else {
    const paragraphs = paragraphsOf(draft.body), seen = new Set<number>()
    for (const edit of raw.edits) {
      if (!Number.isInteger(edit?.paragraph) || edit.paragraph < 0 || edit.paragraph >= paragraphs.length || seen.has(edit.paragraph)) invalid('invalid or duplicate paragraph edit')
      seen.add(edit.paragraph)
      if (edit.delete != null && typeof edit.delete !== 'boolean') invalid('invalid or duplicate paragraph edit')
      if (edit.text === undefined) {
        if (edit.delete !== true) invalid('invalid or duplicate paragraph edit')
        paragraphs[edit.paragraph] = ''
        continue
      }
      if (typeof edit.text !== 'string' || edit.text.length > 7000) invalid('invalid or duplicate paragraph edit')
      if (!edit.text.trim()) {
        if (edit.delete === false) invalid('invalid or duplicate paragraph edit')
        paragraphs[edit.paragraph] = ''
        continue
      }
      paragraphs[edit.paragraph] = edit.text.trim()
    }
    body = paragraphs.filter(Boolean).join('\n\n')
  }
  body = paragraphsOf(body).join('\n\n')
  if (!body) invalid('paragraph edits removed the whole scene body; rewrite the scene instead')
  return validateDraft({ body, continuity: raw.continuity ?? draft.continuity, warnings: raw.warnings ?? draft.warnings, covered: [...new Set([...draft.covered, ...(Array.isArray(raw.covered) ? raw.covered : [])])] }, scene)
}

/** Whole-scene replacement for audits whose findings span most of the manuscript. The editor
 *  cannot express that as per-paragraph edits (an all-delete patch never applies), so without
 *  this verb it burns every tool turn and the scene blocks. The fresh independent audit after
 *  the rewrite is still mandatory; this is not a waiver, only a way to express the edit. */
export function rewriteScene(raw: any, draft: SceneDraft, scene: Range): SceneDraft {
  if (typeof raw?.body !== 'string' || !raw.body.trim()) invalid('rewritten scene body required')
  return validateDraft({ body: raw.body, continuity: raw.continuity ?? draft.continuity, warnings: raw.warnings ?? draft.warnings, covered: Array.isArray(raw.covered) ? raw.covered : [] }, scene)
}

/** Only manuscript prose is checked, and a GM label is a presentation problem: it is reported
 *  and repaired, but never treated as a factual contradiction that stops the book. */
export function narratorIssues(body: string): { detail: string; kind: 'format' }[] {
  return paragraphsOf(body).flatMap((text, paragraph) => /【\s*(?:GM|主持人|旁白GM)\s*】|(?:^|\n)\s*(?:GM|主持人)\s*[:：]|(?:GM|主持人)\s*(?:说道|说：|说:|宣布|描述道)/i.test(text)
    ? [{ kind: 'format' as const, detail: `[正文叙事] 第 ${paragraph} 段把 GM/主持人写成了角色。将场景描写、时间和裁决改为叙述者的小说文字；去掉口头填充和面向玩家的“你们”，但保留原意。NPC 配音仅在身份明确时归给该 NPC，否则中性转述。不能仅删掉 GM 标签而留下主持人逐字对白；不要修改原文、事实账本中的 GM 标识。` }] : [])
}
