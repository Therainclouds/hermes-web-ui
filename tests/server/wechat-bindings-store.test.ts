import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('wechat-bindings-store', () => {
  let db: any = null
  let bindings: any = null

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
    bindings = await import('../../packages/server/src/db/hermes/wechat-bindings-store')
  })

  it('upserts one row per Token Platform user id', async () => {
    const first = bindings.upsertBindingByPlatformId({
      userId: null,
      platformProfileId: 7,
      platformUsername: 'wechat_7',
      apiBase: 'https://api.quantclaw.vip',
      apiKey: 'sk-7',
      deviceId: '42',
      models: ['gpt-4o'],
      displayName: '用户七',
    })
    expect(first?.platform_profile_id).toBe(7)
    expect(bindings.parseBindingModels(first!)).toEqual(['gpt-4o'])

    const updated = bindings.upsertBindingByPlatformId({
      userId: 3,
      platformProfileId: 7,
      platformUsername: 'wechat_7',
      apiBase: 'https://api.quantclaw.vip',
      apiKey: 'sk-7-new',
      deviceId: '42',
      models: ['gpt-4o', 'gpt-4o-mini'],
      displayName: '用户七改名',
    })
    expect(updated?.id).toBe(first!.id)
    expect(updated?.api_key).toBe('sk-7-new')
    expect(updated?.user_id).toBe(3)
    expect(bindings.countWeChatBindings()).toBe(1)
  })

  it('lists bindings in bound order and resolves by user/platform id', async () => {
    bindings.upsertBindingByPlatformId({
      userId: null, platformProfileId: 8, apiBase: 'https://a', apiKey: 'k8', models: [], displayName: '甲',
    })
    bindings.upsertBindingByPlatformId({
      userId: null, platformProfileId: 9, apiBase: 'https://a', apiKey: 'k9', models: [], displayName: '乙',
    })

    expect(bindings.listWeChatBindings().map((b: any) => b.platform_profile_id)).toEqual([8, 9])
    expect(bindings.findBindingByPlatformId(9)?.display_name).toBe('乙')
    expect(bindings.findBindingByPlatformId(404 as unknown as number)).toBeNull()
    expect(bindings.findBindingByPlatformId(Number.NaN)).toBeNull()
  })

  it('deletes by user id or platform id', async () => {
    bindings.upsertBindingByPlatformId({
      userId: 11, platformProfileId: 12, apiBase: 'https://a', apiKey: 'k', models: [], displayName: '',
    })
    expect(bindings.deleteBindingByUserId(999)).toBe(false)
    expect(bindings.deleteBindingByPlatformId(12)).toBe(true)
    expect(bindings.listWeChatBindings()).toHaveLength(0)
    expect(bindings.deleteBindingByPlatformId(12)).toBe(false)
  })

  it('returns an empty list when no bindings exist', async () => {
    expect(bindings.listWeChatBindings()).toEqual([])
    expect(bindings.countWeChatBindings()).toBe(0)
  })
})
