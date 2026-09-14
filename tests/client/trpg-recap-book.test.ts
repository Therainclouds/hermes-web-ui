import { describe, it, expect } from 'vitest'
import { paginateByLength, splitBlocks, splitChronicle, splitLongBlock, splitSentences } from '../../packages/client/src/plugins/trpg/recapBook'

const markdown = [
  '# 城门',
  '',
  '题记：这是封面上的引子。',
  '',
  '## 第一章 箭雨',
  '',
  '银月举起盾牌。',
  '',
  '> **【银月】** 举盾',
  '',
  '## 第二章 长夜',
  '',
  '火把熄灭了。',
].join('\n')

describe('chronicle markdown splitting', () => {
  it('reads the title and every level-2 chapter', () => {
    const doc = splitChronicle(markdown)
    expect(doc.title).toBe('城门')
    expect(doc.chapters.map(chapter => chapter.title)).toEqual(['第一章 箭雨', '第二章 长夜'])
    expect(doc.chapters[0].markdown).toContain('银月举起盾牌。')
    expect(doc.chapters[1].markdown).toBe('火把熄灭了。')
  })

  it('splits blocks on blank lines and keeps fenced code together', () => {
    const blocks = splitBlocks('一段。\n\n```\nline 1\n\nline 2\n```\n\n二段。')
    expect(blocks).toEqual(['一段。', '```\nline 1\n\nline 2\n```', '二段。'])
  })

  it('splits an over-long paragraph at sentence boundaries without losing words', () => {
    const sentence = '银月举盾，箭雨落下。'
    const block = sentence.repeat(20)
    const pieces = splitLongBlock(block, 40)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every(piece => piece.length <= 40)).toBe(true)
    expect(pieces.join('')).toBe(block)
  })

  it('keeps short blocks atomic', () => {
    expect(splitLongBlock('短句。', 100)).toEqual(['短句。'])
  })

  it('splits prose into sentence units that rejoin losslessly', () => {
    const block = '银月举盾。箭雨落下！随后是长夜…'
    const units = splitSentences(block)
    expect(units).toEqual(['银月举盾。', '箭雨落下！', '随后是长夜…'])
    expect(units.join('')).toBe(block)
    // A sentence without terminal punctuation is still returned whole.
    expect(splitSentences('没有句号的句子')).toEqual(['没有句号的句子'])
  })
})

describe('character-budget pagination', () => {
  it('packs blocks under the budget and never drops content', () => {
    const blocks = ['一'.repeat(30), '二'.repeat(30), '三'.repeat(30)]
    const pages = paginateByLength(blocks, 60)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.flat()).toEqual(blocks)
  })

  it('returns no pages for empty input', () => {
    expect(paginateByLength([])).toEqual([])
  })
})
