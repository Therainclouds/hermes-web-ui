import { describe, expect, it } from 'vitest'
import {
  createDshTurnAccumulator,
  dshSessionEventToResponsesEvents,
} from '../../packages/server/src/services/agent-runner/adapters/dsh-session-event-mapper'

function eventsFor(state: ReturnType<typeof createDshTurnAccumulator>, event: any) {
  return dshSessionEventToResponsesEvents(state, event)
}

describe('dsh session event mapper', () => {
  it('opens the text item once and streams text deltas', () => {
    const state = createDshTurnAccumulator('resp_1')
    const first = eventsFor(state, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: 'hello' } } })
    const second = eventsFor(state, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: ' world' } } })

    expect(first.map(e => e.type)).toEqual(['response.output_item.added', 'response.content_part.added', 'response.output_text.delta'])
    expect(second.map(e => e.type)).toEqual(['response.output_text.delta'])
    expect(state.text).toBe('hello world')
    expect(state.textStarted).toBe(true)
  })

  it('maps reasoning deltas without opening the text item', () => {
    const state = createDshTurnAccumulator('resp_1')
    const events = eventsFor(state, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } } })
    expect(events.map(e => e.type)).toEqual(['response.reasoning.delta'])
    expect(state.textStarted).toBe(false)
  })

  it('maps a tool call to function_call output items', () => {
    const state = createDshTurnAccumulator('resp_1')
    const events = eventsFor(state, { type: 'tool/call', data: { callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } })
    expect(events.map(e => e.type)).toEqual(['response.output_item.added', 'response.output_item.done'])
    expect(events[0].data).toMatchObject({ item: { type: 'function_call', id: 'call_1', name: 'bash' } })
    expect(state.toolOutputIndex.get('call_1')).toBe(0)
  })

  it('correlates a tool result with its call output index', () => {
    const state = createDshTurnAccumulator('resp_1')
    eventsFor(state, { type: 'tool/call', data: { callId: 'call_1', name: 'bash', arguments: '{}' } })
    const result = eventsFor(state, {
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] } },
    })
    expect(result.map(e => e.type)).toEqual(['response.output_item.done'])
    expect(result[0].data).toMatchObject({
      output_index: 0,
      item: { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    })
  })

  it('records usage from a usage chunk and terminal error from turn/end', () => {
    const state = createDshTurnAccumulator('resp_1')
    eventsFor(state, { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } } } })
    expect(state.pendingUsage).toMatchObject({ input_tokens: 10, output_tokens: 3, total_tokens: 13 })

    eventsFor(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } } })
    expect(state.pendingError).toBe('boom')
  })

  it('ignores unrelated session events', () => {
    const state = createDshTurnAccumulator('resp_1')
    expect(eventsFor(state, { type: 'step/start', data: { turn: 1, step: 1 } })).toEqual([])
    expect(eventsFor(state, { type: 'todo/write', data: { todos: [] } })).toEqual([])
  })
})
