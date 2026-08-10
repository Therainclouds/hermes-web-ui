import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

type FsMocks = {
  readFile: ReturnType<typeof vi.fn>
  writeFile: ReturnType<typeof vi.fn>
  mkdir: ReturnType<typeof vi.fn>
  existsSync: ReturnType<typeof vi.fn>
}

async function loadBindingModule(overrides: Partial<FsMocks> & { home?: string } = {}) {
  const readFile = overrides.readFile ?? vi.fn()
  const writeFile = overrides.writeFile ?? vi.fn()
  const mkdir = overrides.mkdir ?? vi.fn()
  const existsSync = overrides.existsSync ?? vi.fn(() => false)
  const home = overrides.home ?? '/tmp/hermes-home'

  vi.resetModules()
  vi.doMock('fs/promises', () => ({ readFile, writeFile, mkdir }))
  vi.doMock('fs', () => ({ existsSync, mkdirSync: vi.fn() }))
  vi.doMock('os', () => ({ homedir: () => home, tmpdir: () => '/tmp' }))
  vi.doMock('../../packages/server/src/config', () => ({
    config: { appHome: join(home, '.hermes-web-ui') },
  }))

  const mod = await import('../../packages/server/src/services/device-binding')
  return {
    ...mod,
    mocks: { readFile, writeFile, mkdir, existsSync },
    appHome: join(home, '.hermes-web-ui'),
  }
}

describe('device-binding service', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterAll(() => {
    process.env = originalEnv
    vi.doUnmock('fs/promises')
    vi.doUnmock('fs')
    vi.doUnmock('os')
    vi.doUnmock('../../packages/server/src/config')
    vi.resetModules()
  })

  describe('getOrCreateHardwareId', () => {
    it('creates and persists a UUID when no device id exists yet', async () => {
      const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'))
      const writeFile = vi.fn().mockResolvedValue(undefined)
      const mkdir = vi.fn().mockResolvedValue(undefined)
      const existsSync = vi.fn(() => false)
      const { getOrCreateHardwareId, appHome } = await loadBindingModule({ readFile, writeFile, mkdir, existsSync })

      const id = await getOrCreateHardwareId()

      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(writeFile).toHaveBeenCalledWith(join(appHome, 'device-id'), id, 'utf-8')
      expect(mkdir).toHaveBeenCalledWith(appHome, { recursive: true })
    })

    it('reuses an existing device id', async () => {
      const readFile = vi.fn().mockResolvedValue('existing-id-123\n')
      const writeFile = vi.fn()
      const mkdir = vi.fn().mockResolvedValue(undefined)
      const existsSync = vi.fn(() => true)
      const { getOrCreateHardwareId } = await loadBindingModule({ readFile, writeFile, mkdir, existsSync })

      const id = await getOrCreateHardwareId()

      expect(id).toBe('existing-id-123')
      expect(writeFile).not.toHaveBeenCalled()
    })
  })

  describe('save/load device binding', () => {
    it('round-trips a binding through the JSON file', async () => {
      let stored = ''
      const readFile = vi.fn().mockImplementation(async () => stored)
      const writeFile = vi.fn().mockImplementation(async (_p, content) => { stored = content })
      const mkdir = vi.fn().mockResolvedValue(undefined)
      const existsSync = vi.fn(() => !!stored)
      const { saveDeviceBinding, loadDeviceBinding, appHome } = await loadBindingModule({ readFile, writeFile, mkdir, existsSync })

      await saveDeviceBinding({
        device_id: '42',
        api_base: 'https://api.quantclaw.vip',
        api_key: 'sk-test',
        models: ['gpt-4o'],
        display_name: '量迹用户',
        username: 'wechat_3',
        bound_at: 123,
      })

      const loaded = await loadDeviceBinding()
      expect(loaded).toEqual({
        device_id: '42',
        api_base: 'https://api.quantclaw.vip',
        api_key: 'sk-test',
        models: ['gpt-4o'],
        display_name: '量迹用户',
        username: 'wechat_3',
        bound_at: 123,
      })
      expect(writeFile).toHaveBeenCalledWith(join(appHome, 'device-binding.json'), expect.stringContaining('sk-test'), 'utf-8')
    })

    it('returns null when the binding file is absent or malformed', async () => {
      const readFile = vi.fn().mockResolvedValue('not json')
      const mkdir = vi.fn().mockResolvedValue(undefined)
      const existsSync = vi.fn(() => true)
      const { loadDeviceBinding } = await loadBindingModule({ readFile, mkdir, existsSync })

      const loaded = await loadDeviceBinding()
      expect(loaded).toBeNull()
    })
  })
})
