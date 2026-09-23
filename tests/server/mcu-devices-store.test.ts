import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('MCU devices store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('creates and lists MCU devices', async () => {
    const store = await import('../../packages/server/src/db/hermes/mcu-devices-store')
    expect(store.listMcuDevices()).toEqual([])
    const created = store.createMcuDevice({ name: 'Bedroom MCU', deviceCode: 'mcu-1234', isOfficial: true })
    expect(created.id).toBeGreaterThan(0)
    expect(created.device_code).toBe('mcu-1234')
    expect(created.is_official).toBe(true)
    expect(store.listMcuDevices()).toHaveLength(1)
  })

  it('rejects duplicate device codes', async () => {
    const store = await import('../../packages/server/src/db/hermes/mcu-devices-store')
    store.createMcuDevice({ name: 'A', deviceCode: 'mcu-1234', isOfficial: true })
    expect(() =>
      store.createMcuDevice({ name: 'B', deviceCode: 'mcu-1234', isOfficial: false }),
    ).toThrow(/mcu_device_exists/)
  })

  it('renames a device and throws when renaming a missing device', async () => {
    const store = await import('../../packages/server/src/db/hermes/mcu-devices-store')
    const created = store.createMcuDevice({ name: 'Old', deviceCode: 'mcu-1234', isOfficial: true })
    const updated = store.updateMcuDeviceName(created.id, 'New name')
    expect(updated.name).toBe('New name')
    expect(() => store.updateMcuDeviceName(999, 'x')).toThrow(/mcu_device_not_found/)
  })

  it('deletes devices by id and reports missing rows', async () => {
    const store = await import('../../packages/server/src/db/hermes/mcu-devices-store')
    const created = store.createMcuDevice({ name: 'A', deviceCode: 'mcu-1234', isOfficial: false })
    expect(store.deleteMcuDevice(created.id)).toBe(true)
    expect(store.listMcuDevices()).toEqual([])
    expect(store.deleteMcuDevice(created.id)).toBe(false)
  })

  it('returns null when fetching a missing device', async () => {
    const store = await import('../../packages/server/src/db/hermes/mcu-devices-store')
    expect(store.getMcuDevice(42)).toBeNull()
  })

  it('trims device codes on insert and falls back to device code when renaming with empty name', async () => {
    const store = await import('../../packages/server/src/db/hermes/mcu-devices-store')
    const created = store.createMcuDevice({ name: 'Initial', deviceCode: '  mcu-9999  ', isOfficial: false })
    expect(created.device_code).toBe('mcu-9999')
    const renamed = store.updateMcuDeviceName(created.id, '   ')
    expect(renamed.name).toBe('mcu-9999')
  })
})