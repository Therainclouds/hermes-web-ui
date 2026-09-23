import { describe, expect, it } from 'vitest'
import { nativePluginArgs } from '../../packages/server/src/services/coding-agents/dsh/plugins'

describe('DSH native plugin argument builder', () => {
  it('accepts registry package@exact-version specs', () => {
    const args = nativePluginArgs({ action: 'install', packageSpec: '@scope/plugin@1.2.3' })
    expect(args).toEqual(['plugin', '--profile', 'web', 'add', '@scope/plugin@1.2.3'])
  })

  it('accepts github:owner/repo#commit specs', () => {
    const args = nativePluginArgs({ action: 'install', packageSpec: 'github:foo/bar#abc1234' })
    expect(args).toEqual(['plugin', '--profile', 'web', 'add', 'github:foo/bar#abc1234'])
  })

  it('rejects fuzzy version specs', () => {
    expect(() => nativePluginArgs({ action: 'install', packageSpec: '@scope/plugin@^1' })).toThrow()
    expect(() => nativePluginArgs({ action: 'install', packageSpec: '@scope/plugin' })).toThrow()
  })

  it('rejects invalid package names', () => {
    expect(() =>
      nativePluginArgs({ action: 'install', packageSpec: '@bad name@1.0.0' }),
    ).toThrow(/Use package@exact-version/)
  })

  it('builds remove args only for valid package names', () => {
    const args = nativePluginArgs({ action: 'remove', packageName: '@scope/plugin' })
    expect(args).toEqual(['plugin', '--profile', 'web', 'remove', '@scope/plugin'])
  })

  it('rejects remove with invalid package names', () => {
    expect(() => nativePluginArgs({ action: 'remove', packageName: 'bad name' })).toThrow()
  })
})