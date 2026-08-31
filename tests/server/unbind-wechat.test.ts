import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USERNAME } from '../../packages/server/src/db/hermes/users-store'

const { deleteProfileFromDiskMock, clearProfileIdentityMock, removeAllUserThemeAssetsMock } = vi.hoisted(() => ({
  deleteProfileFromDiskMock: vi.fn(async () => true),
  clearProfileIdentityMock: vi.fn(),
  removeAllUserThemeAssetsMock: vi.fn(async () => undefined),
}))

vi.mock('../../packages/server/src/services/hermes/wechat-user-provisioning', () => ({
  deleteProfileFromDisk: deleteProfileFromDiskMock,
  ensurePersonalWorkspace: vi.fn(async () => null),
  personalProfileNameFor: (platformProfileId: number) => `u_${platformProfileId}`,
  applyTokenPlatformProvider: vi.fn(async () => true),
}))
vi.mock('../../packages/server/src/services/hermes/profile-metadata', () => ({
  setProfileDisplayName: vi.fn(),
  setProfileAvatarRemote: vi.fn(),
  setProfileAvatarGenerated: vi.fn(),
  clearProfileIdentity: clearProfileIdentityMock,
}))
vi.mock('../../packages/server/src/services/user-theme', () => ({
  removeAllUserThemeAssets: removeAllUserThemeAssetsMock,
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('clearDeviceBindingController (protected WeChat unbind)', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    deleteProfileFromDiskMock.mockResolvedValue(true)

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

  function makeAuthedCtx(user: { id: number; username: string; role: string } | null, query: Record<string, string> = {}) {
    return {
      request: { body: {} },
      headers: {},
      query,
      ip: '127.0.0.1',
      status: 200,
      body: null,
      get: vi.fn(() => ''),
      req: { socket: { remoteAddress: '127.0.0.1' } },
      state: { user },
    } as any
  }

  function seedBinding(bindings: any, opts: { platformId: number; userId: number; displayName?: string }) {
    return bindings.upsertBindingByPlatformId({
      userId: opts.userId,
      platformProfileId: opts.platformId,
      platformUsername: `wechat_${opts.platformId}`,
      apiBase: 'https://api.quantclaw.vip',
      apiKey: 'sk-owner',
      deviceId: '42',
      models: ['gpt-4o'],
      displayName: opts.displayName || '微信用户',
    })
  }

  it('requires an authenticated user', async () => {
    const { ctrl } = await loadModules()
    const ctx = makeAuthedCtx(null)
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('lets the bound WeChat user unbind themselves and wipes their data', async () => {
    const { ctrl, users, bindings } = await loadModules()
    const superAdmin = users.createDefaultSuperAdmin()
    const owner = users.createUser({ username: 'tp_7', password: 'x', role: 'admin' })
    users.replaceUserProfiles(owner!.id, ['u_7'], 'u_7')
    seedBinding(bindings, { platformId: 7, userId: owner!.id })

    const ctx = makeAuthedCtx({ id: owner!.id, username: 'tp_7', role: 'admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ success: true, hadBinding: true, deletedUser: 'tp_7', deletedProfiles: ['u_7'] })
    expect(users.findUserByUsername('tp_7')).toBeNull()
    expect(users.findUserById(superAdmin!.id)).not.toBeNull()
    expect(deleteProfileFromDiskMock).toHaveBeenCalledWith('u_7')
    expect(removeAllUserThemeAssetsMock).toHaveBeenCalledWith(owner!.id)
    expect(bindings.findBindingByPlatformId(7)).toBeNull()
  })

  it('lets a super administrator unbind another WeChat account via platform_profile_id', async () => {
    const { ctrl, users, bindings } = await loadModules()
    const superAdmin = users.createDefaultSuperAdmin()
    const wechatUser = users.createUser({ username: 'tp_8', password: 'x', role: 'admin' })
    users.replaceUserProfiles(wechatUser!.id, ['u_8'], 'u_8')
    seedBinding(bindings, { platformId: 8, userId: wechatUser!.id })

    const ctx = makeAuthedCtx(
      { id: superAdmin!.id, username: DEFAULT_USERNAME, role: 'super_admin' },
      { platform_profile_id: '8' },
    )
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.deletedUser).toBe('tp_8')
    expect(users.findUserByUsername('tp_8')).toBeNull()
    expect(deleteProfileFromDiskMock).toHaveBeenCalledWith('u_8')
  })

  it('rejects a regular admin who is not the bound owner', async () => {
    const { ctrl, users, bindings } = await loadModules()
    users.createDefaultSuperAdmin()
    const wechatUser = users.createUser({ username: 'tp_8', password: 'x', role: 'admin' })
    seedBinding(bindings, { platformId: 8, userId: wechatUser!.id })
    const helper = users.createUser({ username: 'helper', password: 'y', role: 'admin' })

    const ctx = makeAuthedCtx(
      { id: helper!.id, username: 'helper', role: 'admin' },
      { platform_profile_id: '8' },
    )
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Only the bound WeChat owner or a super administrator can unbind' })
    expect(users.findUserByUsername('tp_8')).not.toBeNull()
    expect(bindings.findBindingByPlatformId(8)).not.toBeNull()
    expect(removeAllUserThemeAssetsMock).not.toHaveBeenCalled()
  })

  it('wipes a legacy tp_ user without an imported binding row', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    const owner = users.createUser({ username: 'tp_9', password: 'x', role: 'admin' })
    users.replaceUserProfiles(owner!.id, ['default'], 'default')

    const ctx = makeAuthedCtx({ id: owner!.id, username: 'tp_9', role: 'admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.deletedUser).toBe('tp_9')
    expect(users.findUserByUsername('tp_9')).toBeNull()
    // Legacy users were only bound to the shared default profile; nothing
    // personal to remove from disk.
    expect(deleteProfileFromDiskMock).not.toHaveBeenCalled()
  })

  it('is idempotent for a user with no binding and a non-tp_ username', async () => {
    const { ctrl, users } = await loadModules()
    const admin = users.createDefaultSuperAdmin()

    const ctx = makeAuthedCtx({ id: admin!.id, username: DEFAULT_USERNAME, role: 'super_admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ success: true, hadBinding: false, deletedUser: null, deletedProfiles: [] })
    expect(users.findUserByUsername(DEFAULT_USERNAME)).not.toBeNull()
  })
})
