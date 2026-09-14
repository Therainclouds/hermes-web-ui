import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CONTEXT_LIMIT, CONTEXT_SOFT_LIMIT, assembleNovelContext, compactContext } from '../../packages/server/src/services/trpg/novel-context'
import { tokens } from '../../packages/server/src/services/trpg/novel-material'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'trpg-context-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** Build text worth roughly `wanted` tokens without hard-coding a tokenizer result. */
function filler(wanted: number, seed: string): string {
  const unit = seed.repeat(22)
  return unit.repeat(Math.max(1, Math.ceil(wanted / Math.max(1, tokens(unit)))))
}

describe('deterministic context compaction', () => {
  it('removes recoverable quotations and the duplicated paragraph text, and never protected evidence', () => {
    const manuscript = '正午，烈日照着小路。\n\n路牌积满了灰。'
    const input = {
      rows: [{ index: 10, text: '路牌积满了灰。' }],
      canon: { events: [{ id: 's0-e0', fact: '路牌积灰', evidence: [{ index: 10, quote: '路牌积满了灰。' }] }] },
      manuscript,
      manuscriptParagraphs: [{ paragraph: 0, text: '正午，烈日照着小路。' }, { paragraph: 1, text: '路牌积满了灰。' }],
      memory: '记'.repeat(4000),
      history: '历'.repeat(3000),
    }
    const result = compactContext(input, 20)
    const value = result.value as any
    expect(value.rows).toEqual(input.rows)
    expect(value.manuscript).toBe(manuscript)
    // The quote is exactly recoverable from the row at the same index, so only the index survives.
    expect(value.canon.events[0].evidence[0]).toEqual({ index: 10 })
    // Paragraph numbering is kept; the duplicated text is not sent twice.
    expect(value.manuscriptParagraphs).toEqual([{ paragraph: 0 }, { paragraph: 1 }])
    expect(value.memory.length).toBeLessThan(4000)
    expect(result.notes.some(note => note.mode === 'split-paragraphs')).toBe(true)
    expect(result.notes.some(note => note.field === 'memory' && note.mode === 'truncate')).toBe(true)
  })

  it('leaves a request that already fits untouched', () => {
    const input = { rows: [{ index: 0, text: '短句。' }], memory: '记忆[0]' }
    const result = compactContext(input, CONTEXT_SOFT_LIMIT)
    expect(result.value).toEqual(input)
    expect(result.notes).toEqual([])
  })

  it('drops entire low-value fields when truncation is not enough, but keeps rows and prose', () => {
    const input = {
      rows: [{ index: 0, text: filler(3000, '银月走进井底。') }],
      manuscript: filler(3000, '她听见回声。'),
      history: filler(4000, '旧观察：无关紧要。'),
      observations: [{ tool: 'read_evidence', result: ['x'] }, { tool: 'read_paragraphs', result: ['y'] }],
    }
    const result = compactContext(input, 5000)
    const value = result.value as any
    expect(value.rows).toBeDefined()
    expect(value.manuscript).toBeDefined()
    expect(value.observations).toEqual([])
    expect(result.notes.some(note => note.field === 'observations' && note.mode === 'drop')).toBe(true)
  })
})

describe('budget-aware context assembly', () => {
  it('does not touch or summarise a request under the soft limit', async () => {
    const summarize = vi.fn(async () => '压缩结果')
    const result = await assembleNovelContext({ dir, input: { rows: [{ index: 0, text: '短句。' }] }, instruction: '写正文', summarize })
    expect(result.notes).toEqual([])
    expect(result.reused).toBe(0)
    expect(result.savedTokens).toBe(0)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('summarises the rolling memory instead of failing, and reuses the cached summary', async () => {
    const input = { rows: [{ index: 0, text: filler(20000, '银月走进井底，四周漆黑。') }], memory: filler(9000, '记忆条目[12]；未决线索。') }
    expect(tokens(input)).toBeGreaterThan(CONTEXT_SOFT_LIMIT)
    const summarize = vi.fn(async (_memory: string, maxChars: number) => `压缩记忆[0]${'…'.repeat(Math.max(1, Math.min(50, maxChars)))}`)
    const first = await assembleNovelContext({ dir, input, instruction: '继续' })
    // No summarizer provided: deterministic truncation still brings it below the hard limit.
    expect(tokens(first.input)).toBeLessThanOrEqual(CONTEXT_LIMIT)

    const second = await assembleNovelContext({ dir, input, instruction: '继续', summarize })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect((second.input as any).memory).toContain('压缩记忆')
    expect(second.notes.some(note => note.field === 'memory' && note.mode === 'summarize')).toBe(true)
    expect(second.savedTokens).toBeGreaterThan(0)
    expect(await readdir(join(dir, 'context'))).toHaveLength(1)

    // Same source and target: the cache is reused, so no second paid summarisation call.
    const third = await assembleNovelContext({ dir, input, instruction: '继续', summarize })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect((third.input as any).memory).toContain('压缩记忆')
  })

  it('refuses a request whose protected evidence alone exceeds the hard limit', async () => {
    const input = { rows: [{ index: 0, text: filler(CONTEXT_LIMIT + 6000, '银月走进井底。') }] }
    await expect(assembleNovelContext({ dir, input, instruction: '继续' })).rejects.toMatchObject({
      message: 'novel_context_budget',
      detail: expect.stringContaining('未丢弃任何原文'),
    })
  })
})
