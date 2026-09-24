import { describe, expect, it } from 'vitest'
import { canonGapRepair, advanceState, recoverCoverageQuote, relevantState, validateCanon, validateConsistency } from '../../packages/server/src/services/trpg/novel-consistency'
import { validateExtraction, validateDraft, boundedText } from '../../packages/server/src/services/trpg/novel-material'
const rows = [{ index: 0, text: '小林：我想跳过去。' }, { index: 1, text: 'GM：你没跳过去，落在井底，失去三点生命。' }, { index: 2, text: '啊那个，等我点个外卖。' }]
const data = () => ({
  events: [{ kind: 'attempt', fact: '尝试跳跃', evidence: [{ index: 0, quote: '我想跳过去。' }] }, { kind: 'confirmed', fact: '失败落井受伤', evidence: [{ index: 1, quote: '没跳过去，落在井底' }] }],
  omitted: [{ index: 2, reason: '场外点餐，不影响剧情' }],
  updates: [{ entity: '银月', attribute: 'location', value: '井底', evidence: [{ index: 1, quote: '落在井底' }] }, { entity: '银月', attribute: 'health', value: '失去三点生命', evidence: [{ index: 1, quote: '失去三点生命' }] }],
})
describe('evidence and narrative consistency contracts', () => {
  it('accounts for filler without turning it into fiction and distinguishes attempts from confirmed results', () => {
    const canon = validateCanon(data(), rows, [], 9)
    expect(canon.events.map(e => [e.id, e.kind])).toEqual([['s9-e0', 'attempt'], ['s9-e1', 'confirmed']])
    expect(canon.omitted).toEqual([{ index: 2, reason: '场外点餐，不影响剧情' }])
    const before = [{ entity: '银月', attribute: 'location', value: '井口', evidence: [{ index: 0, quote: '我想跳过去。' }] }, { entity: '银月', attribute: 'inventory', value: '绳索', evidence: [{ index: 0, quote: '我想跳过去。' }] }]
    const after = advanceState(before, canon)
    expect(after.find(s => s.attribute === 'location')?.value).toBe('井底')
    expect(after.find(s => s.attribute === 'inventory')?.value).toBe('绳索')
    expect(before[0].value).toBe('井口')
  })
  it('refuses fabricated quotations, unaccounted rows and conflicting same-attribute updates', () => {
    const forged = data(); forged.events[0].evidence[0].quote = '我已经跳过去。'
    expect(() => validateCanon(forged, rows, [], 0)).toThrow('novel_invalid_output')
    const missing = data(); missing.omitted = []
    expect(() => validateCanon(missing, rows, [], 0)).toThrow('novel_invalid_output')
    const duplicate = data(); duplicate.updates.push(duplicate.updates[0])
    expect(() => validateCanon(duplicate, rows, [], 0)).toThrow('novel_invalid_output')
  })
  it('accepts verified historical state evidence without allowing it to replace scene evidence', () => {
    const historical = [{ index: 90, text: '此前银月取得了一条绳索。' }]
    const value = data()
    value.updates.push({ entity: '银月', attribute: 'inventory', value: '绳索', evidence: [{ index: 90, quote: '取得了一条绳索' }] })
    expect(validateCanon(value, rows, [], 0, historical).updates.at(-1)?.evidence[0].index).toBe(90)
    expect(() => validateCanon(value, rows, [], 0)).toThrow()
    value.events[0].evidence = [{ index: 90, quote: '取得了一条绳索' }]
    expect(() => validateCanon(value, rows, [], 0, historical)).toThrow()
  })
  it('normalizes mixed filler and index-only citations while rejecting unknown indices', () => {
    const value: any = data()
    value.events[0].evidence = [{ index: '0' }]
    value.omitted.push({ index: 0, reason: '同一句混有口头语' }, { index: 2, reason: '重复分类' })
    const canon = validateCanon(value, rows, [], 0)
    expect(canon.omitted).toHaveLength(1)
    expect(canon.events[0].evidence[0]).toEqual({ index: 0, quote: rows[0].text })
    value.events[0].evidence = [{ index: 999 }]
    expect(() => validateCanon(value, rows, [], 0)).toThrow()
  })
  it('supports a late GM correction as evidence without treating it as an earlier character discovery', () => {
    const corrected = data()
    corrected.events[1] = { kind: 'correction', fact: '按后续GM更正，落井而非跳跃成功', evidence: [{ index: 900, quote: '更正：落在井底。' }] }
    corrected.omitted.push({ index: 1, reason: '裁决已被更正，使用第900句' })
    expect(validateCanon(corrected, rows, [{ index: 900, text: 'GM更正：落在井底。' }], 0).events[1].evidence[0].index).toBe(900)
  })
  it('requires every event and actual manuscript quotations; unresolved issues never pass', () => {
    const canon = validateCanon(data(), rows, [], 0), body = '银月试着跳跃。她坠入井底，疼痛蔓延开来。'
    const coverage = [{ eventId: 's0-e0', quote: '银月试着跳跃。' }, { eventId: 's0-e1', quote: '她坠入井底，疼痛蔓延开来。' }]
    expect(validateConsistency({ coverage, issues: [] }, canon, body).passed).toBe(true)
    expect(validateConsistency({ coverage: coverage.slice(0, 1), issues: [] }, canon, body).passed).toBe(false)
    expect(validateConsistency({ coverage: [coverage[0], { eventId: 's0-e1', quote: '成功跳过。' }], issues: [] }, canon, body).passed).toBe(false)
    expect(validateConsistency({ coverage, issues: [{ detail: '后文伤势被无故清除' }] }, canon, body).passed).toBe(false)
    expect(validateConsistency({ coverage: [], issues: [{ detail: '两个事件都缺失' }] }, canon, body).passed).toBe(false)
  })
  it('stops only on factual contradictions; omissions and presentation findings stay advisory', () => {
    const canon = validateCanon(data(), rows, [], 0), body = '银月试着跳跃。她坠入井底，疼痛蔓延开来。'
    const coverage = [{ eventId: 's0-e0', quote: '银月试着跳跃。' }, { eventId: 's0-e1', quote: '她坠入井底，疼痛蔓延开来。' }]
    expect(validateConsistency({ coverage, issues: [{ detail: '把失败写成成功', kind: 'contradiction' }] }, canon, body)).toMatchObject({ passed: false, blocking: true })
    expect(validateConsistency({ coverage, issues: [{ detail: '漏了落井后的一句对白', kind: 'omission' }] }, canon, body)).toMatchObject({ passed: false, blocking: false })
    expect(validateConsistency({ coverage, issues: [{ detail: '连续两段完全重复', kind: 'format' }] }, canon, body)).toMatchObject({ passed: false, blocking: false })
    // An unlabelled issue stays blocking, so an older or careless audit cannot pass silently.
    expect(validateConsistency({ coverage, issues: [{ detail: '角色归属错误' }] }, canon, body).blocking).toBe(true)
    // Code-side missing coverage is an omission, not a contradiction.
    const gap = validateConsistency({ coverage: coverage.slice(0, 1), issues: [] }, canon, body)
    expect(gap).toMatchObject({ passed: false, blocking: false })
    expect(gap.issues.every(i => i.kind === 'omission')).toBe(true)
  })
  it('keeps malformed audit claims as report repairs rather than factual contradictions', () => {
    const canon = validateCanon(data(), rows, [], 0), body = '银月试着跳跃。她坠入井底，疼痛蔓延开来。'
    const report = validateConsistency({ coverage: [{ eventId: 's0-e9', quote: '银月试着跳跃。' }], issues: [] }, canon, body)
    expect(report.repairReport).toBe(true)
    expect(report.blocking).toBe(false)
    expect(report.issues.some(i => i.kind === 'format')).toBe(true)
  })
  it('retrieves a returning NPC and all party state without deleting offscreen facts', () => {
    const state = ['银月', '酒馆老板', '守门人'].map(entity => ({ entity, attribute: 'knowledge', value: '不知道密室位置', evidence: [] }))
    expect(relevantState(state, [{ index: 12000, text: '我们又见到了酒馆老板。' }], [{ name: '银月' }]).map(s => s.entity)).toEqual(['银月', '酒馆老板'])
    expect(state).toHaveLength(3)
  })
})

