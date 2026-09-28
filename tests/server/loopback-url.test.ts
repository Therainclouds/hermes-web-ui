import { describe, expect, it } from 'vitest'
import { getLoopbackBaseUrl, getLoopbackPort } from '../../packages/server/src/config'
import { readFileSync } from 'node:fs'
describe('internal MCU loopback URL', () => {
  it('uses the configured HTTP loopback port', () => {
    expect(new URL('/api/hermes/mcu/voice-turn', getLoopbackBaseUrl()).port).toBe(String(getLoopbackPort()))
    expect(getLoopbackBaseUrl('8647')).toBe('http://127.0.0.1:8647')
  })
  it('rejects a server object and invalid ports instead of constructing a malformed URL', () => {
    for (const value of [{}, 0, -1, 65536, 'NaN', '8647/other']) expect(() => getLoopbackBaseUrl(value as any)).toThrow(/Loopback port/)
  })
  it('bootstrap does not pass the HTTP server object as a port', () => {
    const source = readFileSync('packages/server/src/index.ts', 'utf8')
    expect(source).toContain('const loopbackBaseUrl = getLoopbackBaseUrl()')
    expect(source).not.toContain('getLoopbackBaseUrl(server)')
  })
})
