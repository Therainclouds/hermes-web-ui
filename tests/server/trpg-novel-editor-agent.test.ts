import { expect, it, vi } from 'vitest'
import { runEditorAgent, validateEditorAction, type EditorAction } from '../../packages/server/src/services/trpg/novel-editor-agent'
import { applyParagraphEdits, rewriteScene } from '../../packages/server/src/services/trpg/novel-revision'
const draft = { body: '正午，烈日照着小路。\n\n路牌积满了灰。', continuity: '在小路上', covered: [10, 11], warnings: [] }
const apply = (action: EditorAction, base = draft) => action.tool === 'replace_scene' ? rewriteScene(action, base, { from: 10, to: 11 }) : applyParagraphEdits(action, base, { from: 10, to: 11 })
const options = {
  draft, issues: [{ detail: '核对路牌状态' }], facts: {}, targetChars: 200,
  rows: [{ index: 10, text: 'GM：现在正值中午。' }, { index: 11, text: '路牌积灰看不清。' }],
  apply: (action: EditorAction) => apply(action),
}
it('lets the editor retrieve only requested evidence, then applies a bounded paragraph patch', async () => {
  const call = vi.fn()
  call.mockResolvedValueOnce({ tool: 'read_evidence', indices: [11] }).mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ paragraph: 1, text: '路牌积满灰尘，字迹难以辨认。' }] })
  const result = await runEditorAgent({ ...options, call })
  expect(call.mock.calls[1][0].observations).toEqual([{ tool: 'read_evidence', result: [options.rows[1]] }])
  expect(call.mock.calls[0][0]).not.toHaveProperty('rows')
  expect(result.draft?.body).toBe('正午，烈日照着小路。\n\n路牌积满灰尘，字迹难以辨认。')
  expect(options.rows[0].text).toContain('GM')
})
it('repairs invalid tool arguments using observations without redrafting the prose', async () => {
  const call = vi.fn().mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ paragraph: 999, text: '错' }] }).mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ paragraph: 1, text: '路牌蒙尘。' }] })
  expect((await runEditorAgent({ ...options, call })).draft?.body).toContain('路牌蒙尘。')
  expect(call.mock.calls[1][0].observations[0].result).toHaveProperty('error')
  expect(draft.body).toContain('路牌积满了灰。')
})
it('submits a real paragraph deletion instead of only describing it', async () => {
  const duplicated = { body: '正午，烈日照着小路。\n\n路牌积满了灰。\n\n路牌积满了灰。', continuity: '在小路上', covered: [10, 11], warnings: [] }
  const call = vi.fn().mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ paragraph: 2, delete: true }] })
  const result = await runEditorAgent({ ...options, draft: duplicated, apply: action => apply(action, duplicated), call })
  expect(call.mock.calls[0][0].paragraphs).toHaveLength(3)
  expect(result.draft?.body).toBe('正午，烈日照着小路。\n\n路牌积满了灰。')
})
it('applies an exact-excerpt edit without relying on paragraph numbers', async () => {
  const call = vi.fn().mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ find: '路牌积满了灰。', replace: '路牌蒙着厚厚的灰。' }] })
  const result = await runEditorAgent({ ...options, call })
  expect(result.draft?.body).toBe('正午，烈日照着小路。\n\n路牌蒙着厚厚的灰。')
  expect(call.mock.calls[0][0].paragraphs).toHaveLength(2)
})
it('reports a rejected excerpt edit as an observation so the editor can correct it', async () => {
  const call = vi.fn()
    .mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ find: '正文里没有这句话。', replace: '改' }] })
    .mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ find: '路牌积满了灰。', replace: '路牌蒙尘。' }] })
  expect((await runEditorAgent({ ...options, call })).draft?.body).toContain('路牌蒙尘。')
  expect(call.mock.calls[1][0].observations[0].result).toMatchObject({ error: expect.stringContaining('does not occur') })
})
it('recovers from an all-delete patch by rewriting the whole scene', async () => {
  const call = vi.fn()
    .mockResolvedValueOnce({ tool: 'patch_paragraphs', edits: [{ paragraph: 0, delete: true }, { paragraph: 1, delete: true }] })
    .mockResolvedValueOnce({ tool: 'replace_scene', body: '正午的日头压着小路。\n\n路牌蒙着厚厚的灰。', covered: [10, 11] })
  const result = await runEditorAgent({ ...options, call })
  expect(call.mock.calls[1][0].observations[0].result).toMatchObject({ error: expect.stringContaining('whole scene') })
  expect(result.draft?.body).toBe('正午的日头压着小路。\n\n路牌蒙着厚厚的灰。')
  expect(result.conflict).toBeUndefined()
})
it('bounds repeated reads and supports explicit constraint conflicts', async () => {
  const call = vi.fn().mockResolvedValue({ tool: 'read_evidence', indices: [11] })
  expect((await runEditorAgent({ ...options, call })).conflict).toBeTruthy()
  expect(call).toHaveBeenCalledTimes(8)
  expect(call.mock.calls[2][0].observations[1].result).toHaveProperty('error')
  const conflict = vi.fn().mockResolvedValue({ tool: 'report_conflict', reason: '原文未确认浓雾，不能编造过渡。' })
  expect((await runEditorAgent({ ...options, call: conflict })).conflict).toContain('未确认')
  expect(conflict).toHaveBeenCalledTimes(1)
})
it('rejects arbitrary tools and unbounded retrieval', () => {
  for (const raw of [{ tool: 'shell', command: 'anything' }, { tool: 'read_evidence', indices: [-1] }, { tool: 'read_paragraphs', indices: Array(21).fill(0) }, { tool: 'replace_scene' }, { tool: 'replace_scene', body: '  ' }]) expect(() => validateEditorAction(raw)).toThrow('novel_invalid_output')
  expect(validateEditorAction({ edits: [{ paragraph: 0, text: '午后。' }] }).tool).toBe('patch_paragraphs')
  expect(validateEditorAction({ body: '整场新正文。' }).tool).toBe('replace_scene')
})
