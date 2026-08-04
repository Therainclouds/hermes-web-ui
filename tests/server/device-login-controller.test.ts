import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchDeviceSelfMock, verifyDeviceApiKeyMock, saveDeviceBindingMock } = vi.hoisted(() => ({
  fetchDeviceSelfMock: vi.fn(),
  verifyDeviceApiKeyMock: vi.fn(),
  saveDeviceBindingMock: vi.fn(),
}))

vi.mock('../../packages/server/src/services/token-platform-client', () => ({
  fetchDeviceSelf: fetchDeviceSelfMock,
  verifyDeviceApiKey: verifyDeviceApiKeyMock,
}))
vi.mock('../../packages/server/src/services/device-binding', () => ({
  saveDeviceBinding: saveDeviceBindingMock,
  clearDeviceBinding: vi.fn(async () => undefined),
  loadDeviceBinding: vi.fn(async () => null),
  getOrCreateHardwareId: vi.fn(async () => 'uuid'),
  getHardwareId: vi.fn(async () => 'uuid'),
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('deviceLogin controller', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')

    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))

    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
  })

  async function loadModules() {
    return {
      ctrl: await import('../../packages/server/src/controllers/auth'),
      users: await import('../../packages/server/src/db/hermes/users-store'),
    }
  }

  function makeCtx(body: Record<string, unknown>) {
    return {
      request: { body },
      headers: {},
      query: {},
      ip: '127.0.0.1',
      status: 200,
      body: null,
      get: vi.fn(() => ''),
      req: { socket: { remoteAddress: '127.0.0.1' } },
    } as any
  }

  it('rejects when api_base or api_key are missing', async () => {
    const { ctrl } = await loadModules()
    const ctx = makeCtx({ api_base: 'https://api.quantclaw.vip' })
    await ctrl.deviceLogin(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'api_base and api_key are required' })
    expect(fetchDeviceSelfMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid device key', async () => {
    fetchDeviceSelfMock.mockRejectedValue(new Error('密钥无效'))
    const { ctrl } = await loadModules()
    const ctx = makeCtx({ api_base: 'https://api.quantclaw.vip', api_key: 'sk-bad' })
    await ctrl.deviceLogin(ctx)
    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ error: '密钥无效' })
  })

  it('auto-bootstraps a super_admin on first run and issues a JWT', async () => {
    fetchDeviceSelfMock.mockResolvedValue({ id: 7, username: 'wechat_3', display_name: '量迹用户' })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o'])
    saveDeviceBindingMock.mockResolvedValue(undefined)

    const { ctrl, users } = await loadModules()
    expect(users.countUsers()).toBe(0)

    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good',
      device_id: 42,
      device_name: 'Hermes',
      models: ['gpt-4o'],
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.token).toBeTruthy()
    expect(ctx.body.user.username).toBe('tp_7')
    expect(ctx.body.user.role).toBe('super_admin')
    expect(ctx.body.binding.display_name).toBe('量迹用户')

    const created = users.findUserByUsername('tp_7')
    expect(created).not.toBeNull()
    expect(created!.role).toBe('super_admin')
    expect(saveDeviceBindingMock).toHaveBeenCalledWith(expect.objectContaining({
      device_id: '42',
      api_key: 'sk-good',
      models: ['gpt-4o'],
      display_name: '量迹用户',
    }))
  })

  it('links a regular admin when the device already has local users', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    expect(users.countUsers()).toBe(1)

    fetchDeviceSelfMock.mockResolvedValue({ id: 8, username: 'wechat_8', display_name: '新用户' })
    verifyDeviceApiKeyMock.mockResolvedValue(['claude-3-5-sonnet'])

    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-2',
      device_id: 43,
      models: ['claude-3-5-sonnet'],
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.user.role).toBe('admin')
    const created = users.findUserByUsername('tp_8')
    expect(created).not.toBeNull()
    expect(created!.role).toBe('admin')
  })

  it('reuses an existing local user bound to the same Token Platform id', async () => {
    const { ctrl, users } = await loadModules()
    users.createUser({ username: 'tp_9', password: 'x', role: 'super_admin' })
    expect(users.countUsers()).toBe(1)

    fetchDeviceSelfMock.mockResolvedValue({ id: 9, username: 'wechat_9', display_name: '老用户' })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o'])

    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-3',
      device_id: 44,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.user.username).toBe('tp_9')
    expect(ctx.body.user.role).toBe('super_admin')
    expect(users.countUsers()).toBe(1)
  })

  it('falls back to the relay-verified models when the client omits models', async () => {
    fetchDeviceSelfMock.mockResolvedValue({ id: 10, username: 'wechat_10' })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o', 'gpt-4o-mini'])

    const { ctrl } = await loadModules()
    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-4',
      device_id: 45,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(saveDeviceBindingMock).toHaveBeenCalledWith(expect.objectContaining({
      models: ['gpt-4o', 'gpt-4o-mini'],
    }))
  })
})
