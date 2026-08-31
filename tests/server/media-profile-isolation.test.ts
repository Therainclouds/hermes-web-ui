import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: (name: string) => `/tmp/hermes/${name}`,
  listProfileNamesFromDisk: () => ['default', 'u_1', 'u_2', 'u_9'],
}))
vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: async () => ({}),
}))
vi.mock('../../packages/server/src/services/hermes/custom-providers-compat', () => ({
  getCompatibleCustomProviders: () => [],
}))
vi.mock('../../packages/server/src/config', () => ({
  config: { appHome: '/tmp/hermes-web-ui-home' },
}))

describe('media profile ownership isolation', () => {
  let db: any = null
  let media: any = null
  let users: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    media = await import('../../packages/server/src/controllers/hermes/media')
    users = await import('../../packages/server/src/db/hermes/users-store')
  })

  function makeCtx(user: { id: number; username: string; role: string; profiles?: string[] } | null, queryProfile = '') {
    return {
      request: { body: {} },
      headers: {},
      query: { profile: queryProfile },
      status: 200,
      body: null,
      get: vi.fn(() => ''),
      state: { user },
    } as any
  }

  it('rejects a regular user requesting a profile they do not own (403)', async () => {
    const user = users.createUser({ username: 'tp_1', password: 'x', role: 'admin', profiles: ['u_1'] })

    const ctx = makeCtx({
      id: user!.id,
      username: 'tp_1',
      role: 'admin',
      profiles: ['u_1'],
    }, 'u_9')
    await media.apiKeyImageGenerate(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body.code).toBe('profile_forbidden')
  })

  it('rejects a regular user falling back to the shared active profile (400 profile_required)', async () => {
    const user = users.createUser({ username: 'tp_2', password: 'x', role: 'admin', profiles: ['u_1', 'u_2'] })

    const ctx = makeCtx({
      id: user!.id,
      username: 'tp_2',
      role: 'admin',
      profiles: ['u_1', 'u_2'],
    })
    await media.apiKeyImageGenerate(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body.code).toBe('profile_required')
  })

  it('lets a regular user use a profile they own', async () => {
    const user = users.createUser({ username: 'tp_3', password: 'x', role: 'admin', profiles: ['u_1'] })

    const ctx = makeCtx({
      id: user!.id,
      username: 'tp_3',
      role: 'admin',
      profiles: ['u_1'],
    }, 'u_1')
    await media.apiKeyImageGenerate(ctx)

    // The request moves past profile resolution into provider configuration
    // territory — the point is that the ownership check did not fire.
    expect(ctx.status).not.toBe(403)
    expect(ctx.body?.code).not.toBe('profile_forbidden')
  })

  it('lets a super administrator use any profile', async () => {
    users.createDefaultSuperAdmin()

    const ctx = makeCtx({ id: 1, username: 'quanthermes', role: 'super_admin' }, 'u_9')
    await media.apiKeyImageGenerate(ctx)

    expect(ctx.status).not.toBe(403)
    expect(ctx.body?.code).not.toBe('profile_forbidden')
  })
})
