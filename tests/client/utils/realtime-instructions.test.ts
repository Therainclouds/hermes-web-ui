import { describe, expect, it } from 'vitest'
import {
  buildRealtimeInstructions,
  serializeChatHistory,
  countUserTurns,
  CONTEXT_WARNING_RATIO,
  HISTORY_LIMIT,
  HISTORY_MAX_MESSAGES,
  SOUL_LIMIT,
} from '@/utils/realtime-instructions'

describe('buildRealtimeInstructions', () => {
  it('falls back to the default persona when soul is empty', () => {
    for (const soul of ['', '   ', null, undefined]) {
      const result = buildRealtimeInstructions(soul as string | null | undefined)
      // The fallback persona must be the first block, followed by supplement + tools.
      expect(result).toContain('友好的中文语音助手')
      expect(result).toContain('补充指令')
      expect(result).toContain('query_hermes_agent')
      // No history block.
      expect(result).not.toContain('最近对话的摘要')
    }
  })

  it('keeps the soul as the leading persona block', () => {
    const soul = '你是资深产品教练"老王"，说话直接、强调落地。'
    const result = buildRealtimeInstructions(soul)
    expect(result.startsWith(soul)).toBe(true)
    // supplement + tool reference + rules must all follow
    expect(result).toContain('实时对话补充指令')
    expect(result).toContain('list_recent_sessions')
    expect(result).toContain('工具使用守则')
  })

  it('truncates an over-long soul to SOUL_LIMIT with a marker', () => {
    const soul = '长'.repeat(SOUL_LIMIT + 500)
    const result = buildRealtimeInstructions(soul)
    expect(result).not.toContain('长'.repeat(SOUL_LIMIT + 1))
    expect(result).toContain('（人格描述已截断）')
    // supplement / tool rules must still be present after truncation
    expect(result).toContain('实时对话补充指令')
    expect(result).toContain('工具使用守则')
  })

  it('appends the history block only when history is provided', () => {
    const withHistory = buildRealtimeInstructions('人格A', { history: '[用户]: 你好\n[助手]: 你好！' })
    expect(withHistory).toContain('[用户]: 你好')
    expect(withHistory).toContain('[助手]: 你好！')

    const withoutHistory = buildRealtimeInstructions('人格A', { history: '   ' })
    expect(withoutHistory).not.toContain('[用户]:')
  })

  it('treats blank history the same as no history', () => {
    expect(buildRealtimeInstructions('人格A', { history: '' })).toBe(buildRealtimeInstructions('人格A'))
  })

  it('appends the meeting-context block when meetingContext is provided', () => {
    const result = buildRealtimeInstructions('人格A', { meetingContext: '会议标题：周会\n逐字稿：……' })
    expect(result).toContain('会议上下文')
    expect(result).toContain('会议标题：周会')
    // history 与 meetingContext 是两个独立的追加块
    expect(result).not.toContain('最近对话的摘要')

    const both = buildRealtimeInstructions('人格A', {
      history: '[用户]: 上一题',
      meetingContext: '会议标题：周会',
    })
    expect(both).toContain('最近对话的摘要')
    expect(both).toContain('会议上下文')
    expect(both.indexOf('最近对话的摘要')).toBeLessThan(both.indexOf('会议上下文'))
  })
})

describe('serializeChatHistory', () => {
  it('keeps only user/assistant messages with content, in chronological order', () => {
    const messages = [
      { role: 'user', content: '第一问' },
      { role: 'tool', content: '工具输出应被跳过' },
      { role: 'system', content: '系统消息应被跳过' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '   ' },
      { role: 'user', content: '第二问' },
    ]
    const result = serializeChatHistory(messages)
    expect(result).toBe('[用户]: 第一问\n[助手]: 第一答\n[用户]: 第二问')
  })

  it('caps at maxMessages keeping the most recent turns', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }))
    const result = serializeChatHistory(messages, { maxMessages: 4 })
    expect(result).toBe('[用户]: msg-26\n[助手]: msg-27\n[用户]: msg-28\n[助手]: msg-29')
  })

  it('drops the oldest lines first when the char budget is exceeded', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(HISTORY_LIMIT) },
      { role: 'assistant', content: 'keep-me' },
    ]
    const result = serializeChatHistory(messages)
    expect(result).toBe('[助手]: keep-me')
  })

  it('defaults to HISTORY_MAX_MESSAGES entries', () => {
    const messages = Array.from({ length: HISTORY_MAX_MESSAGES + 10 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }))
    const result = serializeChatHistory(messages)
    // 30 messages → last 20 kept (m10..m29), the earliest 10 dropped.
    expect(result.startsWith('[用户]: m10\n')).toBe(true)
    expect(result.endsWith(`[用户]: m${HISTORY_MAX_MESSAGES + 9}`)).toBe(true)
  })

  it('collapses whitespace inside message content', () => {
    const result = serializeChatHistory([
      { role: 'user', content: '多  行\n  内容\t拼接' },
    ])
    expect(result).toBe('[用户]: 多 行 内容 拼接')
  })
})

describe('countUserTurns + CONTEXT_WARNING_RATIO', () => {
  it('counts only user turns (DashScope audioTurns counts one utterance per turn)', () => {
    const turns = [
      { role: 'user' as const },
      { role: 'assistant' as const },
      { role: 'user' as const },
      { role: 'assistant' as const },
      { role: 'user' as const },
    ]
    expect(countUserTurns(turns)).toBe(3)
    expect(countUserTurns([])).toBe(0)
  })

  it('warning ratio is the documented 80%', () => {
    expect(CONTEXT_WARNING_RATIO).toBe(0.8)
  })

  it('near-limit math: 3 user turns against a 4-turn cap stays silent, 4 fires', () => {
    // qwen3-omni-flash-realtime has audioTurns = 8; simulate its quarter.
    const total = 4
    const threshold = Math.floor(total * CONTEXT_WARNING_RATIO)
    expect(threshold).toBe(3)
    expect(countUserTurns([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]) >= threshold).toBe(false)
    expect(countUserTurns([
      { role: 'user' }, { role: 'assistant' },
      { role: 'user' }, { role: 'assistant' },
      { role: 'user' },
    ]) >= threshold).toBe(true)
  })
})
