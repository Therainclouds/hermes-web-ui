import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanupStaleNpmPackageBackupDirs, collectNpmPackageBackupPrefixes } from '../../packages/server/src/services/update/strategies/npm-package'

/**
 * npm 全局安装（npm install -g）替换旧包时把现有包目录改名为 `.{name}-{random}`
 * 备份；上次失败留下的非空备份目录会让下一次 rename 报 ENOTEMPTY。
 * 这些测试验证清理函数能删除 scope 目录与全局 bin 目录里的残留备份。
 */
describe('cleanupStaleNpmPackageBackupDirs', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
  })

  /** 构造与实现一致的全局布局：<prefix>/lib/node_modules + <prefix>/lib/bin（Windows 无 bin 子目录）。 */
  function makeLayout(): { globalRoot: string; scopeDir: string; binDir: string } {
    const prefix = mkdtempSync(join(tmpdir(), 'npm-backup-test-'))
    roots.push(prefix)
    const globalRoot = join(prefix, 'lib', 'node_modules')
    const scopeDir = join(globalRoot, '@quanthermes')
    mkdirSync(scopeDir, { recursive: true })
    const binDir = process.platform === 'win32' ? dirname(globalRoot) : join(dirname(globalRoot), 'bin')
    mkdirSync(binDir, { recursive: true })
    return { globalRoot, scopeDir, binDir }
  }

  it('removes stale backup dirs from the scope dir and the global bin dir', () => {
    const { globalRoot, scopeDir, binDir } = makeLayout()
    const packageDir = join(scopeDir, 'hermes-web-ui')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{"version":"0.7.18"}')
    // Stale backups from a previous failed npm install.
    mkdirSync(join(scopeDir, '.hermes-web-ui-bSGY0hDK'), { recursive: true })
    mkdirSync(join(binDir, '.hermes-web-ui-NKPWfPhD'), { recursive: true })

    const removed = cleanupStaleNpmPackageBackupDirs(globalRoot, '@quanthermes/hermes-web-ui', 'hermes-web-ui.mjs')

    expect(removed).toBe(2)
    expect(readdirSync(scopeDir)).toEqual(['hermes-web-ui'])
    // Windows 上 bin 目录就是全局根的父目录（含 node_modules 等真实内容），只断言残留被清。
    expect(readdirSync(binDir)).not.toContain('.hermes-web-ui-NKPWfPhD')
  })

  it('ignores unrelated entries and directories of other packages', () => {
    const { globalRoot, scopeDir, binDir } = makeLayout()
    mkdirSync(join(scopeDir, '.other-pkg-abc123'), { recursive: true })
    mkdirSync(join(scopeDir, 'real-pkg'), { recursive: true })
    mkdirSync(join(binDir, '.unrelated-tool-xyz789'), { recursive: true })

    const removed = cleanupStaleNpmPackageBackupDirs(globalRoot, '@quanthermes/hermes-web-ui', 'hermes-web-ui.mjs')

    expect(removed).toBe(0)
    expect(readdirSync(scopeDir).sort()).toEqual(['.other-pkg-abc123', 'real-pkg'])
    expect(readdirSync(binDir)).toContain('.unrelated-tool-xyz789')
  })

  it('collects bin names declared in the installed package.json', () => {
    const { globalRoot, scopeDir, binDir } = makeLayout()
    const packageDir = join(scopeDir, 'hermes-web-ui')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@quanthermes/hermes-web-ui',
      bin: {
        'hermes-web-ui': 'bin/hermes-web-ui.mjs',
        'hermes-web-ui-mcp': 'bin/hermes-studio-mcp.mjs',
        'hermes-studio-mcp': 'bin/hermes-studio-mcp.mjs',
      },
    }))
    mkdirSync(join(binDir, '.hermes-web-ui-mcp-77yh2NH5'), { recursive: true })
    mkdirSync(join(binDir, '.hermes-studio-mcp-tas3hlgO'), { recursive: true })

    const prefixes = collectNpmPackageBackupPrefixes(globalRoot, '@quanthermes/hermes-web-ui', 'hermes-web-ui.mjs')
    expect(prefixes).toEqual(expect.arrayContaining(['hermes-web-ui', 'hermes-web-ui-mcp', 'hermes-studio-mcp']))

    const removed = cleanupStaleNpmPackageBackupDirs(globalRoot, '@quanthermes/hermes-web-ui', 'hermes-web-ui.mjs')
    expect(removed).toBe(2)
    expect(readdirSync(binDir)).not.toContain('.hermes-web-ui-mcp-77yh2NH5')
    expect(readdirSync(binDir)).not.toContain('.hermes-studio-mcp-tas3hlgO')
  })

  it('returns 0 without throwing when the global root does not exist', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'npm-backup-test-')), 'nonexistent')
    roots.push(dirname(missing))

    expect(cleanupStaleNpmPackageBackupDirs(missing, '@quanthermes/hermes-web-ui', 'hermes-web-ui.mjs')).toBe(0)
  })
})
