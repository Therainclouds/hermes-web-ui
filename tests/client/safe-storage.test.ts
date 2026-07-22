// @vitest-environment jsdom
/**
 * Tests for safeGetJSON / safeSetJSON — the protective wrapper introduced
 * after R-5 (v0.7.7 audit) where HistoryView.vue crashed on malformed
 * localStorage data.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { safeGetJSON, safeSetJSON } from '../../packages/client/src/utils/safe-storage'

const KEY = 'test.safe_storage.roundtrip'

afterEach(() => {
  localStorage.removeItem(KEY)
})

describe('safe-storage utilities', () => {
  it('returns the fallback when the key is missing', () => {
    expect(safeGetJSON<string[]>(KEY, ['default'])).toEqual(['default'])
  })

  it('round-trips a JSON-serialisable value', () => {
    expect(safeSetJSON(KEY, { a: 1, b: ['x'] })).toBe(true)
    expect(safeGetJSON<{ a: number; b: string[] }>(KEY, { a: 0, b: [] }))
      .toEqual({ a: 1, b: ['x'] })
  })

  it('falls back when stored value is not valid JSON (R-5 regression)', () => {
    // Simulate the bug that crashed HistoryView.vue:400 — a corrupted
    // archive from an older build, partial write, or manual edit.
    localStorage.setItem(KEY, '{not valid json')
    expect(safeGetJSON<{ ok: boolean }>(KEY, { ok: false })).toEqual({ ok: false })
  })

  it('returns false when storage is unavailable', () => {
    // jsdom's setItem throws on quota — emulate it by overriding the
    // window-scoped localStorage mock defined in tests/setup.ts.
    const originalSet = window.localStorage.setItem
    window.localStorage.setItem = () => { throw new Error('quota exceeded') }
    try {
      expect(safeSetJSON(KEY, { x: 1 })).toBe(false)
    } finally {
      window.localStorage.setItem = originalSet
    }
  })
})