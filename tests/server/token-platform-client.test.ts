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
