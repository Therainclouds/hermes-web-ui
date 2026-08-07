import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const configMock = vi.hoisted(() => ({
  deployDir: '',
  appHome: '',
}))

vi.mock('../../packages/server/src/config', () => ({
  getDeployDir: () => configMock.deployDir,
  getWebUiHome: () => configMock.appHome,
}))

describe('restoreTlsCertificatesAfterNpmUpdate', () => {
  const roots: string[] = []

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    configMock.deployDir = ''
    configMock.appHome = ''
  })

  afterEach(() => {
    for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'npm-certs-test-'))
    roots.push(dir)
    return dir
  }

  it('copies certificates from a stable source into the package certs dir when missing', async () => {
    const source = makeDir()
    const sourceCerts = join(source, 'certs')
    mkdirSync(sourceCerts, { recursive: true })
    writeFileSync(join(sourceCerts, 'server.crt'), 'crt')
    writeFileSync(join(sourceCerts, 'server.key'), 'key')
    configMock.deployDir = source
    const target = makeDir()

    const { restoreTlsCertificatesAfterNpmUpdate } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    restoreTlsCertificatesAfterNpmUpdate(target)

    expect(readFileSync(join(target, 'server.crt'), 'utf8')).toBe('crt')
    expect(readFileSync(join(target, 'server.key'), 'utf8')).toBe('key')
  })

  it('keeps existing package certificates untouched', async () => {
    const target = makeDir()
    writeFileSync(join(target, 'server.crt'), 'existing-crt')
    writeFileSync(join(target, 'server.key'), 'existing-key')

    const { restoreTlsCertificatesAfterNpmUpdate } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    restoreTlsCertificatesAfterNpmUpdate(target)

    expect(readFileSync(join(target, 'server.crt'), 'utf8')).toBe('existing-crt')
  })

  it('does nothing when no stable certificates are found', async () => {
    const target = makeDir()

    const { restoreTlsCertificatesAfterNpmUpdate } = await import(
      '../../packages/server/src/services/update/strategies/npm-package'
    )
    expect(() => restoreTlsCertificatesAfterNpmUpdate(target)).not.toThrow()
    expect(existsSync(join(target, 'server.crt'))).toBe(false)
  })
})
