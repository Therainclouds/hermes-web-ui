import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USERNAME } from '../../packages/server/src/db/hermes/users-store'

const { loadDeviceBindingMock, clearDeviceBindingMock, clearProfileIdentityMock, removeAllUserThemeAssetsMock } = vi.hoisted(() => ({
  loadDeviceBindingMock: vi.fn(async () => null),
  clearDeviceBindingMock: vi.fn(async () => undefined),
  clearProfileIdentityMock: vi.fn(),
  removeAllUserThemeAssetsMock: vi.fn(async () => undefined),
}))

vi.mock('../../packages/server/src/services/device-binding', () => ({
  saveDeviceBinding: vi.fn(async () => undefined),
  clearDeviceBinding: clearDeviceBindingMock,
  loadDeviceBinding: loadDeviceBindingMock,
  getOrCreateHardwareId: vi.fn(async () => 'uuid'),
  getHardwareId: vi.fn(async () => 'uuid'),
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

  function makeAuthedCtx(user: { id: number; username: string; role: string } | null) {
    return {
      request: { body: {} },
      headers: {},
      query: {},
      ip: '127.0.0.1',
      status: 200,
      body: null,
      get: vi.fn(() => ''),
      req: { socket: { remoteAddress: '127.0.0.1' } },
      state: { user },
    } as any
  }

  function ownerBinding(profileId: number, extra: Record<string, unknown> = {}) {
    return {
      device_id: '42',
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-owner',
      models: ['gpt-4o'],
      display_name: '微信主人',
      username: `wechat_${profileId}`,
      profile_id: profileId,
      bound_at: Date.now(),
      ...extra,
    }
  }

  it('requires an authenticated user', async () => {
    const { ctrl } = await loadModules()
    const ctx = makeAuthedCtx(null)
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
    expect(clearDeviceBindingMock).not.toHaveBeenCalled()
  })

  it('lets the bound owner unbind even when they are the only super administrator', async () => {
    // Regression: the sole WeChat owner used to be stuck behind the
    // "at least one active super administrator" guard. Unbinding is a
    // device-handover operation — the owner deletes themselves and the next
    // scan bootstraps a fresh owner.
    const { ctrl, users } = await loadModules()
    const owner = users.createUser({ username: 'tp_7', password: 'x', role: 'super_admin' })
    expect(users.countActiveSuperAdmins()).toBe(1)
    loadDeviceBindingMock.mockResolvedValue(ownerBinding(7))

    const ctx = makeAuthedCtx({ id: owner!.id, username: 'tp_7', role: 'super_admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ success: true, hadBinding: true, deletedUser: 'tp_7' })
    expect(users.findUserByUsername('tp_7')).toBeNull()
    expect(removeAllUserThemeAssetsMock).toHaveBeenCalledWith(owner!.id)
    expect(clearProfileIdentityMock).toHaveBeenCalledWith('default')
    expect(clearDeviceBindingMock).toHaveBeenCalled()
  })

  it('lets a different super administrator unbind the device (handover)', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    users.createUser({ username: 'tp_8', password: 'x', role: 'super_admin' })
    loadDeviceBindingMock.mockResolvedValue(ownerBinding(8))

    const ctx = makeAuthedCtx({ id: 1, username: DEFAULT_USERNAME, role: 'super_admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ success: true, hadBinding: true, deletedUser: 'tp_8' })
    expect(users.findUserByUsername('tp_8')).toBeNull()
    expect(clearDeviceBindingMock).toHaveBeenCalled()
  })

  it('rejects a regular admin who is neither the owner nor a super administrator', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    users.createUser({ username: 'tp_8', password: 'x', role: 'super_admin' })
    const helper = users.createUser({ username: 'helper', password: 'y', role: 'admin' })
    loadDeviceBindingMock.mockResolvedValue(ownerBinding(8))

    const ctx = makeAuthedCtx({ id: helper!.id, username: 'helper', role: 'admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Only the bound WeChat owner or a super administrator can unbind this device' })
    expect(users.findUserByUsername('tp_8')).not.toBeNull()
    expect(clearDeviceBindingMock).not.toHaveBeenCalled()
    expect(clearProfileIdentityMock).not.toHaveBeenCalled()
  })

  it('lets a non-super-admin bound owner unbind (legacy bindings)', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    const owner = users.createUser({ username: 'tp_9', password: 'x', role: 'admin' })
    loadDeviceBindingMock.mockResolvedValue(ownerBinding(9))

    const ctx = makeAuthedCtx({ id: owner!.id, username: 'tp_9', role: 'admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.deletedUser).toBe('tp_9')
    expect(users.findUserByUsername('tp_9')).toBeNull()
  })

  it('resolves the owner from the stored username for older bindings without profile_id', async () => {
    const { ctrl, users } = await loadModules()
    users.createDefaultSuperAdmin()
    const owner = users.createUser({ username: 'tp_10', password: 'x', role: 'super_admin' })
    loadDeviceBindingMock.mockResolvedValue(ownerBinding(10, {
      profile_id: undefined,
      username: 'tp_10',
    }))

    const ctx = makeAuthedCtx({ id: owner!.id, username: 'tp_10', role: 'super_admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.deletedUser).toBe('tp_10')
  })

  it('is idempotent when no binding exists', async () => {
    const { ctrl, users } = await loadModules()
    const admin = users.createUser({ username: 'tp_11', password: 'x', role: 'super_admin' })
    loadDeviceBindingMock.mockResolvedValue(null)

    const ctx = makeAuthedCtx({ id: admin!.id, username: 'tp_11', role: 'super_admin' })
    await ctrl.clearDeviceBindingController(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({ success: true, hadBinding: false, deletedUser: null })
    expect(clearDeviceBindingMock).not.toHaveBeenCalled()
    expect(users.findUserByUsername('tp_11')).not.toBeNull()
  })
})
