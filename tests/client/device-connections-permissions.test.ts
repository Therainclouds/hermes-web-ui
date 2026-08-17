import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('Device connections permissions', () => {
  it('keeps the upstream connections page out of the local product while reserving Devices for super admins', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    const sidebar = readFileSync('packages/client/src/components/layout/PageSidebarNav.vue', 'utf8')
    const deviceRoutes = readFileSync('packages/server/src/routes/devices.ts', 'utf8')

    expect(router).not.toContain("path: '/hermes/connections'")
    expect(router).toContain("path: '/hermes/devices'")
    expect(router).toContain("name: 'hermes.devices'")
    expect(sidebar).not.toContain('openConnections')
    expect(sidebar).not.toContain("sidebar.connections")
    expect(deviceRoutes).toContain('deviceRoutes.use(requireSuperAdmin)')
  })
})
