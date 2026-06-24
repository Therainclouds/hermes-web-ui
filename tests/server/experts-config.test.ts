import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('experts config loader', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'experts-cfg-'))
    process.cwd = () => dir
  })

  it('returns defaults when config missing', async () => {
    const mod = await import('../../packages/server/src/services/hermes/experts/config')
    mod.resetExpertsMarketplaceConfigCache()
    const cfg = mod.loadExpertsMarketplaceConfig()
    expect(cfg.baseUrl).toBe('')
    expect(cfg.cacheTtlSeconds).toBe(30)
    expect(cfg.maxPackageBytes).toBeGreaterThan(0)
    expect(cfg.localPackagesRoot.length).toBeGreaterThan(0)
  })

  it('parses baseUrl from yaml', async () => {
    const cfgPath = join(dir, 'config', 'experts-marketplace.yaml')
    require('fs').mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(
      cfgPath,
      [
        '# comment',
        'baseUrl: "https://example.test"',
        'cacheTtlSeconds: 5',
        'maxPackageBytes: 1024',
      ].join('\n'),
    )
    process.cwd = () => dir
    const mod = await import('../../packages/server/src/services/hermes/experts/config')
    mod.resetExpertsMarketplaceConfigCache()
    const cfg = mod.loadExpertsMarketplaceConfig()
    expect(cfg.baseUrl).toBe('https://example.test')
    expect(cfg.cacheTtlSeconds).toBe(5)
    expect(cfg.maxPackageBytes).toBe(1024)
    rmSync(dir, { recursive: true, force: true })
  })
})
