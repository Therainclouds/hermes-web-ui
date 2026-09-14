import { describe, expect, it, vi } from 'vitest'
import { boundedAgentLoop } from '../../packages/server/src/services/trpg/novel-loop'

type Action = { tool: 'read' | 'patch' | 'conflict'; value?: number }
const invalid = (detail: string) => Object.assign(new Error('novel_invalid_output'), { detail })

describe('bounded agent loop', () => {
  it('terminates on a code-applied change, feeding a refused change back as an observation', async () => {
    let applied = 0
    const decide = vi.fn()
      .mockResolvedValueOnce({ tool: 'read' })
      .mockResolvedValueOnce({ tool: 'patch', value: 1 })
      .mockResolvedValueOnce({ tool: 'patch', value: 2 })
    const result = await boundedAgentLoop<Action, number>({
      maxTurns: 6,
      decide,
      classify: action => {
        if (action.tool === 'conflict') return { type: 'conflict', reason: 'cannot satisfy both' }
        if (action.tool === 'patch') {
          return { type: 'apply', tool: 'patch', describe: `patch(${action.value})`, run: () => { if (action.value === 1) throw invalid('value 1 is refused'); applied = action.value!; return applied } }
        }
        return { type: 'observe', tool: 'read', key: 'read:1', run: async () => ['row'] }
      },
    })
    expect(result.result).toBe(2)
    expect(result.action).toBe('patch(2)')
    expect(result.rejected).toEqual(['value 1 is refused'])
    // The refusal is visible to the next decision, not swallowed.
    expect(decide.mock.calls[2][0].observations).toContainEqual({ tool: 'patch', result: { error: 'value 1 is refused' } })
  })

  it('answers a repeated identical read instead of executing it again', async () => {
    const run = vi.fn(async () => ['row'])
    const decide = vi.fn().mockResolvedValue({ tool: 'read' })
    const result = await boundedAgentLoop<Action, number>({
      maxTurns: 4,
      decide,
      classify: () => ({ type: 'observe', tool: 'read', key: 'read:same', run }),
    })
    // One real read, then repeated-read corrections, then the budget ends the loop.
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.result).toBeUndefined()
    expect(result.conflict).toBeTruthy()
    expect(decide).toHaveBeenCalledTimes(4)
    expect(result.observations.some(o => (o.result as { error?: string })?.error?.includes('same read'))).toBe(true)
  })

  it('bounds the observation window handed back to the model', async () => {
    const decide = vi.fn()
    let turn = 0
    decide.mockImplementation(async () => ({ tool: 'read', value: turn++ }))
    await boundedAgentLoop<Action, number>({
      maxTurns: 9,
      maxObservations: 3,
      decide,
      classify: action => ({ type: 'observe', tool: 'read', key: `read:${action.value}`, run: async () => [action.value] }),
    })
    const last = decide.mock.calls.at(-1)![0].observations
    // marker + the most recent three observations
    expect(last).toHaveLength(4)
    expect(last[0].result).toMatchObject({ note: expect.stringContaining('省略') })
  })

  it('stops immediately on an explicit conflict and surfaces the reason', async () => {
    const decide = vi.fn().mockResolvedValue({ tool: 'conflict' })
    const result = await boundedAgentLoop<Action, number>({
      maxTurns: 5,
      decide,
      classify: () => ({ type: 'conflict', reason: '原文未确认浓雾' }),
    })
    expect(result.conflict).toBe('原文未确认浓雾')
    expect(decide).toHaveBeenCalledTimes(1)
  })
})
