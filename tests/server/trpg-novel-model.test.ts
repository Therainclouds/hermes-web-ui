import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const bridge = vi.hoisted(() => ({ chat: vi.fn(), streamOutput: vi.fn(), destroy: vi.fn() }))
vi.mock('../../packages/server/src/services/hermes/agent-bridge/client', () => ({ AgentBridgeClient: class {
  chat = bridge.chat
  streamOutput = bridge.streamOutput
  destroy = bridge.destroy
} }))
import { novelModel } from '../../packages/server/src/services/trpg/novel-model'
beforeEach(() => {
  vi.clearAllMocks()
  bridge.chat.mockResolvedValue({ run_id: 'run' }); bridge.destroy.mockResolvedValue({ ok: true })
})
afterEach(() => vi.useRealTimers())
it('uses a fresh profile session and final response instead of reasoning/delta output', async () => {
  bridge.streamOutput.mockImplementation(async function* () {
    yield { delta: 'intermediate' }
    yield { done: true, status: 'complete', result: { final_response: '{"body":"final"}' } }
  })
  const call = novelModel('table')
  expect(await call('write', { text: 'source' }, new AbortController().signal)).toBe('{"body":"final"}')
  await call('review', { text: 'source' }, new AbortController().signal, { provider: 'review-provider', model: 'review-model' })
  expect(bridge.chat.mock.calls[1][5]).toMatchObject({ provider: 'review-provider', model: 'review-model' })
  expect(bridge.chat.mock.calls[0][4]).toBe('table')
  expect(bridge.chat.mock.calls[0][0]).not.toBe(bridge.chat.mock.calls[1][0])
  expect(bridge.chat.mock.calls[0][2]).toEqual([])
  expect(bridge.destroy).toHaveBeenCalledTimes(2)
})
it('rejects incomplete streams and provider failure messages instead of accepting partial chapters', async () => {
  bridge.streamOutput.mockImplementation(async function* () { yield { delta: '{"body":"partial"}' } })
  await expect(novelModel('table')('write', {}, new AbortController().signal)).rejects.toThrow('novel_model_failed')
  bridge.streamOutput.mockImplementation(async function* () { yield { done: true, result: { final_response: 'API call failed after 3 retries' } } })
  await expect(novelModel('table')('write', {}, new AbortController().signal)).rejects.toThrow('novel_model_failed')
  bridge.streamOutput.mockImplementation(async function* () { yield { done: true, status: 'interrupted', result: { final_response: '{"body":"partial"}' } } })
  await expect(novelModel('table')('write', {}, new AbortController().signal)).rejects.toThrow('novel_model_failed')
  expect(bridge.destroy).toHaveBeenCalledTimes(3)
})
it('cancellation before a call does not start a model session', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(novelModel('table')('write', {}, controller.signal)).rejects.toThrow()
  expect(bridge.chat).not.toHaveBeenCalled()
})
it('rejects over-budget context without silently trimming source', async () => {
  await expect(novelModel('table')('write', { text: '字'.repeat(30000) }, new AbortController().signal)).rejects.toThrow('novel_context_budget')
  expect(bridge.chat).not.toHaveBeenCalled()
})
it('passes visual input as a real multimodal message instead of JSON text', async () => {
  bridge.streamOutput.mockImplementation(async function* () { yield { done: true, result: { final_response: '{}' } } })
  await novelModel('table')('inspect', { task: 'vision' }, new AbortController().signal, { provider: 'vl', model: 'vision' }, 'data:image/jpeg;base64,cGl4ZWxz')
  expect(bridge.chat.mock.calls[0][1]).toEqual([{ type: 'text', text: '{"task":"vision"}' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,cGl4ZWxz' } }])
  expect(bridge.chat.mock.calls[0][5]).toMatchObject({ provider: 'vl', model: 'vision' })
})
it('reports provider usage when final bridge counters exist', async () => {
  bridge.streamOutput.mockImplementation(async function* () { yield { done: true, result: { final_response: '{}', input_tokens: 321, output_tokens: 17 } } })
  const usage = vi.fn()
  await novelModel('table')('write', {}, new AbortController().signal, undefined, undefined, usage)
  expect(usage).toHaveBeenCalledWith({ inputTokens: 321, outputTokens: 17 })
})
it('streams structured output previews and excludes non-JSON reasoning preambles', async () => {
  const output = vi.fn()
  bridge.streamOutput.mockImplementation(async function* () { yield { delta: 'reasoning preamble' }; yield { done: true, result: { final_response: '{"body":"final"}' } } })
  await novelModel('table')('write', {}, new AbortController().signal, undefined, undefined, undefined, output)
  expect(output.mock.calls).toEqual([['{"body":"final"}']])
  output.mockClear()
  bridge.streamOutput.mockImplementation(async function* () { yield { delta: '{"body":"' }; yield { delta: 'first' }; yield { done: true, result: { final_response: '{"body":"first"}' } } })
  await novelModel('table')('write', {}, new AbortController().signal, undefined, undefined, undefined, output)
  expect(output.mock.calls[1][0]).toBe('{"body":"first')
})
