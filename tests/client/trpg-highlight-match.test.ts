import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_RELATED_SCORE,
  highlightSentences,
  matchHighlight,
  matchPercent,
  normalizeForMatch,
  textOverlap,
  type SourceRow,
} from '../../packages/client/src/plugins/trpg/highlight-match'

const rows: SourceRow[] = [
  { index: 0, text: 'GM：你们来到断桥边，桥面已经塌了一半。', speaker: 'GM' },
  { index: 1, text: '银月：我先用绳索固定，再慢慢过去。', speaker: '银月' },
  { index: 2, text: 'GM：远处传来巨龙的咆哮。', speaker: 'GM' },
]

describe('highlight and scene text matching', () => {
  it('folds away speaker markers, whitespace and punctuation', () => {
    expect(normalizeForMatch('[GM] 桥面已经塌了一半！')).toBe(normalizeForMatch('桥面已经塌了一半'))
    expect(normalizeForMatch('《巨龙》，咆哮')).toBe('巨龙咆哮')
  })

  it('treats strict containment as a full overlap', () => {
    expect(textOverlap('远处传来巨龙的咆哮', 'GM：远处传来巨龙的咆哮。')).toBe(1)
    expect(textOverlap('桥面已经塌了一半', '酒馆里的赏金讨论')).toBe(0)
  })

  it('scores a highlight copied from the scene as fully related', () => {
    const result = matchHighlight('[GM] 你们来到断桥边，桥面已经塌了一半。\n[银月] 我先用绳索固定，再慢慢过去。', rows)
    expect(result.score).toBe(1)
    expect(result.related).toBe(true)
    expect(result.matched.map(row => row.index)).toEqual([0, 1])
  })

  it('ignores a highlight about a different scene', () => {
    const result = matchHighlight('众人在酒馆里讨论赏金。', rows)
    expect(result.score).toBe(0)
    expect(result.related).toBe(false)
    expect(result.matched).toEqual([])
  })

  it('tolerates small ASR wording drift through bigram overlap', () => {
    const result = matchHighlight('远处传来巨龙的咆哮', rows)
    expect(result.score).toBeGreaterThanOrEqual(HIGHLIGHT_RELATED_SCORE)
    expect(result.related).toBe(true)
    expect(result.matched.map(row => row.index)).toContain(2)
  })

  it('ignores sentences too short to carry signal', () => {
    expect(matchHighlight('嗯。', rows)).toMatchObject({ score: 0, related: false })
    expect(highlightSentences('a\n\n b ')).toEqual(['a', 'b'])
  })

  it('exposes a rounded percentage helper', () => {
    expect(matchPercent(0.336)).toBe(34)
    expect(matchPercent(2)).toBe(100)
    expect(matchPercent(-1)).toBe(0)
  })
})
