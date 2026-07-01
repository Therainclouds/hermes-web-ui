import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('usb service', () => {
  let db: any = null
  let tempRoot = ''

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
    tempRoot = mkdtempSync(resolve(tmpdir(), 'hermes-usb-service-'))
  })

  afterEach(() => {
    db?.close()
    db = null
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ''
    vi.doUnmock('../../packages/server/src/db/index')
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('stays unsupported on non-linux hosts instead of crashing bootstrap', async () => {
    const { USBService } = await import('../../packages/server/src/services/usb/USBService')
    const service = new USBService({
      platform: 'win32',
      deployDir: tempRoot,
      appHome: tempRoot,
      env: {},
      cleanupIntervalMs: 60_000,
    })

    service.start()

    expect(service.status().state).toBe('unsupported')
    await service.stop()
  })

  it('tracks mounted devices, persists history, and blocks path traversal', async () => {
    const mountPoint = resolve(tempRoot, 'mnt', 'usb', '1234-ABCD')
    mkdirSync(resolve(mountPoint, 'docs'), { recursive: true })
    writeFileSync(resolve(mountPoint, 'hello.txt'), 'hello usb', 'utf-8')
    writeFileSync(resolve(mountPoint, 'docs', 'nested.txt'), 'nested usb', 'utf-8')

    const { USBService } = await import('../../packages/server/src/services/usb/USBService')
    const service = new USBService({
      platform: 'linux',
      deployDir: tempRoot,
      appHome: tempRoot,
      env: { USB_MONITOR_DISABLED: '1' },
      cleanupIntervalMs: 60_000,
    })

    service.ingestMonitorMessage({
      type: 'device_event',
      action: 'add',
      uuid: '1234-ABCD',
      device_node: '/dev/sdb1',
      mount_point: mountPoint,
      fs_type: 'vfat',
      label: 'KINGSTON',
      status: 'mounted',
      ts: new Date('2026-07-01T10:00:00.000Z').toISOString(),
    })

    expect(service.listDevices()).toHaveLength(1)
    expect(service.listHistory('24h')).toHaveLength(1)

    const entries = await service.listFiles('1234-ABCD', '/')
    expect(entries.map(entry => entry.name)).toEqual(['docs', 'hello.txt'])

    const fileStat = await service.statPath('1234-ABCD', '/hello.txt')
    expect(fileStat.isDir).toBe(false)
    expect(fileStat.path).toBe('/hello.txt')

    const content = await service.readFile('1234-ABCD', '/hello.txt')
    expect(content.toString('utf-8')).toBe('hello usb')

    await expect(service.readFile('1234-ABCD', '/../secret.txt')).rejects.toMatchObject({
      code: 'invalid_path',
    })

    service.ingestMonitorMessage({
      type: 'device_event',
      action: 'remove',
      uuid: '1234-ABCD',
      device_node: '/dev/sdb1',
      label: 'KINGSTON',
      status: 'removed',
      ts: new Date('2026-07-01T10:05:00.000Z').toISOString(),
    })

    expect(service.listDevices()).toHaveLength(0)
    expect(service.listHistory('24h')).toHaveLength(2)
    await service.stop()
  })
})