it('patches omitted filler only after explicit model classification', () => {
  const v = data(); v.omitted = []
  const gap = canonGapRepair(v, rows, [], 0)
  expect(() => gap.merge({ events: [], omitted: [], updates: [] })).toThrow()
  const fixed = gap.merge({ events: [], omitted: [{ index: 2, reason: '场外点餐' }], updates: [] })
  expect(fixed.events).toHaveLength(2)
  expect(fixed.omitted).toEqual([{ index: 2, reason: '场外点餐' }])
  expect(JSON.stringify(fixed)).not.toContain('pending classification')
})

describe('audit quote recovery', () => {
  const body = '银月试着跳跃。她坠入井底，疼痛蔓延开来。'
  it('returns the original quote when it is already a substring', () => {
    expect(recoverCoverageQuote(body, '银月试着跳跃。')).toBe('银月试着跳跃。')
  })
  it('trims surrounding whitespace before exact match', () => {
    expect(recoverCoverageQuote(body, '  银月试着跳跃。\n')).toBe('银月试着跳跃。')
  })
  it('falls back to the longest matching substring when the quote is drifted', () => {
    const recovered = recoverCoverageQuote(body, '银月试着跳跃。她坠落井底。')
    expect(recovered).toBe('银月试着跳跃。她坠')
  })
  it('accepts a drift-free quote that lost its closing punctuation', () => {
    expect(recoverCoverageQuote(body, '她坠入井底')).toBe('她坠入井底')
  })
  it('refuses a fabricated short snippet that has no real overlap', () => {
    expect(recoverCoverageQuote(body, '成功跳过。')).toBeUndefined()
  })
  it('still refuses fabricated content when the audit length is below threshold', () => {
    expect(recoverCoverageQuote(body, '跳跃成功')).toBeUndefined()
  })
  it('returns actionable failed reports for missing, null, numeric or fabricated quotes', () => {
    const canon = validateCanon(data(), rows, [], 0)
    for (const quote of [undefined, null, 42, '成功跳过。']) {
      const report = validateConsistency({ coverage: [{ eventId: 's0-e0', quote: '银月试着跳跃。' }, { eventId: 's0-e1', quote }], issues: [] }, canon, body)
      expect(report.passed).toBe(false)
      expect(report.issues.some(i => i.detail.includes('s0-e1'))).toBe(true)
    }
  })
  it('does not silently approve a drifted quote or source-evidence fallback', () => {
    const canon = validateCanon(data(), rows, [], 0)
    for (const quote of [null, '她坠入井底，疼痛扩散开来']) {
      expect(validateConsistency({ coverage: [{ eventId: 's0-e0', quote: '银月试着跳跃。' }, { eventId: 's0-e1', quote }], issues: [] }, canon, body + '没跳过去，落在井底').passed).toBe(false)
    }
  })
  it('copies genuine zero-based manuscript paragraphs and deduplicates exact claims', () => {
    const canon = validateCanon(data(), rows, [], 0)
    const coverage = [{ eventId: 's0-e0', paragraph: 0 }, { eventId: 's0-e1', paragraph: 1 }]
    const report = validateConsistency({ coverage: [...coverage, coverage[0]], issues: [] }, canon, '银月试着跳跃。\n\n她坠入井底。')
    expect(report.passed).toBe(true)
    expect(report.coverage).toEqual([{ eventId: 's0-e0', paragraph: 0, quote: '银月试着跳跃。' }, { eventId: 's0-e1', paragraph: 1, quote: '她坠入井底。' }])
  })
  it('exposes unknown IDs and invalid paragraph claims as report repair failures', () => {
    const canon = validateCanon(data(), rows, [], 0)
    for (const claim of [{ eventId: 'invented', paragraph: 0 }, { eventId: 's0-e0', paragraph: 99 }, { eventId: 's0-e0', paragraph: 0, quote: '不存在' }]) {
      const report = validateConsistency({ coverage: [claim], issues: [] }, canon, body)
      expect(report.passed).toBe(false)
      expect(report.repairReport).toBe(true)
    }
  })
  it('never approves conflicting duplicate event claims or incomplete coverage', () => {
    const canon = validateCanon(data(), rows, [], 0)
    const report = validateConsistency({ coverage: [{ eventId: 's0-e0', quote: '银月试着跳跃。' }, { eventId: 's0-e0', quote: '她坠入井底' }], issues: [] }, canon, body)
    expect(report.passed).toBe(false)
    expect(report.repairReport).toBe(true)
    expect(report.issues.some(i => i.detail.includes('s0-e1'))).toBe(true)
  })

})

