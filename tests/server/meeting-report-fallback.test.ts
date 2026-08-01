import { afterEach, describe, expect, it, vi } from 'vitest'

// 用 vi.hoisted 保证 mock 在 vi.mock 工厂被提升后仍可引用。
const mocks = vi.hoisted(() => ({
  AgentBridgeClientMock: vi.fn(),
  chatMock: vi.fn(),
  streamOutputMock: vi.fn(),
  destroyMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge/client', () => ({
  AgentBridgeClient: mocks.AgentBridgeClientMock,
}))

// 避免技能解析触碰真实文件系统 / 缓存。
vi.mock('../../packages/server/src/services/meeting-asr/skill-resolver', () => ({
  prepareAnalysisSkillSection: vi.fn().mockResolvedValue(''),
}))

function wireBridge(): void {
  mocks.AgentBridgeClientMock.mockImplementation(() => ({
    chat: mocks.chatMock,
    streamOutput: mocks.streamOutputMock,
    destroy: mocks.destroyMock,
  }))
  mocks.destroyMock.mockResolvedValue({ ok: true })
}

/** 构造一个最小 SSE reader，模拟直调 LLM 的流式响应体。 */
function sseReader(payloads: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    read: async () => {
      if (i >= payloads.length) return { done: true, value: undefined }
      return { done: false, value: encoder.encode(payloads[i++]) }
    },
  }
}

function stubDirectLLM(content: string): void {
  mocks.fetchMock.mockResolvedValue({
    ok: true,
    body: {
      getReader: () => sseReader([
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] }) }\n\n`,
        'data: [DONE]\n\n',
      ]),
    },
  })
  vi.stubGlobal('fetch', mocks.fetchMock)
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of gen) out += chunk
  return out
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('meeting report generation (agent-first with fallback)', () => {
  it('uses the Hermes Agent path when the bridge is available', async () => {
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-1' })
    mocks.streamOutputMock.mockImplementation(async function* () {
      yield { delta: 'Agent ', done: false }
      yield { delta: 'Report', done: true }
    })
    stubDirectLLM('SHOULD NOT BE USED')

    const { realtimeAssistService } = await import('../../packages/server/src/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s1', 'transcript', 'general', 'default'))

    expect(report).toBe('Agent Report')
    expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    // 透传场景 reportPrompt 作为 instructions、profile 作为目标 profile。
    const chatArgs = mocks.chatMock.mock.calls[0]
    expect(chatArgs[3]).toContain('结构化 Markdown 报告')
    expect(chatArgs[4]).toBe('default')
    expect(mocks.fetchMock).not.toHaveBeenCalled()
    // 一次性会话结束后销毁。
    expect(mocks.destroyMock).toHaveBeenCalledWith('meeting-report-s1', 'default')
  })

  it('falls back to direct LLM when the bridge is unavailable and nothing was yielded', async () => {
    wireBridge()
    mocks.chatMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:18765'))
    stubDirectLLM('Direct LLM Report')

    const { realtimeAssistService } = await import('../../packages/server/src/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s2', 'transcript', 'general', 'default'))

    expect(report).toBe('Direct LLM Report')
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fall back once the agent has already streamed output', async () => {
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-1' })
    mocks.streamOutputMock.mockImplementation(async function* () {
      yield { delta: 'partial', done: false }
      throw new Error('stream broken mid-way')
    })
    stubDirectLLM('SHOULD NOT BE USED')

    const { realtimeAssistService } = await import('../../packages/server/src/services/meeting-asr/realtime-assist')

    await expect(collect(realtimeAssistService.generateReportStream('s3', 'transcript', 'general', 'default')))
      .rejects.toThrow('stream broken mid-way')
    // 已经流出过内容，不能再回退造成重复输出。
    expect(mocks.fetchMock).not.toHaveBeenCalled()
  })

  it('extracts final text from result when the agent yields no incremental delta', async () => {
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-1' })
    mocks.streamOutputMock.mockImplementation(async function* () {
      yield { delta: '', done: true, output: 'Final Report Text', status: 'complete' }
    })
    stubDirectLLM('SHOULD NOT BE USED')

    const { realtimeAssistService } = await import('../../packages/server/src/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s4', 'transcript', 'general', 'default'))

    expect(report).toBe('Final Report Text')
    expect(mocks.fetchMock).not.toHaveBeenCalled()
  })
})
