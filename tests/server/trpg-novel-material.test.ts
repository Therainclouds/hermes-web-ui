import { describe, expect, it } from 'vitest'
import { validateDraft, withDialogueCoverage } from '../../packages/server/src/services/trpg/novel-material'

const range = { from: 10, to: 14 }
const draft = (over: Record<string, unknown> = {}) => ({ body: '正午，小路。', continuity: '', warnings: [], covered: [10, 11], ...over })

describe('dialogue coverage is code-owned metadata', () => {
  it('accepts numeric-string indices instead of silently discarding a correct list', () => {
    const parsed = validateDraft(draft({ covered: ['10', '12'] }), range)
    expect(parsed.covered).toEqual([10, 12])
  })

  it('unions the scene dialogue indices and reports what the model omitted', () => {
    const result = withDialogueCoverage(validateDraft(draft({ covered: [10] }), range), [10, 13, 14])
    expect(result.draft.covered).toEqual([10, 13, 14])
    expect(result.missing).toEqual([13, 14])
  })

  it('is a no-op when coverage is already complete', () => {
    const parsed = validateDraft(draft({ covered: [10, 13] }), range)
    const result = withDialogueCoverage(parsed, [10, 13])
    expect(result.missing).toEqual([])
    expect(result.draft).toBe(parsed)
  })
})
