import { expect, it } from 'vitest'
import { applyParagraphEdits, rewriteScene } from '../../packages/server/src/services/trpg/novel-revision'
const draft = { body: '门被推开。\n\n他走进房间。\n\n窗外下着雨。', continuity: '在房间', warnings: [], covered: [0] }
it('replaces only specified paragraphs and preserves the others exactly', () => {
  const next = applyParagraphEdits({ edits: [{ paragraph: 1, text: '他踉跄走进房间，扶住墙壁。' }] }, draft, { from: 0, to: 2 })
  expect(next.body).toBe('门被推开。\n\n他踉跄走进房间，扶住墙壁。\n\n窗外下着雨。')
  expect(draft.body).toContain('他走进房间。')
})
it('rejects unknown and duplicate paragraph edits and wholesale body responses', () => {
  for (const raw of [{ body: '全部重写' }, { edits: [{ paragraph: 99, text: '伪造' }] }, { edits: [{ paragraph: 0, text: '一' }, { paragraph: 0, text: '二' }] }]) expect(() => applyParagraphEdits(raw, draft, { from: 0, to: 2 })).toThrow()
})
it('preserves coverage metadata for unchanged paragraphs when a patch lists only changed rows', () => {
  const next = applyParagraphEdits({ edits: [{ paragraph: 1, text: '他停在门边。' }], covered: [1] }, { ...draft, covered: [0, 2] }, { from: 0, to: 2 })
  expect(next.covered).toEqual([0, 2, 1])
})
it('deletes named paragraphs so repeated or out-of-scene prose can be removed', () => {
  const duplicated = { body: '门被推开。\n\n窗外下着雨。\n\n窗外下着雨。', continuity: '在房间', warnings: [], covered: [0, 1, 2] }
  expect(applyParagraphEdits({ edits: [{ paragraph: 2, delete: true }] }, duplicated, { from: 0, to: 2 }).body).toBe('门被推开。\n\n窗外下着雨。')
  // Empty text is the same delete verb; one call may delete several paragraphs by original number.
  expect(applyParagraphEdits({ edits: [{ paragraph: 1, delete: true }, { paragraph: 2, text: '' }] }, duplicated, { from: 0, to: 2 }).body).toBe('门被推开。')
})
it('normalizes whitespace-only paragraphs so audit numbers and editor patches name the same text', () => {
  const spaced = { body: '甲。\n\n   \n\n乙。', continuity: '', warnings: [], covered: [] }
  expect(applyParagraphEdits({ edits: [{ paragraph: 1, text: '丙。' }] }, spaced, { from: 0, to: 1 }).body).toBe('甲。\n\n丙。')
})
it('refuses a patch that deletes the whole scene or sends a malformed delete flag', () => {
  const three = { body: '甲。\n\n乙。\n\n丙。', continuity: '', warnings: [], covered: [] }
  expect(() => applyParagraphEdits({ edits: [0, 1, 2].map(paragraph => ({ paragraph, delete: true })) }, three, { from: 0, to: 2 })).toThrow()
  expect(() => applyParagraphEdits({ edits: [{ paragraph: 0, delete: 'yes' }] }, three, { from: 0, to: 2 })).toThrow()
  expect(() => applyParagraphEdits({ edits: [{ paragraph: 0 }] }, three, { from: 0, to: 2 })).toThrow()
})
it('treats non-empty text as a replacement even when a delete flag is also present', () => {
  const three = { body: '甲。\n\n乙。\n\n丙。', continuity: '', warnings: [], covered: [] }
  const next = applyParagraphEdits({ edits: [{ paragraph: 1, text: '乙改。', delete: true }] }, three, { from: 0, to: 2 })
  expect(next.body).toBe('甲。\n\n乙改。\n\n丙。')
})
it('rewrites a whole scene when the audit requires changes across most paragraphs', () => {
  const next = rewriteScene({ body: '他一脚踩空，坠入井底。\n\n井壁的回声压住了呼喊。', covered: [0, 3], continuity: '在井底' }, draft, { from: 0, to: 3 })
  expect(next.body).toBe('他一脚踩空，坠入井底。\n\n井壁的回声压住了呼喊。')
  expect(next.covered).toEqual([0, 3])
  expect(next.continuity).toBe('在井底')
  // A rewrite is not a waiver: it still validates shape and never returns an empty scene.
  for (const raw of [{}, { body: '   ' }, { body: '# 第一章\n正文' }]) expect(() => rewriteScene(raw, draft, { from: 0, to: 3 })).toThrow()
  expect(rewriteScene({ body: '只有一句。' }, draft, { from: 0, to: 2 }).covered).toEqual([])
})
it('applies exact-excerpt edits and deletes by empty replacement', () => {
  const body = { body: '甲一开头。\n\n乙二中间。\n\n丙三结尾。', continuity: '', warnings: [], covered: [] }
  const next = applyParagraphEdits({ edits: [{ find: '乙二中间。', replace: '乙改。' }, { find: '丙三结尾。', replace: '' }] }, body, { from: 0, to: 2 })
  expect(next.body).toBe('甲一开头。\n\n乙改。')
})
it('refuses ambiguous, missing, too-short or mixed excerpt edits', () => {
  const body = { body: '重复段落。\n\n重复段落。', continuity: '', warnings: [], covered: [] }
  for (const edits of [
    [{ find: '重复段落。', replace: '改' }],
    [{ find: '不存在的整段。', replace: '改' }],
    [{ find: '短', replace: '改' }],
    [{ find: '重复段落。' }, { paragraph: 0, text: '混用' }],
  ]) expect(() => applyParagraphEdits({ edits }, body, { from: 0, to: 1 })).toThrow()
})
it('flags GM manuscript dialogue without rewriting source material', async () => {
  const { narratorIssues } = await import('../../packages/server/src/services/trpg/novel-revision')
  const source = '【GM】"现在，正值中午，烈阳。"'
  expect(narratorIssues(source)[0].detail).toContain('第 0 段')
  expect(narratorIssues('正午，烈日照着小路。积灰的路牌已难以辨认。')).toEqual([])
  expect(narratorIssues('【洛洛卡】“看那块路牌。”')).toEqual([])
  expect(source).toContain('【GM】')
})
