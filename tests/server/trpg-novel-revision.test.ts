import { expect, it } from 'vitest'
import { applyParagraphEdits } from '../../packages/server/src/services/trpg/novel-revision'
const draft = { body: '门被推开。\n\n他走进房间。\n\n窗外下着雨。', continuity: '在房间', warnings: [], covered: [0] }
it('replaces only specified paragraphs and preserves the others exactly', () => {
  const next = applyParagraphEdits({ edits: [{ paragraph: 1, text: '他踉跄走进房间，扶住墙壁。' }] }, draft, { from: 0, to: 2 })
  expect(next.body).toBe('门被推开。\n\n他踉跄走进房间，扶住墙壁。\n\n窗外下着雨。')
  expect(draft.body).toContain('他走进房间。')
})
it('rejects unknown and duplicate paragraph edits and wholesale body responses', () => {
  for (const raw of [{ body: '全部重写' }, { edits: [{ paragraph: 99, text: '伪造' }] }, { edits: [{ paragraph: 0, text: '一' }, { paragraph: 0, text: '二' }] }]) expect(() => applyParagraphEdits(raw, draft, { from: 0, to: 2 })).toThrow()
})
