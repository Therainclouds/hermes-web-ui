import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 避免技能解析触碰真实文件系统 / 缓存（与 meeting-report-fallback.test.ts 相同的做法）。
vi.mock('../../packages/server/src/services/meeting-asr/skill-resolver', () => ({
  prepareAnalysisSkillSection: vi.fn().mockResolvedValue(''),
}))

import {
  analyzeViaDirectLLM,
  loadLLMConfig,
  streamDirectLLMReport,
} from '../../packages/server/src/services/meeting-asr/direct-llm'
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

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'direct-llm-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.clearAllMocks()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('loadLLMConfig', () => {
  it('reads llm config from config.json under the data dir', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      llm: { api_key: 'sk-test', base_url: 'https://example.invalid/v1', model: 'test-model' },
    }), 'utf-8')

    const config = await loadLLMConfig(dir)
    expect(config).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
    })
  })

  it('falls back to the dashscope key when llm.api_key is missing', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      asr: { dashscope_api_key: 'sk-asr' },
    }), 'utf-8')

    const config = await loadLLMConfig(dir)
    expect(config!.apiKey).toBe('sk-asr')
    // baseUrl/model 应用默认值
    expect(config!.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(config!.model).toBe('qwen-plus')
  })

  it('returns null when config.json is missing or has no key', async () => {
    expect(await loadLLMConfig(await tempDir())).toBeNull()

    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), JSON.stringify({ llm: {} }), 'utf-8')
    expect(await loadLLMConfig(dir)).toBeNull()
  })
})

describe('analyzeViaDirectLLM', () => {
  it('posts a chat completion and parses the JSON round', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ keyPoint: 'kp', analysis: 'an' }) } }] }),
    })
    const loadConfig = vi.fn().mockResolvedValue({ apiKey: 'sk', baseUrl: 'https://example.invalid/v1', model: 'm' })

    const round = await analyzeViaDirectLLM('transcript', fakeTemplate(), 'default', null, undefined, { fetchImpl: fetchImpl as any, loadConfig })

    expect(round!.keyPoint).toBe('kp')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://example.invalid/v1/chat/completions')
    expect((init as any).headers.Authorization).toBe('Bearer sk')
    const body = JSON.parse((init as any).body)
    expect(body.model).toBe('m')
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].content).toContain('transcript')
    expect(body.stream).toBeUndefined()
  })

  it('injects the speech evaluation context for the speech scene', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    })
    const loadConfig = vi.fn().mockResolvedValue({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' })

    await analyzeViaDirectLLM('t', fakeTemplate({ id: 'speech', systemPrompt: 'S' }), 'default', {
      wordOfTheDay: 'resilience',
      timerDurationSec: 300,
      currentRemainingSec: 41.6,
      currentPhase: 'yellow',
      timerRecords: [{ label: '开场', durationSec: 65, overtimeSec: 5 }],
    }, undefined, { fetchImpl: fetchImpl as any, loadConfig })

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as any).body)
    expect(body.messages[0].content).toContain('每日一词：resilience')
    expect(body.messages[0].content).toContain('当前倒计时：剩余 42 秒（yellow）')
    expect(body.messages[0].content).toContain('开场：65 秒（超时 5 秒）')
    expect(body.max_tokens).toBe(1200)
  })

  it('returns null without calling the API when no config is available', async () => {
    const fetchImpl = vi.fn()
    const round = await analyzeViaDirectLLM('t', fakeTemplate(), 'default', null, undefined, {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => null,
    })
    expect(round).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws a classified error when the API responds non-OK', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    })
    await expect(analyzeViaDirectLLM('t', fakeTemplate(), 'default', null, undefined, {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })).rejects.toThrow('LLM API error 502: bad gateway')
  })
})

describe('streamDirectLLMReport', () => {
  function sseResponse(payloads: string[]) {
    const encoder = new TextEncoder()
    let i = 0
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= payloads.length) return { done: true, value: undefined }
            return { done: false, value: encoder.encode(payloads[i++]) }
          },
        }),
      },
    }
  }

  it('streams delta chunks and stops at [DONE]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'World' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]))

    const chunks: string[] = []
    for await (const c of streamDirectLLMReport('t', fakeTemplate(), 'default', {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('Hello World')
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as any).body)
    expect(body.stream).toBe(true)
  })

  it('accepts message.content frames (non-delta endpoints)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      `data:${JSON.stringify({ choices: [{ message: { content: 'no-space-format' } }] })}\n\n`,
    ]))

    const chunks: string[] = []
    for await (const c of streamDirectLLMReport('t', fakeTemplate(), 'default', {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('no-space-format')
  })

  it('throws on an in-band error frame', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ error: { message: 'empty stream' } })}\n\n`,
    ]))

    const gen = streamDirectLLMReport('t', fakeTemplate(), 'default', {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })
    await expect(async () => {
      for await (const _c of gen) { /* no-op */ }
    }).rejects.toThrow('empty stream')
  })

  it('retries non-streaming when the stream yields nothing, and surfaces its content', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sseResponse(['data: [DONE]\n\n']))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Non-streaming content' } }] }),
      })

    const chunks: string[] = []
    for await (const c of streamDirectLLMReport('t', fakeTemplate(), 'default', {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('Non-streaming content')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse((fetchImpl.mock.calls[1][1] as any).body).stream).toBe(false)
  })

  it('throws when there is no response body at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, body: null })
    const gen = streamDirectLLMReport('t', fakeTemplate(), 'default', {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })
    await expect(async () => {
      for await (const _c of gen) { /* no-op */ }
    }).rejects.toThrow('No response body')
  })

  it('flushes a trailing data line that lacks a newline', async () => {
    const trailing = `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'head' } }] })}\n\n${trailing}`,
    ]))

    const chunks: string[] = []
    for await (const c of streamDirectLLMReport('t', fakeTemplate(), 'default', {
      fetchImpl: fetchImpl as any,
      loadConfig: async () => ({ apiKey: 'sk', baseUrl: 'https://x/v1', model: 'm' }),
    })) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('headtail')
  })

  it('throws when config is unavailable', async () => {
    const gen = streamDirectLLMReport('t', fakeTemplate(), 'default', {
      loadConfig: async () => null,
    })
    await expect(async () => {
      for await (const _c of gen) { /* no-op */ }
    }).rejects.toThrow('LLM config not available')
  })
})
