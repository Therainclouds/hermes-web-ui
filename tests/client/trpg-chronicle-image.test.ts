// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { RecapEntry } from '../../packages/shared/trpg-recap'
import { chronicleCast, chronicleReferences, buildChronicleImagePrompt } from '../../packages/client/src/plugins/trpg/chronicle-image'
import type { CharacterCard } from '../../packages/client/src/plugins/trpg/storage'

function card(id: string, name: string, withImage = false): CharacterCard {
  return { id, name, player: '', appearance: `${name}的外观`, card: '', ...(withImage ? { image: new Blob(['x'], { type: 'image/png' }) } : {}) }
}
function entry(overrides: Partial<RecapEntry> = {}): RecapEntry {
  return {
    id: 'recap', meetingId: 'meeting', mode: 'literary', tone: 'epic', title: '城门',
    setting: '月下城门', style: '油画质感',
    characters: [{ id: 'elf', name: '银月', player: '' }],
    chapters: [
      { id: 'c1', title: '箭雨', startQuote: '', endQuote: '', body: '银月举盾挡住了箭雨。'.repeat(60), highlights: [{ characterId: 'elf', name: '【银月】', action: '举盾', evidence: '举盾' }] },
      { id: 'c2', title: '长夜', startQuote: '', endQuote: '', body: '长夜降临。', highlights: [] },
    ],
    timeline: [], generatedAt: 0, skillUsed: 'trpg-recap',
    ...overrides,
  }
}

describe('chronicle illustration helpers', () => {
  it('picks the characters of the selected chapter and falls back to the whole cast', () => {
    const cards = [card('elf', '银月', true), card('dwarf', '铁砧', true), card('unused', '路人', true)]
    expect(chronicleCast(entry(), 'content', 'c1', cards).map(member => member.id)).toEqual(['elf'])
    // A chapter with no highlights uses every named card.
    expect(chronicleCast(entry(), 'content', 'c2', cards).map(member => member.id)).toEqual(['elf', 'dwarf', 'unused'])
    // A cover spans the whole chronicle.
    expect(chronicleCast(entry(), 'cover', undefined, cards).map(member => member.id)).toEqual(['elf'])
  })

  it('attaches at most four portraits, in cast order', () => {
    const cards = [1, 2, 3, 4, 5].map(index => card(`c${index}`, `角色${index}`, true))
    const noHighlights = entry({ chapters: [{ id: 'c1', title: '一', startQuote: '', endQuote: '', body: '正文', highlights: [] }] })
    const cast = chronicleCast(noHighlights, 'cover', undefined, cards)
    expect(cast).toHaveLength(5)
    expect(chronicleReferences(cast)).toHaveLength(4)
    expect(chronicleReferences(cast).map(reference => reference.name)).toEqual(['角色1', '角色2', '角色3', '角色4'])
    // Cards without an image are never attached but stay in the prompt cast.
    expect(chronicleReferences([card('a', '无图', false)])).toEqual([])
  })

  it('builds a cover or chapter prompt with title, appearance and a no-text instruction', () => {
    const cover = buildChronicleImagePrompt(entry(), 'cover', undefined, [chronicleCast(entry(), 'cover', undefined, [card('elf', '银月')])[0]])
    expect(cover).toContain('城门')
    expect(cover).toContain('油画质感')
    expect(cover).toContain('银月')
    expect(cover).toContain('银月的外观')
    expect(cover).toContain('不要')
    expect(cover).not.toContain('箭雨')
    const content = buildChronicleImagePrompt(entry(), 'content', 'c1', [], '')
    expect(content).toContain('箭雨')
    expect(content).toContain('章节内容参考')
  })
})
