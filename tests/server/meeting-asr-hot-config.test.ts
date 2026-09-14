import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeetingASRService } from '../../packages/server/src/services/meeting-asr'

/**
 * The whole-file transcription dialog lets the user pick either ASR engine per
 * action, independent of the session's provider. A running backend therefore
 * has to receive *both* credentials — MiniMax included when the session was
 * created on DashScope — so the hot config push must forward the MiniMax
 * fields, not only the DashScope ones.
 */
describe('MeetingASRService.updateConfig', () => {
  const svc = MeetingASRService.getInstance() as any
  const prevRunning = svc._isRunning
  const prevPort = svc._asrPort

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    svc._isRunning = prevRunning
    svc._asrPort = prevPort
  })

  it('forwards MiniMax credentials alongside the DashScope key', async () => {
    svc._isRunning = true
    svc._asrPort = 65535 // never contacted: fetch is stubbed
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, statusText: 'OK' })
    vi.stubGlobal('fetch', fetchMock)

    await svc.updateConfig({
      dashscopeApiKey: 'sk-dashscope',
      minimaxApiKey: 'mm-secret',
      minimaxAsrModel: 'asr-1.0',
      minimaxBaseUrl: 'https://api.minimaxi.com',
    } as any)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/config')
    const body = JSON.parse(String(init.body))
    expect(body.asr.dashscope_api_key).toBe('sk-dashscope')
    expect(body.asr.minimax_api_key).toBe('mm-secret')
    expect(body.asr.minimax_asr_model).toBe('asr-1.0')
    expect(body.asr.minimax_base_url).toBe('https://api.minimaxi.com')
  })

  it('leaves the MiniMax fields undefined when no key is available', async () => {
    svc._isRunning = true
    svc._asrPort = 65535
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, statusText: 'OK' })
    vi.stubGlobal('fetch', fetchMock)

    await svc.updateConfig({ dashscopeApiKey: 'sk-dashscope' } as any)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    // JSON.stringify drops undefined → the Python side keeps the previous value
    expect(body.asr.minimax_api_key).toBeUndefined()
  })

  it('refuses to push config while the service is stopped', async () => {
    svc._isRunning = false
    await expect(svc.updateConfig({ minimaxApiKey: 'mm' } as any)).rejects.toThrow(/not running/i)
  })
})

/**
 * A rebuild replaces `python-backend/` on disk but a long-lived uvicorn child
 * keeps the modules it imported at spawn. That is why an already-fixed bug can
 * keep reproducing after a page refresh. The service therefore hashes the
 * sources and respawns when they changed.
 */
describe('MeetingASRService backend staleness detection', () => {
  const svc = MeetingASRService.getInstance() as any
  const prevHash = svc._backendCodeHash

  afterEach(() => {
    svc._backendCodeHash = prevHash
  })

  it('produces a stable 16-char hash of the bundled sources', () => {
    const first = svc.computeBackendCodeHash()
    const second = svc.computeBackendCodeHash()
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(second).toBe(first)
  })

  it('treats an unknown hash as not stale (nothing to compare against)', () => {
    svc._backendCodeHash = null
    expect(svc.isBackendCodeStale()).toBe(false)
  })

  it('is not stale when the running child matches the sources on disk', () => {
    svc._backendCodeHash = svc.computeBackendCodeHash()
    expect(svc.isBackendCodeStale()).toBe(false)
  })

  it('is stale when the sources on disk changed since the child was spawned', () => {
    svc._backendCodeHash = 'deadbeefdeadbeef'
    expect(svc.isBackendCodeStale()).toBe(true)
  })

  it('exposes the code hash on the public status payload', () => {
    svc._backendCodeHash = 'abc123abc123abc1'
    expect(svc.status.codeHash).toBe('abc123abc123abc1')
  })
})
