import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readAppConfig, writeAppConfig } = vi.hoisted(() => ({
  readAppConfig: vi.fn(),
  writeAppConfig: vi.fn(),
}))

vi.mock('../../packages/server/src/services/app-config', () => ({
  readAppConfig,
  writeAppConfig,
}))

describe('App Relay route configuration', () => {
  beforeEach(() => {
    readAppConfig.mockReset()
    writeAppConfig.mockReset()
    readAppConfig.mockResolvedValue({})
    writeAppConfig.mockResolvedValue({})
  })

  it('defaults old configs to the official route', async () => {
    const { getAppRelayRoute, appRelayUrlForRoute } = await import(
      '../../packages/server/src/services/app-relay/route'
    )

    expect(await getAppRelayRoute()).toBe('official')
    // Cloud relay is opt-in. No upstream relay URL is baked into the build;
    // operators must set HERMES_APP_RELAY_URL to enable it.
    expect(appRelayUrlForRoute('official')).toBe('')
  })

  it('persists and maps the Cloudflare route', async () => {
    const { setAppRelayRoute, appRelayUrlForRoute } = await import(
      '../../packages/server/src/services/app-relay/route'
    )

    await setAppRelayRoute('cloudflare')
    expect(writeAppConfig).toHaveBeenCalledWith({ appRelayRoute: 'cloudflare' })
    expect(appRelayUrlForRoute('cloudflare')).toBe('')
  })
})
