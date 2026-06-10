import { describe, expect, it } from 'vitest'
import { isRemoteVersionNewer, parseSemver } from '../../packages/server/src/services/update/version-compare'

describe('update version compare', () => {
  it('parses plain and v-prefixed semver values', () => {
    expect(parseSemver('0.6.13')).toEqual({ major: 0, minor: 6, patch: 13 })
    expect(parseSemver('v1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('returns false for invalid versions', () => {
    expect(isRemoteVersionNewer('0.6.x', '0.6.13')).toBe(false)
    expect(isRemoteVersionNewer('0.6.13', 'latest')).toBe(false)
  })

  it('compares major, minor, and patch components', () => {
    expect(isRemoteVersionNewer('0.6.13', '0.6.14')).toBe(true)
    expect(isRemoteVersionNewer('0.6.13', '0.7.0')).toBe(true)
    expect(isRemoteVersionNewer('0.6.13', '1.0.0')).toBe(true)
    expect(isRemoteVersionNewer('0.6.13', '0.6.13')).toBe(false)
    expect(isRemoteVersionNewer('0.6.13', '0.6.12')).toBe(false)
  })
})
