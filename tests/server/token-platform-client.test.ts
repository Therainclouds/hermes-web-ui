import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const originalFetch = globalThis.fetch

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  })
}

// Build a response with custom headers but a caller-built body, used to simulate
// the Token Platform server returning a missing or misleading Content-Type
// charset declaration. The body is written as raw UTF-8 bytes regardless of
// the declared charset, mirroring the on-the-wire bytes the production
// service actually sends.
function rawJsonResponse(body: string, headers: Record<string, string>): Response {
  const bytes = new TextEncoder().encode(body)
  return new Response(bytes, {
    status: 200,
    statusText: 'OK',
    headers: new Headers(headers),
  })
}

// Same as rawJsonResponse but lets the caller hand in raw bytes — used to
// simulate servers that emit Chinese strings in GBK (not UTF-8) on the wire.
function rawBytesResponse(bytes: Uint8Array, headers: Record<string, string>): Response {
  return new Response(bytes, {
    status: 200,
    statusText: 'OK',
    headers: new Headers(headers),
  })
}

async function loadClient() {
  vi.resetModules()
  return import('../../packages/server/src/services/token-platform-client')
}

describe('token-platform-client', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterAll(() => {
    process.env = originalEnv
    globalThis.fetch = originalFetch
    vi.resetModules()
  })

  describe('requestDeviceLogin', () => {
    it('posts hardware id and returns the QR params', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
        success: true,
        data: { login_id: 'abc', expires_at: 123, appid: 'wx', state: 'st', redirect_uri: 'https://api.quantclaw.vip/oauth' },
      }))

      const { requestDeviceLogin } = await loadClient()
      const result = await requestDeviceLogin('hw-1', 'Hermes')

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.quantclaw.vip/api/device-login/request',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ hardware_id: 'hw-1', device_name: 'Hermes' }),
        }),
      )
      expect(result.login_id).toBe('abc')
      expect(result.appid).toBe('wx')
    })

    it('throws when the platform reports failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: false, message: '缺少设备标识' }))
      const { requestDeviceLogin } = await loadClient()
      await expect(requestDeviceLogin('', 'Hermes')).rejects.toThrow('缺少设备标识')
    })

    it('honors TOKEN_PLATFORM_BASE_URL override', async () => {
      process.env.TOKEN_PLATFORM_BASE_URL = 'https://dev.quantclaw.vip/'
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { login_id: 'x', appid: 'a', state: 's', redirect_uri: 'r' } }))
      const { requestDeviceLogin } = await loadClient()
      await requestDeviceLogin('hw', 'Hermes')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://dev.quantclaw.vip/api/device-login/request',
        expect.anything(),
      )
    })
  })

  describe('pollDeviceLoginStatus', () => {
    it('returns pending status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { status: 'pending' } }))
      const { pollDeviceLoginStatus } = await loadClient()
      const result = await pollDeviceLoginStatus('abc')
      expect(result.status).toBe('pending')
    })

    it('returns approved payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
        success: true,
        data: {
          status: 'approved',
          device: { device_id: 42, name: '客厅盒' },
          api: { api_base: 'https://api.quantclaw.vip', api_key: 'sk-123', models: ['gpt-4o'] },
        },
      }))
      const { pollDeviceLoginStatus } = await loadClient()
      const result = await pollDeviceLoginStatus('abc')
      expect(result.status).toBe('approved')
      if (result.status === 'approved') {
        expect(result.api.api_key).toBe('sk-123')
      }
    })
  })

  describe('fetchDeviceSelf', () => {
    it('sends the bearer key and returns the profile', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
        success: true,
        data: { id: 7, username: 'wechat_3', display_name: '量迹用户' },
      }))
      const { fetchDeviceSelf } = await loadClient()
      const profile = await fetchDeviceSelf('https://api.quantclaw.vip/', 'sk-123')
      expect(profile.id).toBe(7)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.quantclaw.vip/api/device/self',
        expect.objectContaining({ headers: { Authorization: 'Bearer sk-123' } }),
      )
    })

    it('throws on non-success envelope', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: false, message: '密钥无效' }))
      const { fetchDeviceSelf } = await loadClient()
      await expect(fetchDeviceSelf('https://api.quantclaw.vip', 'bad')).rejects.toThrow('密钥无效')
    })

    // Regression: the platform server sometimes omits the charset in
    // Content-Type. Node's `Response.text()` still falls back to UTF-8 in that
    // case, but the historical implementation relied on header-based decoding
    // and broke whenever the header was wrong (e.g. `charset=gbk`). The client
    // must decode display_name as UTF-8 regardless of the header.
    it('decodes UTF-8 display_name even when Content-Type omits charset', async () => {
      const body = JSON.stringify({ success: true, data: { id: 9, username: 'wx_9', display_name: '量迹用户' } })
      globalThis.fetch = vi.fn().mockResolvedValue(rawJsonResponse(body, { 'Content-Type': 'application/json' }))
      const { fetchDeviceSelf } = await loadClient()
      const profile = await fetchDeviceSelf('https://api.quantclaw.vip', 'sk')
      expect(profile.display_name).toBe('量迹用户')
    })

    it('decodes UTF-8 display_name even when Content-Type declares a wrong charset', async () => {
      const body = JSON.stringify({ success: true, data: { id: 10, username: 'wx_10', display_name: '张三的Hermes' } })
      globalThis.fetch = vi.fn().mockResolvedValue(rawJsonResponse(body, { 'Content-Type': 'application/json; charset=gbk' }))
      const { fetchDeviceSelf } = await loadClient()
      const profile = await fetchDeviceSelf('https://api.quantclaw.vip', 'sk')
      expect(profile.display_name).toBe('张三的Hermes')
    })

    // Legacy server path: some OneAPI-derived deployments emit JSON whose
    // Chinese strings are encoded as GBK on the wire with no useful
    // Content-Type charset hint. Strict UTF-8 fails on those bytes, so the
    // client must transparently fall back to GBK to recover display_name.
    // Regression: the Token Platform has a server-side encoding bug where
    // UTF-8 bytes of Chinese nicknames are read as Latin1 characters and
    // then re-encoded as UTF-8 — producing "double-UTF-8" mojibake on the
    // wire. The JSON parses successfully (the bytes are valid UTF-8) but
    // the string contains Latin1-high codepoints (U+0080..U+00FF) instead
    // of real CJK characters. The client must detect and reverse this
    // transparently.
    it('reverses double-UTF-8 mojibake in display_name from the upstream server', async () => {
      const real = '白云雨幕'
      // Build the mojibake: encode as UTF-8, read back as Latin1 chars,
      // producing a string whose codepoints all fit in 0x00..0xFF but
      // whose UTF-8 representation is the double-encoded byte sequence.
      const mojibake = Buffer.from(real, 'utf-8').toString('latin1')
      // Confirm this is what we expect — the mojibake looks like Latin1
      // high characters on the wire.
      expect(mojibake).not.toBe(real)
      for (const ch of mojibake) expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0xFF)

      const body = JSON.stringify({
        success: true,
        data: { id: 17, username: 'wechat_17', display_name: mojibake },
      })
      globalThis.fetch = vi.fn().mockResolvedValue(rawJsonResponse(body, { 'Content-Type': 'application/json; charset=utf-8' }))
      const { fetchDeviceSelf } = await loadClient()
      const profile = await fetchDeviceSelf('https://api.quantclaw.vip', 'sk')
      expect(profile.display_name).toBe('白云雨幕')
    })

    it('decodes GBK-encoded display_name on the wire', async () => {
      // Build the body as ASCII framing + a few non-UTF8 bytes that mimic a
      // real GBK Chinese nickname on the wire. We don't need the bytes to
      // decode to the exact original characters in the test — the goal is to
      // prove the fallback path doesn't throw and still produces a usable
      // envelope. vitest's jsdom layer does not always expose Node's Buffer
      // encoding helpers, so we construct the bytes by hand.
      const asciiPrefix = '{"success":true,"data":{"id":11,"username":"wx_11","display_name":"'
      const asciiSuffix = '"}}'
      // 量迹用户 encoded in GBK (verified on Node 24 with TextDecoder('gbk')):
//   量=c1bf 迹=bca3 用=d3c3 户=bba7
      const gbkHex = 'c1bfbca3d3c3bba7'
      const gbkName = new Uint8Array(gbkHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)))
      const bodyBytes = new Uint8Array(asciiPrefix.length + gbkName.length + asciiSuffix.length)
      bodyBytes.set(new TextEncoder().encode(asciiPrefix), 0)
      bodyBytes.set(gbkName, asciiPrefix.length)
      bodyBytes.set(new TextEncoder().encode(asciiSuffix), asciiPrefix.length + gbkName.length)
      // Confirm strict UTF-8 actually fails on these bytes — otherwise the
      // test wouldn't exercise the GBK fallback path.
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)).toThrow()

      globalThis.fetch = vi.fn().mockResolvedValue(rawBytesResponse(bodyBytes, { 'Content-Type': 'application/json' }))
      const { fetchDeviceSelf } = await loadClient()
      const profile = await fetchDeviceSelf('https://api.quantclaw.vip', 'sk')
      // The fallback must not throw, must keep the ASCII-framed fields intact
      // (id, username), and must recover the GBK-encoded nickname back into a
      // human-readable Chinese string.
      expect(profile.id).toBe(11)
      expect(profile.username).toBe('wx_11')
      expect(profile.display_name).toBe('量迹用户')
    })
  })

  describe('verifyDeviceApiKey', () => {
    it('extracts model ids from the relay models endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
        success: true,
        data: { data: [{ id: 'gpt-4o' }, { id: 'claude-3-5' }, {}] },
      }))
      const { verifyDeviceApiKey } = await loadClient()
      const models = await verifyDeviceApiKey('https://api.quantclaw.vip', 'sk-123')
      expect(models).toEqual(['gpt-4o', 'claude-3-5'])
    })
  })
})
