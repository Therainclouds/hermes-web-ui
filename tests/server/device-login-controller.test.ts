import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USERNAME, DEFAULT_PASSWORD } from '../../packages/server/src/db/hermes/users-store'

const { fetchDeviceSelfMock, verifyDeviceApiKeyMock, saveDeviceBindingMock, loadDeviceBindingMock } = vi.hoisted(() => ({
  fetchDeviceSelfMock: vi.fn(),
  verifyDeviceApiKeyMock: vi.fn(),
  saveDeviceBindingMock: vi.fn(),
  loadDeviceBindingMock: vi.fn(async () => null),
}))

vi.mock('../../packages/server/src/services/token-platform-client', () => ({
  fetchDeviceSelf: fetchDeviceSelfMock,
  verifyDeviceApiKey: verifyDeviceApiKeyMock,
}))
vi.mock('../../packages/server/src/services/device-binding', () => ({
  saveDeviceBinding: saveDeviceBindingMock,
  clearDeviceBinding: vi.fn(async () => undefined),
  loadDeviceBinding: loadDeviceBindingMock,
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
    // Default: the device has no persisted WeChat binding. Tests that exercise
    // the "already bound owner" rejection override this inside the test body.
    loadDeviceBindingMock.mockResolvedValue(null)

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

  it('makes the first scanning WeChat the owner even when local users already exist', async () => {
    // A freshly deployed device may already have local accounts (e.g. a
    // bootstrap super admin) while having no WeChat binding at all. The first
    // scanning WeChat must still become the owner (super_admin).
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    expect(users.countUsers()).toBe(1)
    loadDeviceBindingMock.mockResolvedValue(null) // no WeChat binding on this device

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
    expect(ctx.body.user.username).toBe('tp_8')
    expect(ctx.body.user.role).toBe('super_admin')
  })

  it('rejects a second WeChat account when the device already has a bound owner', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    expect(users.countUsers()).toBe(1)
    // The device already owns a WeChat binding for a different account.
    loadDeviceBindingMock.mockResolvedValue({
      device_id: '43',
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-owner',
      models: ['gpt-4o'],
      display_name: '老用户',
      username: 'wechat_8',
      bound_at: Date.now(),
    })

    fetchDeviceSelfMock.mockResolvedValue({ id: 9, username: 'wechat_9', display_name: '新用户' })
    verifyDeviceApiKeyMock.mockResolvedValue(['claude-3-5-sonnet'])

    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-2',
      device_id: 44,
      models: ['claude-3-5-sonnet'],
    })
    await ctrl.deviceLogin(ctx)

    // Single-machine, single-owner: a WeChat account that is not the bound
    // owner must NOT be auto-provisioned (it would overwrite the default
    // profile the owner set).
    expect(ctx.status).toBe(403)
    expect(ctx.body.code).toBe('DEVICE_ALREADY_BOUND')
    expect(ctx.body.owner).toBeTruthy()
    expect(users.findUserByUsername('tp_9')).toBeNull()
  })

  it('grants the default profile to an existing admin that has no profile bindings', async () => {
    const { ctrl, users } = await loadModules()
    users.createUser({ username: 'tp_8', password: 'x', role: 'admin' })
    expect(users.listUserProfiles(users.findUserByUsername('tp_8')!.id)).toHaveLength(0)

    fetchDeviceSelfMock.mockResolvedValue({ id: 8, username: 'wechat_8', display_name: '新用户' })
    verifyDeviceApiKeyMock.mockResolvedValue(['claude-3-5-sonnet'])

    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-2',
      device_id: 43,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    const created = users.findUserByUsername('tp_8')
    const boundProfiles = users.listUserProfiles(created!.id).map(p => p.profile_name)
    expect(boundProfiles).toContain('default')
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

  it('syncs the WeChat avatar url and display name onto the local user', async () => {
    fetchDeviceSelfMock.mockResolvedValue({
      id: 11,
      username: 'wechat_11',
      display_name: '微信用户甲',
      avatar_url: 'https://thirdwx.qlogo.cn/mmopen/xxx',
    })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o'])

    const { ctrl, users } = await loadModules()
    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-5',
      device_id: 46,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    const created = users.findUserByUsername('tp_11')
    expect(created).not.toBeNull()
    const avatar = JSON.parse(users.getUserAvatar(created!.id))
    expect(avatar.type).toBe('image')
    expect(avatar.dataUrl).toBe('https://thirdwx.qlogo.cn/mmopen/xxx')
  })

  it('falls back to a seeded multiavatar when no avatar url is present', async () => {
    fetchDeviceSelfMock.mockResolvedValue({ id: 12, username: 'wechat_12', display_name: '微信用户乙' })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o'])

    const { ctrl, users } = await loadModules()
    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-6',
      device_id: 47,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    const created = users.findUserByUsername('tp_12')
    expect(created).not.toBeNull()
    const avatar = JSON.parse(users.getUserAvatar(created!.id))
    expect(avatar.type).toBe('default')
    expect(avatar.seed).toBe('微信用户乙')
  })

  describe('bindSuperAdmin', () => {
    function makeAuthedCtx(body: Record<string, unknown>, user: { id: number; username: string; role: string }) {
      const ctx = makeCtx(body) as any
      ctx.state = { user }
      return ctx
    }

    it('upgrades the current admin to super_admin with valid credentials', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_20', password: 'x', role: 'admin' })
      expect(admin!.role).toBe('admin')

      const ctx = makeAuthedCtx(
        { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD },
        { id: admin!.id, username: 'tp_20', role: 'admin' },
      )
      await ctrl.bindSuperAdmin(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.token).toBeTruthy()
      expect(ctx.body.user.role).toBe('super_admin')
      expect(users.findUserById(admin!.id)!.role).toBe('super_admin')
    })

    it('rejects wrong super administrator password and keeps the user as admin', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_21', password: 'x', role: 'admin' })

      const ctx = makeAuthedCtx(
        { username: DEFAULT_USERNAME, password: 'wrong-password' },
        { id: admin!.id, username: 'tp_21', role: 'admin' },
      )
      await ctrl.bindSuperAdmin(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Invalid super administrator credentials' })
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('rejects when the provided account is not a super administrator', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_22', password: 'x', role: 'admin' })
      users.createUser({ username: 'regular', password: 'y', role: 'admin' })

      const ctx = makeAuthedCtx(
        { username: 'regular', password: 'y' },
        { id: admin!.id, username: 'tp_22', role: 'admin' },
      )
      await ctrl.bindSuperAdmin(ctx)

      expect(ctx.status).toBe(401)
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('rejects when credentials are missing', async () => {
      const { ctrl, users } = await loadModules()
      const admin = users.createUser({ username: 'tp_23', password: 'x', role: 'admin' })

      const ctx = makeAuthedCtx({}, { id: admin!.id, username: 'tp_23', role: 'admin' })
      await ctrl.bindSuperAdmin(ctx)

      expect(ctx.status).toBe(400)
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('requires an authenticated user', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeCtx({ username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD }) as any
      ctx.state = { user: null }
      await ctrl.bindSuperAdmin(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('unbindSuperAdmin', () => {
    function makeAuthedCtx(user: { id: number; username: string; role: string }) {
      const ctx = makeCtx({}) as any
      ctx.state = { user }
      return ctx
    }

    it('demotes the current super_admin to admin and re-issues a token', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      // A second super admin exists so the first one can be safely demoted.
      const admin = users.createUser({ username: 'tp_30', password: 'x', role: 'admin' })
      users.updateUser({ userId: admin!.id, role: 'super_admin' })

      const ctx = makeAuthedCtx({ id: admin!.id, username: 'tp_30', role: 'super_admin' })
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.token).toBeTruthy()
      expect(ctx.body.user.role).toBe('admin')
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('rejects when the current user is not a super_admin', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_31', password: 'x', role: 'admin' })

      const ctx = makeAuthedCtx({ id: admin!.id, username: 'tp_31', role: 'admin' })
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Only a super administrator can unbind' })
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('rejects when it would leave no active super administrator', async () => {
      const { ctrl, users } = await loadModules()
      const admin = users.createUser({ username: 'tp_32', password: 'x', role: 'super_admin' })

      const ctx = makeAuthedCtx({ id: admin!.id, username: 'tp_32', role: 'super_admin' })
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'At least one active super administrator is required' })
      expect(users.findUserById(admin!.id)!.role).toBe('super_admin')
    })

    it('requires an authenticated user', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeCtx({}) as any
      ctx.state = { user: null }
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('setPassword', () => {
    function makeAuthedCtx(body: Record<string, unknown>, user: { id: number; username: string; role: string }) {
      const ctx = makeCtx(body) as any
      ctx.state = { user }
      return ctx
    }

    it('sets the password for the current user without requiring the current password', async () => {
      const { ctrl, users } = await loadModules()
      const user = users.createUser({ username: 'tp_40', password: 'old-pass', role: 'admin' })

      const ctx = makeAuthedCtx({ newPassword: 'brand-new-pass' }, { id: user!.id, username: 'tp_40', role: 'admin' })
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
      expect(users.verifyPassword('brand-new-pass', users.findUserById(user!.id)!.password_hash)).toBe(true)
      expect(users.verifyPassword('old-pass', users.findUserById(user!.id)!.password_hash)).toBe(false)
    })

    it('rejects a password shorter than 6 characters', async () => {
      const { ctrl, users } = await loadModules()
      const user = users.createUser({ username: 'tp_41', password: 'old-pass', role: 'admin' })

      const ctx = makeAuthedCtx({ newPassword: '123' }, { id: user!.id, username: 'tp_41', role: 'admin' })
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'New password must be at least 6 characters' })
    })

    it('requires a new password', async () => {
      const { ctrl, users } = await loadModules()
      const user = users.createUser({ username: 'tp_42', password: 'old-pass', role: 'admin' })

      const ctx = makeAuthedCtx({}, { id: user!.id, username: 'tp_42', role: 'admin' })
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'New password is required' })
    })

    it('requires an authenticated user', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeCtx({ newPassword: 'brand-new-pass' }) as any
      ctx.state = { user: null }
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('exportManagedUser', () => {
    it('exports a single user as JSON without the password hash', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_50', password: 'x', role: 'admin', profiles: ['default'] })

      const ctx = makeCtx({}) as any
      ctx.params = { id: String(admin!.id) }
      ctx.state = { user: { id: 1, username: DEFAULT_USERNAME, role: 'super_admin' } }
      await ctrl.exportManagedUser(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.user.username).toBe('tp_50')
      expect(ctx.body.user.role).toBe('admin')
      expect(ctx.body.user.profiles).toContain('default')
      expect(ctx.body.user.password_hash).toBeUndefined()
    })

    it('returns 404 for an unknown user', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeCtx({}) as any
      ctx.params = { id: '99999' }
      ctx.state = { user: { id: 1, username: DEFAULT_USERNAME, role: 'super_admin' } }
      await ctrl.exportManagedUser(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'User not found' })
    })
  })
})
