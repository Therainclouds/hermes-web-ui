import { describe, expect, it, vi } from 'vitest'
import {
  looksLikeStandaloneAgentFailure,
  needsToolLookup,
  runAgentAnalysis,
  streamAgentReport,
} from '../../packages/server/src/services/meeting-asr/agent-bridge'
import type { SceneTemplate } from '../../packages/server/src/services/meeting-asr/scene-templates'

function fakeTemplate(overrides: Partial<SceneTemplate> = {}): SceneTemplate {
  return {
    id: 'general',
    name: 'General',
    systemPrompt: 'SYSTEM',
    reportPrompt: 'REPORT',
    ...(overrides as any),
  }
}

function makeBridge(overrides: Partial<Record<'chat' | 'streamOutput' | 'destroy', any>> = {}) {
  return {
    chat: vi.fn().mockResolvedValue({ ok: true, run_id: 'run-1' }),
    streamOutput: vi.fn(),
    destroy: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

describe('looksLikeStandaloneAgentFailure', () => {
  it('flags provider failure messages (the A+C bug signature)', () => {
    expect(looksLikeStandaloneAgentFailure(
      'API call failed after 3 retries: Provider returned an empty stream with no finish_reason',
    )).toBe(true)
    expect(looksLikeStandaloneAgentFailure('HTTP 502 from upstream')).toBe(true)
    expect(looksLikeStandaloneAgentFailure('Error: 429 rate limit exceeded, slow down')).toBe(true)
    expect(looksLikeStandaloneAgentFailure('请求失败：额度不足')).toBe(true)
    expect(looksLikeStandaloneAgentFailure('401 Unauthorized: invalid api key')).toBe(true)
  })

  it('does not flag real report content', () => {
    expect(looksLikeStandaloneAgentFailure('# 会议纪要\n\n'.padEnd(3000, '正文') )).toBe(false)
    expect(looksLikeStandaloneAgentFailure('团队讨论了 Q3 的 OKR 与交付计划。')).toBe(false)
    expect(looksLikeStandaloneAgentFailure('')).toBe(false)
    expect(looksLikeStandaloneAgentFailure('   ')).toBe(false)
  })

  it('ignores failure-shaped text longer than 2 KB', () => {
    const longText = 'API call failed after 3 retries. ' + 'x'.repeat(2500)
    expect(looksLikeStandaloneAgentFailure(longText)).toBe(false)
  })
})

describe('needsToolLookup', () => {
  it('triggers on legal keywords for the legal scene', () => {
    expect(needsToolLookup('legal', '根据民法典第一千零二十四条…')).toBe(true)
  })

  it('does not trigger for scenes without a trigger map', () => {
    expect(needsToolLookup('general', '根据民法典')).toBe(false)
  })

  it('does not trigger when no keyword matches', () => {
    expect(needsToolLookup('legal', '今天天气不错')).toBe(false)
  })
})

describe('runAgentAnalysis (bridge injected)', () => {
  it('accumulates deltas and parses the final JSON round', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '{"keyPoint":"kp"', done: false }
      yield { delta: ',"analysis":"an"}', done: true }
    })

    const round = await runAgentAnalysis('transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })

    expect(round).not.toBeNull()
    expect(round!.keyPoint).toBe('kp')
    // prompt 注入与 profile 透传
    expect(bridge.chat.mock.calls[0][1]).toContain('transcript')
    expect(bridge.chat.mock.calls[0][3]).toBe('SYSTEM')
    expect(bridge.chat.mock.calls[0][4]).toBe('default')
    // 一次性会话用后即毁
    expect(bridge.destroy).toHaveBeenCalledTimes(1)
    expect(String(bridge.destroy.mock.calls[0][0])).toMatch(/^meeting-analyze-/)
  })

  it('extracts final_response when no incremental delta was streamed', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '', done: true, result: { final_response: '{"keyPoint":"from-result","analysis":"a"}' } }
    })

    const round = await runAgentAnalysis('transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })
    expect(round!.keyPoint).toBe('from-result')
  })

  it('throws when the run reports an error status', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '', status: 'error', error: 'boom' }
    })

    await expect(runAgentAnalysis('transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })).rejects.toThrow('boom')
  })

  it('throws when the agent produced no output at all', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '', done: true, output: '' }
    })

    await expect(runAgentAnalysis('transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })).rejects.toThrow(/no output/)
  })

  it('destroys the session even when the bridge throws (finally)', async () => {
    const bridge = makeBridge()
    bridge.chat.mockRejectedValue(new Error('bridge down'))

    await expect(runAgentAnalysis('transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })).rejects.toThrow('bridge down')
    expect(bridge.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('streamAgentReport (bridge injected)', () => {
  it('streams deltas as they arrive', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: 'Hello ', done: false }
      yield { delta: 'Report', done: true }
    })

    const chunks: string[] = []
    for await (const c of streamAgentReport('s1', 'transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('Hello Report')
    expect(bridge.destroy).toHaveBeenCalledWith('meeting-report-s1', 'default')
  })

  it('throws on a graceful agent failure written as final delta (fake completion)', async () => {
    const bridge = makeBridge()
    const failureText = 'API call failed after 3 retries: Provider returned an empty stream with no finish_reason'
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '', done: false }
      yield { delta: failureText, done: true, status: 'complete' }
    })

    const gen = streamAgentReport('s2', 'transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })
    await expect(async () => {
      for await (const _c of gen) { /* no-op */ }
    }).rejects.toThrow(/API call failed after/)
  })

  it('yields result.final_response when no delta was streamed and it is not a failure', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '', done: true, status: 'complete', result: { final_response: 'Final Report' } }
    })

    const chunks: string[] = []
    for await (const c of streamAgentReport('s3', 'transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('Final Report')
  })

  it('throws when nothing was yielded and no result is available', async () => {
    const bridge = makeBridge()
    bridge.streamOutput.mockImplementation(async function* () {
      yield { delta: '', done: true, status: 'complete' }
    })

    const gen = streamAgentReport('s4', 'transcript', fakeTemplate(), 'default', {
      createBridge: () => bridge as any,
    })
    await expect(async () => {
      for await (const _c of gen) { /* no-op */ }
    }).rejects.toThrow(/no output/)
  })
})
