import { describe, it, expect, vi } from 'vitest'
import { characterName, parseInput, generateHighlight, resolveEndpoint, evidenceInTranscript } from '../../packages/server/src/services/trpg/highlight'
const input = { transcript: '小林：银月举起盾牌挡住箭矢。', setting: '城门', style: '水彩', characters: [{ id: 'elf', name: '【银月】', player: '小林', appearance: '银发', card: '秘密：王族' }] }
const loadConfig = async () => ({ apiKey: 'secret', baseUrl: 'https://example.invalid/v1/', model: 'test' })
const output = { scene: '月下城门，低机位', actions: [{ characterId: 'elf', action: '举盾挡箭', evidence: '银月举起盾牌挡住箭矢。' }] }
function deps(value: unknown) { return { loadConfig, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))) as unknown as typeof fetch } }
describe('TRPG highlight', () => {
  it('normalizes names and emits explicit actions without leaking character card secrets', async () => {
    expect(characterName('【银月】\n')).toBe('【银月】')
    const d = deps(output)
    const result = await generateHighlight(parseInput(input), undefined, d)
    expect(result.prompt).toContain('【银月】：外观：银发。动作：举盾挡箭')
    expect(result.prompt).not.toContain('王族')
    expect(result.actions[0].evidence).toBe(output.actions[0].evidence)
    expect(d.fetchImpl).toHaveBeenCalledWith('https://example.invalid/v1/chat/completions', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
  it('rejects empty transcripts, duplicate formatted names and oversized data', () => {
    for (const v of [{ ...input, transcript: '' }, { ...input, transcript: 'x'.repeat(12001) }, { ...input, characters: [...input.characters, { ...input.characters[0], id: 'b', name: '银月' }] }, { ...input, characters: [{ ...input.characters[0], name: '【】' }] }]) expect(() => parseInput(v)).toThrow('invalid_input')
  })
  it('rejects unknown characters and fabricated quotes', async () => {
    for (const action of [{ ...output.actions[0], characterId: 'unknown' }, { ...output.actions[0], evidence: '击败巨龙' }]) {
      await expect(generateHighlight(parseInput(input), undefined, deps({ ...output, actions: [action] }))).rejects.toThrow('invalid_output')
    }
  })
  it('reports no highlight and unavailable model distinctly', async () => {
    await expect(generateHighlight(parseInput(input), undefined, deps(null))).rejects.toThrow('no_highlight')
    await expect(generateHighlight(parseInput(input), undefined, { loadConfig: async () => null })).rejects.toThrow('llm_not_configured')
  })
  it('does not expose provider error bodies', async () => {
    await expect(generateHighlight(parseInput(input), undefined, { loadConfig, fetchImpl: vi.fn(async () => new Response('secret', { status: 500 })) as unknown as typeof fetch })).rejects.toThrow('generation_failed')
  })

  it('uses meeting config directly and never silently switches to an Agent', async () => {
    await expect(generateHighlight(parseInput(input), 'default', { loadConfig: async () => null })).rejects.toThrow('llm_not_configured')
    const d = deps(output)
    const config = { apiKey: 'meeting-secret', baseUrl: 'https://meeting.invalid/v1', model: 'meeting-model' }
    await generateHighlight(parseInput({ ...input, llmConfig: config }), 'default', d)
    const [url, init] = (d.fetchImpl as any).mock.calls[0]
    expect(url).toBe('https://meeting.invalid/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('meeting-model')
    expect(JSON.stringify(body.messages)).not.toContain('meeting-secret')
  })

  it('normalizes hand-typed base URLs and rejects unusable ones explicitly', () => {
    expect(resolveEndpoint('https://example.invalid/v1/')).toEqual({ url: 'https://example.invalid/v1/chat/completions', dialect: 'chat_completions' })
    expect(resolveEndpoint('api.example.com/v1')).toEqual({ url: 'https://api.example.com/v1/chat/completions', dialect: 'chat_completions' })
    // 用户真实配置：协议相对 + MiniMax Anthropic 端点。
    expect(resolveEndpoint('//api.minimax.cn/anthropic')).toEqual({ url: 'https://api.minimax.cn/anthropic/v1/messages', dialect: 'anthropic_messages' })
    expect(resolveEndpoint('https://api.minimaxi.com/anthropic/v1')).toEqual({ url: 'https://api.minimaxi.com/anthropic/v1/messages', dialect: 'anthropic_messages' })
    // 直接粘贴完整端点时不再重复拼路径。
    expect(resolveEndpoint('https://api.openai.com/v1/chat/completions')).toEqual({ url: 'https://api.openai.com/v1/chat/completions', dialect: 'chat_completions' })
    expect(resolveEndpoint('https://api.minimaxi.com/anthropic/v1/messages')).toEqual({ url: 'https://api.minimaxi.com/anthropic/v1/messages', dialect: 'anthropic_messages' })
    for (const bad of ['not a url', 'ftp://example.invalid/v1']) expect(() => resolveEndpoint(bad)).toThrow('llm_config_invalid')
  })

  it('speaks the Anthropic Messages dialect for /anthropic endpoints', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(output) }] }))) as unknown as typeof fetch
    const config = { apiKey: 'mini-secret', baseUrl: '//api.minimax.cn/anthropic', model: 'minimax-m3' }
    const result = await generateHighlight(parseInput({ ...input, llmConfig: config }), undefined, { loadConfig, fetchImpl })
    expect(result.actions[0].name).toBe('【银月】')
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe('https://api.minimax.cn/anthropic/v1/messages')
    expect(init.headers['x-api-key']).toBe('mini-secret')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(init.body)
    expect(body.system).toContain('画面导演')
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('transcript') }])
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('distinguishes unreachable endpoints and carries the upstream status without leaking the body', async () => {
    await expect(generateHighlight(parseInput(input), undefined, {
      loadConfig,
      fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })).rejects.toThrow('llm_unreachable')

    const err = await generateHighlight(parseInput(input), undefined, {
      loadConfig,
      fetchImpl: vi.fn(async () => new Response('provider-secret', { status: 401 })) as unknown as typeof fetch,
    }).catch(e => e as Error & { upstreamStatus?: number })
    expect(err.message).toBe('generation_failed')
    expect(err.upstreamStatus).toBe(401)
    expect(JSON.stringify(err)).not.toContain('provider-secret')
  })

  it('tolerates ASR punctuation/whitespace differences but rejects rewritten evidence', () => {
    expect(evidenceInTranscript('银月举起盾牌挡住箭矢。', '银月举起盾牌挡住箭矢')).toBe(true)
    expect(evidenceInTranscript('银月举起盾牌，挡住箭矢', '银月举起盾牌挡住箭矢')).toBe(true)
    expect(evidenceInTranscript('银月举起盾牌挡住箭矢。', '银月用盾挡下了飞来的箭')).toBe(false)
    expect(evidenceInTranscript('银月举起盾牌挡住箭矢。', '')).toBe(false)
  })

  it('resolves an action that names the character instead of echoing the id', async () => {
    const named = { scene: '月色城门', actions: [{ characterName: '【银月】', action: '举盾挡箭', evidence: '银月举起盾牌挡住箭矢。' }] }
    const result = await generateHighlight(parseInput(input), undefined, deps(named))
    expect(result.actions[0]).toMatchObject({ characterId: 'elf', name: '【银月】' })
  })

  it('normalizes object-shaped actions instead of failing as invalid JSON', async () => {
    const mapped = { scene: '月色城门', actions: { '银月': { action: '举盾挡箭', evidence: '银月举起盾牌挡住箭矢。' } } }
    const result = await generateHighlight(parseInput(input), undefined, deps(mapped))
    expect(result.actions[0]).toMatchObject({ characterId: 'elf', name: '【银月】' })
  })

  it('reports the precise invalid_output reason so the failure is actionable', async () => {
    const cases: Array<[unknown, string]> = [
      ['the model wrote prose without JSON', 'json'],
      [{ scene: '月色城门', actions: [] }, 'actions'],
      [{ scene: '', actions: output.actions }, 'scene'],
      [{ scene: '月色城门', actions: [{ ...output.actions[0], characterId: 'ghost' }] }, 'character'],
      [{ scene: '月色城门', actions: [{ ...output.actions[0], action: '' }] }, 'action'],
      [{ scene: '月色城门', actions: [{ ...output.actions[0], evidence: '银月用盾挡下了飞来的箭' }] }, 'evidence'],
    ]
    for (const [value, detail] of cases) {
      const err = await generateHighlight(parseInput(input), undefined, deps(value)).catch(e => e as Error & { detail?: string })
      expect(err.message, JSON.stringify(value)).toBe('invalid_output')
      expect(err.detail, JSON.stringify(value)).toBe(detail)
    }
  })

  it('retries once with a repair instruction and accepts the corrected output', async () => {
    const bad = { scene: '月色城门', actions: [{ ...output.actions[0], evidence: '银月用盾挡下了飞来的箭' }] }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bad) } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))) as unknown as typeof fetch
    const result = await generateHighlight(parseInput(input), undefined, { loadConfig, fetchImpl })
    expect(result.actions[0].evidence).toBe(output.actions[0].evidence)
    expect((fetchImpl as any).mock.calls).toHaveLength(2)
    const repairBody = JSON.parse((fetchImpl as any).mock.calls[1][1].body)
    expect(JSON.stringify(repairBody.messages)).toContain('evidence')
  })

  it('reads Anthropic thinking blocks when the text block is empty', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: JSON.stringify(output) }], stop_reason: 'end_turn',
    }))) as unknown as typeof fetch
    const llmConfig = { apiKey: 'k', baseUrl: 'https://example.invalid/anthropic', model: 'm' }
    const result = await generateHighlight(parseInput({ ...input, llmConfig }), undefined, { loadConfig, fetchImpl })
    expect(result.actions[0].name).toBe('【银月】')
  })

  it('separates gateway failures from a model that returns no JSON', async () => {
    const gateway = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const noJson = await generateHighlight(parseInput(input), undefined, { loadConfig, fetchImpl: gateway }).catch(e => e as Error & { detail?: string })
    expect(noJson.detail).toBe('json')

    const limited = vi.fn(async () => new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'rate limited' } }))) as unknown as typeof fetch
    const provider = await generateHighlight(parseInput(input), undefined, { loadConfig, fetchImpl: limited }).catch(e => e as Error & { detail?: string })
    expect(provider.message).toBe('generation_failed')
    expect(provider.detail).toBe('provider_1004')
  })
})