describe('soft-text length validation', () => {
  const range = { from: 0, to: 1 }
  it('truncates segment facts instead of failing when the model exceeds 1800 chars', () => {
    const longFacts = '关键事件描述。'.repeat(400)
    const result = validateExtraction({
      segments: [
        { from: 0, to: 0, kind: 'story', title: '井口', facts: longFacts, dialogueIndices: [0] },
        { from: 1, to: 1, kind: 'tabletalk', title: '场外', facts: '点餐', dialogueIndices: [] },
      ],
      corrections: [],
      memory: '',
    }, range)
    expect(result.segments[0].facts.length).toBe(1800)
    expect(result.segments[1].facts).toBe('点餐')
  })
  it('truncates scene body, continuity and warnings instead of failing', () => {
    const longBody = '【银月】她抬头。'.repeat(1000)
    const longContinuity = '她仍在井底。'.repeat(800)
    const longWarnings = ['水声回荡'].concat(Array(19).fill('w'.repeat(700)))
    const result = validateDraft({
      body: longBody,
      continuity: longContinuity,
      warnings: longWarnings,
      covered: [0, 1],
    }, range)
    expect(result.body.length).toBe(7000)
    expect(result.continuity.length).toBe(4000)
    expect(result.warnings.every(w => w.length <= 500)).toBe(true)
  })
  it('truncates chapter guide but keeps title failure strict', () => {
    const result = validateExtraction({ segments: [{ from: 0, to: 0, kind: 'story', title: '井口', facts: '跳跃', dialogueIndices: [0] }, { from: 1, to: 1, kind: 'tabletalk', title: '场外', facts: '点餐', dialogueIndices: [] }], corrections: [], memory: '' }, range)
    expect(result.segments[0].facts).toBe('跳跃')
    // segment title at 160 char limit still fails rather than truncates
    try {
      validateExtraction({
        segments: [{ from: 0, to: 0, kind: 'story', title: 't'.repeat(200), facts: '跳跃', dialogueIndices: [0] }, { from: 1, to: 1, kind: 'tabletalk', title: '场外', facts: '点餐', dialogueIndices: [] }],
        corrections: [],
        memory: '',
      }, range)
      throw new Error('expected validateExtraction to throw')
    } catch (error) {
      expect((error as { detail?: string }).detail).toBe('segment title')
    }
  })
  it('boundedText helper exposes a truncate flag independent of empty-allowed', () => {
    expect(boundedText('a'.repeat(100), 10, 'segment facts', false, true)).toBe('a'.repeat(10))
    expect(() => boundedText('a'.repeat(100), 10, 'segment facts')).toThrow()
    expect(() => boundedText('   ', 10, 'segment facts', false, true)).toThrow()
    // empty=true means whitespace-only is allowed (used by memory, continuity)
    expect(boundedText('   ', 10, 'segment facts', true, true)).toBe('   ')
    expect(() => boundedText(42 as unknown as string, 10, 'segment facts', false, true)).toThrow()
  })
  it('truncates event fact, state value and consistency issue detail; keeps source quote failure strict', () => {
    const canon = validateCanon({
      events: [{ kind: 'attempt', fact: 'f'.repeat(900), evidence: rows.map(r => ({ index: r.index, quote: r.text })) }],
      omitted: [],
      updates: [{ entity: 'X', attribute: 'location', value: 'v'.repeat(900), evidence: [{ index: 0, quote: rows[0].text }] }],
    }, rows, [], 0)
    expect(canon.events[0].fact.length).toBe(700)
    expect(canon.events[0].evidence[0].quote).toBe(rows[0].text)
    expect(canon.updates[0].value.length).toBe(700)
    const report = validateConsistency({
      coverage: [{ eventId: canon.events[0].id, quote: '银月试着跳跃' }],
      issues: [{ detail: 'i'.repeat(1500) }],
    }, canon, '银月试着跳跃。')
    expect(report.issues[0].detail.length).toBe(1000)
    // source quote is not truncated: a >2000 char quote that's not in rows still fails
    try {
      validateCanon({
        events: [{ kind: 'attempt', fact: '短', evidence: [{ index: 0, quote: 'a'.repeat(2500) }] }],
        omitted: [],
        updates: [],
      }, rows, [], 0)
      throw new Error('expected validateCanon to throw')
    } catch (error) {
      expect((error as { detail?: string }).detail).toBe('source quote')
    }
  })
})

it('keeps optional literary suggestions separate without waiving factual coverage or contradictions', () => {
  const canon = validateCanon(data(), rows, [], 9)
  const body = '她试图跳跃，却落在井底，失去三点生命。'
  const coverage = canon.events.map(e => ({ eventId: e.id, paragraph: 0 }))
  const report = { coverage, issues: [], suggestions: [{ detail: '可补光线过渡，但不是必需事实。' }] }
  expect(validateConsistency(report, canon, body)).toMatchObject({ passed: true, suggestions: report.suggestions })
  expect(validateConsistency({ ...report, coverage: [] }, canon, body).passed).toBe(false)
  expect(validateConsistency({ ...report, issues: [{ detail: '把尝试写成了成功。' }] }, canon, body).passed).toBe(false)
})
