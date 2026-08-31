import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const hoisted = vi.hoisted(() => ({
  bindingFile: '',
}))

vi.mock('../../packages/server/src/services/device-binding', () => ({
  deviceBindingFilePath: () => hoisted.bindingFile,
  loadDeviceBinding: async () => {
    try {
      const raw = await readFile(hoisted.bindingFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed?.api_key || !parsed.api_base) return null
      return parsed
    } catch {
      return null
    }
  },
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('migrateLegacyDeviceBinding', () => {
  let db: any = null
  let dir = ''

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'wechat-migration-'))
    hoisted.bindingFile = join(dir, 'device-binding.json')

    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
  })

  it('imports the legacy binding and renames the file away', async () => {
    await writeFile(hoisted.bindingFile, JSON.stringify({
      device_id: '42',
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-legacy',
      models: ['gpt-4o'],
      display_name: '旧主人',
      username: 'wechat_7',
      profile_id: 7,
      bound_at: 1,
    }), 'utf-8')

    const users = await import('../../packages/server/src/db/hermes/users-store')
    const owner = users.createUser({ username: 'tp_7', password: 'x', role: 'super_admin' })

    const { migrateLegacyDeviceBinding } = await import('../../packages/server/src/services/wechat-binding-migration')
    await migrateLegacyDeviceBinding()

    const bindings = await import('../../packages/server/src/db/hermes/wechat-bindings-store')
    const row = bindings.findBindingByPlatformId(7)
    expect(row?.api_key).toBe('sk-legacy')
    expect(row?.user_id).toBe(owner!.id)
    expect(row?.display_name).toBe('旧主人')
    // The legacy file must never be imported twice.
    await expect(readFile(`${hoisted.bindingFile}.migrated`, 'utf-8')).resolves.toBeTruthy()
    await expect(readFile(hoisted.bindingFile, 'utf-8')).rejects.toThrow()
  })

  it('demotes legacy tp_ WeChat super admins but keeps the built-in account', async () => {
    const users = await import('../../packages/server/src/db/hermes/users-store')
    users.createDefaultSuperAdmin()
    users.createUser({ username: 'tp_8', password: 'x', role: 'super_admin' })
    users.createUser({ username: 'human', password: 'y', role: 'super_admin' })

    const { migrateLegacyDeviceBinding } = await import('../../packages/server/src/services/wechat-binding-migration')
    await migrateLegacyDeviceBinding()

    expect(users.findUserByUsername('tp_8')!.role).toBe('admin')
    // tp_ prefix match only: unrelated users and the built-in super admin stay.
    expect(users.findUserByUsername('human')!.role).toBe('super_admin')
    expect(users.findUserByUsername('quanthermes')!.role).toBe('super_admin')
  })

  it('is idempotent on repeated runs', async () => {
    await writeFile(hoisted.bindingFile, JSON.stringify({
      api_base: 'https://api.quantclaw.vip',
      api_key: 'sk-legacy',
      models: [],
      display_name: '旧主人',
      username: 'wechat_9',
      profile_id: 9,
    }), 'utf-8')

    const { migrateLegacyDeviceBinding } = await import('../../packages/server/src/services/wechat-binding-migration')
    await migrateLegacyDeviceBinding()
    await migrateLegacyDeviceBinding()

    const bindings = await import('../../packages/server/src/db/hermes/wechat-bindings-store')
    expect(bindings.countWeChatBindings()).toBe(1)
  })

  it('does nothing destructive when no legacy file exists', async () => {
    const { migrateLegacyDeviceBinding } = await import('../../packages/server/src/services/wechat-binding-migration')
    await expect(migrateLegacyDeviceBinding()).resolves.toBeUndefined()
    const bindings = await import('../../packages/server/src/db/hermes/wechat-bindings-store')
    expect(bindings.countWeChatBindings()).toBe(0)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
})
