import { expect, it } from 'vitest'
import { boundedPlan } from '../../packages/server/src/services/trpg/novel-planning'
import { tokens } from '../../packages/server/src/services/trpg/novel-material'
it('batches every event in order under the planning budget before synthesizing', async () => {
  const events = Array.from({ length: 40 }, (_, id) => ({ id, fact: '角色打开门发现线索，但未能确认来源。'.repeat(12) }))
  const seen: number[] = []; let calls = 0
  const result = await boundedPlan(events, { chapter: 5 }, async input => {
    expect(tokens(input)).toBeLessThanOrEqual(1200); calls++
    for (const item of input.scenes as any[]) if (typeof item.id === 'number') seen.push(item.id)
    return { title: '章节', guide: '按时间顺序保留事实。' }
  }, 1200)
  expect(result.title).toBe('章节'); expect(calls).toBeGreaterThan(1)
  expect(seen).toEqual(events.map(e => e.id))
})
it('refuses a single oversized item rather than silently truncating it', async () => {
  await expect(boundedPlan([{ fact: '事件'.repeat(3000) }], {}, async () => ({ title: 'x', guide: 'x' }), 500)).rejects.toThrow()
})
