// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPendingChatPrompt, queuePendingChatPrompt, takePendingChatPrompt } from '../../packages/client/src/utils/hermes/pending-chat-prompt'

beforeEach(() => localStorage.clear())

describe('pending chat prompt', () => {
  it('queues a prompt and takes it exactly once', () => {
    expect(queuePendingChatPrompt('s1', '生成编年史')).toBe(true)
    expect(takePendingChatPrompt('s1')).toBe('生成编年史')
    // One-shot: the second consumer in another tab gets nothing.
    expect(takePendingChatPrompt('s1')).toBeNull()
  })

  it('ignores blank prompts and unknown sessions', () => {
    expect(queuePendingChatPrompt('s1', '   ')).toBe(false)
    expect(queuePendingChatPrompt('', 'x')).toBe(false)
    expect(takePendingChatPrompt('missing')).toBeNull()
  })

  it('drops abandoned prompts after the max age', () => {
    queuePendingChatPrompt('s1', '旧指令')
    const realNow = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60 * 1000)
    expect(takePendingChatPrompt('s1')).toBeNull()
    spy.mockRestore()
  })

  it('sends only for a live, server-backed, active session', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    queuePendingChatPrompt('s1', '生成编年史')
    expect(await flushPendingChatPrompt('s1', false, false, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(await flushPendingChatPrompt('s1', true, true, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(await flushPendingChatPrompt('s1', true, false, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('生成编年史')
    // Already consumed.
    expect(await flushPendingChatPrompt('s1', true, false, send)).toBe(false)
  })
})
