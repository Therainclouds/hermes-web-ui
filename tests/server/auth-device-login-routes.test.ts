import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/controllers/auth', () => ({
  authStatus: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  login: vi.fn(async (ctx: any) => { ctx.body = { token: 'x' } }),
  appLogin: vi.fn(async (ctx: any) => { ctx.body = { token: 'x' } }),
  microcontrollerLogin: vi.fn(async (ctx: any) => { ctx.body = { token: 'x', profiles: [] } }),
  deviceLogin: vi.fn(async (ctx: any) => { ctx.body = { token: 'jwt' } }),
  restoreDeviceLogin: vi.fn(async (ctx: any) => { ctx.body = { token: 'jwt' } }),
  bindSuperAdmin: vi.fn(async (ctx: any) => { ctx.body = { token: 'jwt' } }),
  unbindSuperAdmin: vi.fn(async (ctx: any) => { ctx.body = { token: 'jwt' } }),
  setPassword: vi.fn(async (ctx: any) => { ctx.body = { success: true } }),
  getDeviceBinding: vi.fn(async (ctx: any) => { ctx.body = { bound: false } }),
  clearDeviceBindingController: vi.fn(async (ctx: any) => { ctx.body = { success: true } }),
  setupPassword: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  currentUser: vi.fn(async (ctx: any) => { ctx.body = { user: {} } }),
  changePassword: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  changeUsername: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  updateMyModelGuideStatus: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  getMyAvatar: vi.fn(async (ctx: any) => { ctx.body = { avatar: '' } }),
  updateMyAvatar: vi.fn(async (ctx: any) => { ctx.body = { success: true } }),
  removePassword: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  listManagedUsers: vi.fn(async (ctx: any) => { ctx.body = { users: [] } }),
  createManagedUser: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  exportManagedUser: vi.fn(async (ctx: any) => { ctx.body = { user: {} } }),
  updateManagedUser: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  deleteManagedUser: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
  listLockedIps: vi.fn(async (ctx: any) => { ctx.body = { locks: [] } }),
  unlockIpHandler: vi.fn(async (ctx: any) => { ctx.body = { ok: true } }),
}))

const requireSuperAdminMock = vi.fn(async (_ctx: any, next: any) => { await next() })
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  requireSuperAdmin: requireSuperAdminMock,
  issueUserJwt: vi.fn(async () => 'jwt'),
}))

describe('auth routes: device login endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  function findLayer(router: any, method: string, path: string) {
    return router.stack.find(
      (entry: any) => Array.isArray(entry.methods) && entry.methods.includes(method) && entry.path === path,
    )
  }

  it('mounts POST /api/auth/device-login on the public router', async () => {
    const { authPublicRoutes } = await import('../../packages/server/src/routes/auth')
    expect(findLayer(authPublicRoutes, 'POST', '/api/auth/device-login')).toBeDefined()
  })

  it('mounts POST /api/auth/device-login/restore on the public router', async () => {
    const { authPublicRoutes } = await import('../../packages/server/src/routes/auth')
    expect(findLayer(authPublicRoutes, 'POST', '/api/auth/device-login/restore')).toBeDefined()
  })

  it('mounts GET /api/auth/device-binding on the public router', async () => {
    const { authPublicRoutes } = await import('../../packages/server/src/routes/auth')
    expect(findLayer(authPublicRoutes, 'GET', '/api/auth/device-binding')).toBeDefined()
  })

  it('mounts DELETE /api/auth/device-binding on the protected router', async () => {
    const { authProtectedRoutes } = await import('../../packages/server/src/routes/auth')
    expect(findLayer(authProtectedRoutes, 'DELETE', '/api/auth/device-binding')).toBeDefined()
  })
})
