import { expect, it } from 'vitest'
import { compactNovelEvidence } from '../../packages/server/src/services/trpg/novel-economy'
it('removes only redundant source quotations and retains historical and manuscript evidence', () => {
  const input = { rows: [{ index: 1, text: '角色掉进井里。' }], events: [{ evidence: [{ index: 1, quote: '掉进井里' }, { index: 0, quote: '早前得到了绳索' }] }], coverage: [{ eventId: 's0-e0', quote: '他坠入井底。' }] }
  const compact: any = compactNovelEvidence(input)
  expect(compact.rows).toEqual(input.rows)
  expect(compact.events[0].evidence).toEqual([{ index: 1 }, { index: 0, quote: '早前得到了绳索' }])
  expect(compact.coverage).toEqual(input.coverage)
  expect(input.events[0].evidence[0].quote).toBe('掉进井里')
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(input).length)
})
