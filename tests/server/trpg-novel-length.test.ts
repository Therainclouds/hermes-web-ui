import { describe, expect, it } from 'vitest'
import { allocateNovelTargets, assessLength, countNovelChars } from '../../packages/server/src/services/trpg/novel-length'

describe('whole novel length budgets', () => {
  it('allocates 10,000 characters across 143 scenes without minimum inflation', () => {
    const chapters = Array.from({ length: 11 }, () => ({ weights: Array.from({ length: 13 }, () => 1) }))
    const targets = allocateNovelTargets(10000, chapters).flat()
    expect(targets).toHaveLength(143)
    expect(targets.reduce((a, b) => a + b, 0)).toBe(10000)
    expect(Math.min(...targets)).toBeGreaterThanOrEqual(69)
    expect(Math.max(...targets)).toBeLessThanOrEqual(71)
    expect(allocateNovelTargets(10000, chapters).flat()).toEqual(targets)
  })
  it('normalizes chapter requests against the global target and preserves scene weighting', () => {
    const targets = allocateNovelTargets(10000, [
      { weights: [1, 3], targetChars: 20000 },
      { weights: [1, 1], targetChars: 20000 },
    ])
    expect(targets).toEqual([[1250, 3750], [2500, 2500]])
    expect(allocateNovelTargets(10000, [{ weights: [1, 1], targetChars: 10000 }, { weights: [1, 1] }]))
      .toEqual([[3334, 3333], [1667, 1666]])
  })
  it('does not silently apply the former 4,500-character cap', () => {
    expect(allocateNovelTargets(12000, [{ weights: [1, 1] }])).toEqual([[6000, 6000]])
    expect(() => allocateNovelTargets(15000, [{ weights: [1, 1] }])).toThrow('novel_length_budget_impossible')
    expect(() => allocateNovelTargets(1, [{ weights: [1, 1] }])).toThrow('novel_length_budget_impossible')
  })
  it('accepts exactly ±10% and reports the required direction outside boundaries', () => {
    expect(assessLength(9000, 10000).status).toBe('within')
    expect(assessLength(11000, 10000).status).toBe('within')
    expect(assessLength(8999, 10000)).toMatchObject({ status: 'under', min: 9000, max: 11000 })
    expect(assessLength(8999, 10000).detail).toContain('不得增加无证据剧情')
    expect(assessLength(11001, 10000).detail).toContain('保留全部必需事实')
    expect(assessLength(110, 100).status).toBe('within')
    expect(assessLength(99, 111).status).toBe('under')
  })
  it('counts Unicode characters and excludes formatting whitespace', () => {
    expect(countNovelChars('银月\n 来到\t城门。 🐉')).toBe(8)
  })
  it('rejects invalid or non-finite budgets', () => {
    expect(() => allocateNovelTargets(0, [{ weights: [1] }])).toThrow('novel_length_budget_invalid')
    expect(() => allocateNovelTargets(10000, [])).toThrow('novel_length_budget_invalid')
    expect(() => allocateNovelTargets(10000, [{ weights: [NaN] }])).toThrow('novel_length_budget_invalid')
    expect(() => assessLength(-1, 10000)).toThrow('novel_length_budget_invalid')
  })
})
