import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USERNAME } from '../../packages/server/src/db/hermes/users-store'

const {
  fetchDeviceSelfMock,
  verifyDeviceApiKeyMock,
  ensurePersonalWorkspaceMock,
  applyTokenPlatformProviderMock,
  deleteProfileFromDiskMock,
  clearProfileIdentityMock,
} = vi.hoisted(() => ({
  fetchDeviceSelfMock: vi.fn(),
  verifyDeviceApiKeyMock: vi.fn(),
  ensurePersonalWorkspaceMock: vi.fn(async () => null),
  applyTokenPlatformProviderMock: vi.fn(async () => true),
  deleteProfileFromDiskMock: vi.fn(async () => true),
  clearProfileIdentityMock: vi.fn(),
}))

vi.mock('../../packages/server/src/services/token-platform-client', () => ({
  fetchDeviceSelf: fetchDeviceSelfMock,
  verifyDeviceApiKey: verifyDeviceApiKeyMock,
}))
vi.mock('../../packages/server/src/services/hermes/wechat-user-provisioning', () => ({
  ensurePersonalWorkspace: ensurePersonalWorkspaceMock,
  applyTokenPlatformProvider: applyTokenPlatformProviderMock,
  deleteProfileFromDisk: deleteProfileFromDiskMock,
  personalProfileNameFor: (platformProfileId: number) => `u_${platformProfileId}`,
}))
vi.mock('../../packages/server/src/services/hermes/profile-metadata', () => ({
  setProfileDisplayName: vi.fn(),
  setProfileAvatarRemote: vi.fn(),
  setProfileAvatarGenerated: vi.fn(),
  clearProfileIdentity: clearProfileIdentityMock,
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
    ensurePersonalWorkspaceMock.mockImplementation(async (input: { platformProfileId: number }) => `u_${input.platformProfileId}`)

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
      bindings: await import('../../packages/server/src/db/hermes/wechat-bindings-store'),
    }
  }

  function makeCtx(body: Record<string, unknown>, query: Record<string, string> = {}) {
    return {
      request: { body },
      headers: {},
      query,
      ip: '127.0.0.1',
      status: 200,
      body: null,
      get: vi.fn(() => ''),
      req: { socket: { remoteAddress: '127.0.0.1' } },
    } as any
  }

  function makeAuthedCtx(body: Record<string, unknown>, user: { id: number; username: string; role: string } | null, query: Record<string, string> = {}) {
    const ctx = makeCtx(body, query) as any
    ctx.state = { user }
    return ctx
  }

  function scanCtx(platformId: number, apiKey: string, models: string[], displayName: string) {
    fetchDeviceSelfMock.mockResolvedValue({ id: platformId, username: `wechat_${platformId}`, display_name: displayName })
    verifyDeviceApiKeyMock.mockResolvedValue(models)
    return makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: apiKey,
      device_id: 100 + platformId,
      models,
    })
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

  it('provisions a regular user with a personal agent profile on first scan', async () => {
    const { ctrl, users, bindings } = await loadModules()

    const ctx = scanCtx(7, 'sk-good', ['gpt-4o'], '量迹用户')
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.token).toBeTruthy()
    expect(ctx.body.user.username).toBe('tp_7')
    expect(ctx.body.user.role).toBe('admin')
    expect(ctx.body.binding.display_name).toBe('量迹用户')
    expect(ctx.body.binding.platform_profile_id).toBe(7)

    const created = users.findUserByUsername('tp_7')
    expect(created).not.toBeNull()
    expect(created!.role).toBe('admin')
    // The personal profile is bound to the user and isolated from `default`.
    expect(users.listUserProfiles(created!.id).map(p => p.profile_name)).toEqual(['u_7'])
    // The per-user api_key is written into the personal profile's provider.
    expect(ensurePersonalWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      platformProfileId: 7,
      displayName: '量迹用户',
      apiBase: 'https://api.quantclaw.vip',
      apiKey: 'sk-good',
      models: ['gpt-4o'],
    }))
    // The binding row is persisted per WeChat account.
    const binding = bindings.findBindingByPlatformId(7)
    expect(binding?.api_key).toBe('sk-good')
    expect(binding?.user_id).toBe(created!.id)
  })

  it('lets multiple different WeChat accounts bind to the same device', async () => {
    const { ctrl, users, bindings } = await loadModules()
    users.createDefaultSuperAdmin()

    await ctrl.deviceLogin(scanCtx(8, 'sk-a', ['gpt-4o'], '用户甲'))
    await ctrl.deviceLogin(scanCtx(9, 'sk-b', ['claude-3-5-sonnet'], '用户乙'))

    expect(users.findUserByUsername('tp_8')!.role).toBe('admin')
    expect(users.findUserByUsername('tp_9')!.role).toBe('admin')
    expect(bindings.countWeChatBindings()).toBe(2)
    expect(bindings.findBindingByPlatformId(8)?.api_key).toBe('sk-a')
    expect(bindings.findBindingByPlatformId(9)?.api_key).toBe('sk-b')
    // Each user only sees their own personal profile.
    expect(users.listUserProfiles(users.findUserByUsername('tp_8')!.id).map(p => p.profile_name)).toEqual(['u_8'])
    expect(users.listUserProfiles(users.findUserByUsername('tp_9')!.id).map(p => p.profile_name)).toEqual(['u_9'])
  })

  it('reuses an existing local user bound to the same Token Platform id', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    users.createUser({ username: 'tp_9', password: 'x', role: 'admin' })
    expect(users.countUsers()).toBe(2)

    const ctx = scanCtx(9, 'sk-good-3', ['gpt-4o'], '老用户')
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.user.username).toBe('tp_9')
    expect(users.countUsers()).toBe(2)
  })

  it('keeps super admin exclusive to the built-in account (no WeChat promotion)', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    expect(users.countUsers()).toBe(1)

    const ctx = scanCtx(10, 'sk-good-4', ['gpt-4o'], '新用户')
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.user.role).toBe('admin')
    // Only the built-in super admin remains a super_admin.
    expect(users.listUsers().filter((u: any) => u.role === 'super_admin')).toHaveLength(1)
    expect(users.listUsers().find((u: any) => u.role === 'super_admin')!.username).toBe(DEFAULT_USERNAME)
  })

  it('still succeeds when personal profile provisioning fails', async () => {
    ensurePersonalWorkspaceMock.mockResolvedValue(null)
    const { ctrl, users } = await loadModules()

    const ctx = scanCtx(11, 'sk-good-5', ['gpt-4o'], '新用户')
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.token).toBeTruthy()
    const created = users.findUserByUsername('tp_11')
    expect(created).not.toBeNull()
    expect(users.listUserProfiles(created!.id)).toHaveLength(0)
  })

  it('falls back to the relay-verified models when the client omits models', async () => {
    fetchDeviceSelfMock.mockResolvedValue({ id: 12, username: 'wechat_12' })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o', 'gpt-4o-mini'])

    const { ctrl, bindings } = await loadModules()
    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-6',
      device_id: 45,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    expect(bindings.findBindingByPlatformId(12)?.models_json).toBe(JSON.stringify(['gpt-4o', 'gpt-4o-mini']))
    expect(ensurePersonalWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      platformProfileId: 12,
      models: ['gpt-4o', 'gpt-4o-mini'],
    }))
  })

  it('syncs the WeChat avatar url and display name onto the local user', async () => {
    fetchDeviceSelfMock.mockResolvedValue({
      id: 13,
      username: 'wechat_13',
      display_name: '微信用户甲',
      avatar_url: 'https://thirdwx.qlogo.cn/mmopen/xxx',
    })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o'])

    const { ctrl, users } = await loadModules()
    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-7',
      device_id: 46,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    const created = users.findUserByUsername('tp_13')
    expect(created).not.toBeNull()
    const avatar = JSON.parse(users.getUserAvatar(created!.id))
    expect(avatar.type).toBe('image')
    expect(avatar.dataUrl).toBe('https://thirdwx.qlogo.cn/mmopen/xxx')
  })

  it('falls back to a seeded multiavatar when no avatar url is present', async () => {
    fetchDeviceSelfMock.mockResolvedValue({ id: 14, username: 'wechat_14', display_name: '微信用户乙' })
    verifyDeviceApiKeyMock.mockResolvedValue(['gpt-4o'])

    const { ctrl, users } = await loadModules()
    const ctx = makeCtx({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-good-8',
      device_id: 47,
    })
    await ctrl.deviceLogin(ctx)

    expect(ctx.status).toBe(200)
    const created = users.findUserByUsername('tp_14')
    expect(created).not.toBeNull()
    const avatar = JSON.parse(users.getUserAvatar(created!.id))
    expect(avatar.type).toBe('default')
    expect(avatar.seed).toBe('微信用户乙')
  })

  describe('getDeviceBinding + restoreDeviceLogin (multi-account)', () => {
    it('returns the bound account list without api keys', async () => {
      const { ctrl, bindings } = await loadModules()
      bindings.upsertBindingByPlatformId({
        userId: null,
        platformProfileId: 20,
        platformUsername: 'wechat_20',
        apiBase: 'https://api.quantclaw.vip',
        apiKey: 'sk-20',
        models: ['gpt-4o'],
        displayName: '账号二十',
      })

      const ctx = makeCtx({})
      await ctrl.getDeviceBinding(ctx)

      expect(ctx.body).toEqual({
        bound: true,
        accounts: [{
          platform_profile_id: 20,
          display_name: '账号二十',
          username: 'wechat_20',
          bound_at: expect.any(Number),
        }],
      })
      expect(JSON.stringify(ctx.body)).not.toContain('sk-20')
    })

    it('restores the single bound account without an explicit id', async () => {
      const { ctrl, users, bindings } = await loadModules()
      const user = users.createUser({ username: 'tp_21', password: 'x', role: 'admin' })
      bindings.upsertBindingByPlatformId({
        userId: user!.id,
        platformProfileId: 21,
        platformUsername: 'wechat_21',
        apiBase: 'https://api.quantclaw.vip',
        apiKey: 'sk-21',
        models: ['gpt-4o'],
        displayName: '账号廿一',
      })
      fetchDeviceSelfMock.mockResolvedValue({ id: 21, username: 'wechat_21', display_name: '账号廿一' })

      const ctx = makeCtx({})
      await ctrl.restoreDeviceLogin(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.token).toBeTruthy()
      expect(ctx.body.user.username).toBe('tp_21')
      // Restore provisions the personal workspace with the stored api_key.
      expect(ensurePersonalWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({
        platformProfileId: 21,
        apiKey: 'sk-21',
      }))
    })

    it('asks which account to restore when several are bound', async () => {
      const { ctrl, users, bindings } = await loadModules()
      const first = users.createUser({ username: 'tp_22', password: 'x', role: 'admin' })
      const second = users.createUser({ username: 'tp_23', password: 'x', role: 'admin' })
      bindings.upsertBindingByPlatformId({
        userId: first!.id, platformProfileId: 22, platformUsername: 'wechat_22',
        apiBase: 'https://api.quantclaw.vip', apiKey: 'sk-22', models: [], displayName: '甲',
      })
      bindings.upsertBindingByPlatformId({
        userId: second!.id, platformProfileId: 23, platformUsername: 'wechat_23',
        apiBase: 'https://api.quantclaw.vip', apiKey: 'sk-23', models: [], displayName: '乙',
      })

      const ctx = makeCtx({})
      await ctrl.restoreDeviceLogin(ctx)

      expect(ctx.status).toBe(409)
      expect(ctx.body.code).toBe('MULTIPLE_BINDINGS')
      expect(ctx.body.accounts.map((a: any) => a.platform_profile_id)).toEqual([22, 23])
      expect(fetchDeviceSelfMock).not.toHaveBeenCalled()
    })

    it('restores a specific account when platform_profile_id is provided', async () => {
      const { ctrl, users, bindings } = await loadModules()
      const first = users.createUser({ username: 'tp_24', password: 'x', role: 'admin' })
      const second = users.createUser({ username: 'tp_25', password: 'x', role: 'admin' })
      bindings.upsertBindingByPlatformId({
        userId: first!.id, platformProfileId: 24, platformUsername: 'wechat_24',
        apiBase: 'https://api.quantclaw.vip', apiKey: 'sk-24', models: [], displayName: '甲',
      })
      bindings.upsertBindingByPlatformId({
        userId: second!.id, platformProfileId: 25, platformUsername: 'wechat_25',
        apiBase: 'https://api.quantclaw.vip', apiKey: 'sk-25', models: [], displayName: '乙',
      })
      fetchDeviceSelfMock.mockResolvedValue({ id: 25, username: 'wechat_25', display_name: '乙' })

      const ctx = makeCtx({ platform_profile_id: 25 })
      await ctrl.restoreDeviceLogin(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.user.username).toBe('tp_25')
    })

    it('returns 404 when nothing is bound', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeCtx({})
      await ctrl.restoreDeviceLogin(ctx)
      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'No device binding found' })
    })
  })

  describe('bindSuperAdmin', () => {
    it('is rejected: super admin stays exclusive to the built-in account', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_30', password: 'x', role: 'admin' })

      const ctx = makeAuthedCtx({ username: DEFAULT_USERNAME, password: 'whatever' }, { id: admin!.id, username: 'tp_30', role: 'admin' })
      await ctrl.bindSuperAdmin(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.code).toBe('BIND_SUPER_ADMIN_DEPRECATED')
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })
  })

  describe('unbindSuperAdmin', () => {
    it('demotes the current super_admin to admin and re-issues a token', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      // A second super admin exists so the first one can be safely demoted.
      const admin = users.createUser({ username: 'tp_31', password: 'x', role: 'admin' })
      users.updateUser({ userId: admin!.id, role: 'super_admin' })

      const ctx = makeAuthedCtx({}, { id: admin!.id, username: 'tp_31', role: 'super_admin' })
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.token).toBeTruthy()
      expect(ctx.body.user.role).toBe('admin')
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('rejects when the current user is not a super_admin', async () => {
      const { ctrl, users } = await loadModules()
      users.createDefaultSuperAdmin()
      const admin = users.createUser({ username: 'tp_32', password: 'x', role: 'admin' })

      const ctx = makeAuthedCtx({}, { id: admin!.id, username: 'tp_32', role: 'admin' })
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ error: 'Only a super administrator can unbind' })
      expect(users.findUserById(admin!.id)!.role).toBe('admin')
    })

    it('rejects when it would leave no active super administrator', async () => {
      const { ctrl, users } = await loadModules()
      const admin = users.createUser({ username: 'tp_33', password: 'x', role: 'super_admin' })

      const ctx = makeAuthedCtx({}, { id: admin!.id, username: 'tp_33', role: 'super_admin' })
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'At least one active super administrator is required' })
      expect(users.findUserById(admin!.id)!.role).toBe('super_admin')
    })

    it('requires an authenticated user', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeAuthedCtx({}, null)
      await ctrl.unbindSuperAdmin(ctx)

      expect(ctx.status).toBe(401)
      expect(ctx.body).toEqual({ error: 'Unauthorized' })
    })
  })

  describe('setPassword', () => {
    it('sets the password for a WeChat-provisioned user without the current password', async () => {
      const { ctrl, users } = await loadModules()
      const user = users.createUser({ username: 'tp_40', password: 'old-pass', role: 'admin' })

      const ctx = makeAuthedCtx({ newPassword: 'brand-new-pass' }, { id: user!.id, username: 'tp_40', role: 'admin' })
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
      expect(users.verifyPassword('brand-new-pass', users.findUserById(user!.id)!.password_hash)).toBe(true)
    })

    it('rejects non-WeChat users: they must use change-password', async () => {
      const { ctrl, users } = await loadModules()
      const user = users.createUser({ username: 'human', password: 'old-pass', role: 'admin' })

      const ctx = makeAuthedCtx({ newPassword: 'brand-new-pass' }, { id: user!.id, username: 'human', role: 'admin' })
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(403)
      expect(users.verifyPassword('old-pass', users.findUserById(user!.id)!.password_hash)).toBe(true)
    })

    it('rejects a password shorter than 6 characters', async () => {
      const { ctrl, users } = await loadModules()
      const user = users.createUser({ username: 'tp_41', password: 'old-pass', role: 'admin' })

      const ctx = makeAuthedCtx({ newPassword: '123' }, { id: user!.id, username: 'tp_41', role: 'admin' })
      await ctrl.setPassword(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: 'New password must be at least 6 characters' })
    })

    it('requires an authenticated user', async () => {
      const { ctrl } = await loadModules()
      const ctx = makeAuthedCtx({ newPassword: 'brand-new-pass' }, null)
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
