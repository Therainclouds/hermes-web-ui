import { describe, expect, it } from 'vitest'
import { clampMessageForUi } from '../../packages/client/src/utils/format-text'

describe('clampMessageForUi', () => {
  it('returns empty string for empty / null / undefined', () => {
    expect(clampMessageForUi('')).toBe('')
    expect(clampMessageForUi(null)).toBe('')
    expect(clampMessageForUi(undefined)).toBe('')
    expect(clampMessageForUi('   \n  \t  ')).toBe('')
  })

  it('keeps short strings as-is', () => {
    expect(clampMessageForUi('hello world')).toBe('hello world')
  })

  it('collapses multiline whitespace to single spaces', () => {
    // python script with indentation + newlines gets flattened
    expect(clampMessageForUi('a\n  b\t\n c')).toBe('a b c')
    expect(clampMessageForUi('for x in [1,2,3]:\n    print(x)\n    print(x+1)')).toBe(
      'for x in [1,2,3]: print(x) print(x+1)',
    )
  })

  it('truncates long single-line strings with a truncation note', () => {
    const long = 'x'.repeat(1000)
    const out = clampMessageForUi(long, 50)
    expect(out.length).toBeLessThanOrEqual(50 + '\n…[truncated]'.length + 10)
    expect(out).toContain('…[truncated]')
  })

  it('does not truncate strings at or under the cap', () => {
    const exact = 'x'.repeat(600)
    expect(clampMessageForUi(exact)).toBe(exact)
  })

  it('trims trailing whitespace before truncating', () => {
    const padded = '   ' + 'x'.repeat(700) + '   '
    const out = clampMessageForUi(padded, 600)
    // Should not contain leading or trailing whitespace runs
    expect(out).toBe(out.trim())
  })
})
