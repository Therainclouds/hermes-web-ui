import { describe, expect, it } from 'vitest'
import { nativePluginEntries } from '../../packages/server/src/services/coding-agents/dsh/plugin-inventory'

describe('DSH native plugin composition reader', () => {
  it('treats explicit boolean disabled values as enabled/disabled', () => {
    const content = `
- id: a
  name: '@example/a'
- id: b
  name: '@example/b'
  disabled: true
- id: c
  name: '@example/c'
  disabled: false
`
    const entries = nativePluginEntries(content)
    expect(entries).toHaveLength(3)
    expect(entries.find(e => e.moduleName === '@example/a')?.configuredEnabled).toBe(true)
    expect(entries.find(e => e.moduleName === '@example/b')?.configuredEnabled).toBe(false)
    expect(entries.find(e => e.moduleName === '@example/c')?.configuredEnabled).toBe(true)
  })

  it('marks JS expression disabled values as conditional', () => {
    const content = `
- id: js
  name: '@example/js'
  disabled: !!js process.env.A
`
    const entries = nativePluginEntries(content)
    expect(entries[0].configuredEnabled).toBe('conditional')
  })

  it('walks group rows recursively and records group paths', () => {
    const content = `
- id: outer
  name: cordis:group
  group: true
  config:
    - id: inner
      name: '@example/inner'
`
    const entries = nativePluginEntries(content)
    expect(entries).toHaveLength(1)
    expect(entries[0].groupPath).toEqual(['outer'])
    expect(entries[0].moduleName).toBe('@example/inner')
  })

  it('propagates parent group disabling', () => {
    const content = `
- id: outer
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: inner
      name: '@example/inner'
`
    const entries = nativePluginEntries(content)
    expect(entries[0].configuredEnabled).toBe(false)
  })

  it('rejects malformed composition documents', () => {
    expect(() => nativePluginEntries('not a sequence')).toThrow()
    expect(() => nativePluginEntries('- config: {}')).toThrow()
  })
})