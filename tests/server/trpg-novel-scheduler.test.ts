import { expect, it } from 'vitest'
import { boundedMap } from '../../packages/server/src/services/trpg/novel-scheduler'
it('bounds overlap, preserves source order and drains workers on failure', async () => {
  let active = 0, maximum = 0
  const values = await boundedMap([3, 2, 1, 0], 2, async value => {
    maximum = Math.max(maximum, ++active)
    await new Promise(r => setTimeout(r, value * 5)); active--; return value
  })
  expect(values).toEqual([3, 2, 1, 0]); expect(maximum).toBe(2)
  let drained = false
  await expect(boundedMap([0, 1, 2], 2, async value => {
    if (!value) { await new Promise(r => setTimeout(r, 1)); throw new Error('stop') }
    await new Promise(r => setTimeout(r, 10)); drained = true; return value
  })).rejects.toThrow('stop')
  expect(drained).toBe(true)
})
