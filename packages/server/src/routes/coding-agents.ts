import Router from '@koa/router'
import * as ctrl from '../controllers/coding-agents'
import * as presets from '../controllers/coding-agents/dsh-agent-presets'
import * as plugins from '../controllers/coding-agents/dsh-plugins'
import { requireSuperAdmin } from '../middleware/user-auth'
import { getDshHost } from '../services/coding-agents'

export const codingAgentRoutes = new Router()

// Authenticated chat users can select DSH Agent presets without plugin access.
codingAgentRoutes.get('/api/coding-agents/dsh/session-presets', presets.choices)

// Super-admin-only DSH management routes (plugin inventory, web profile, presets).
codingAgentRoutes.get('/api/coding-agents/dsh/agent-presets', requireSuperAdmin, presets.list)
codingAgentRoutes.post('/api/coding-agents/dsh/agent-presets', requireSuperAdmin, presets.copy)
codingAgentRoutes.get('/api/coding-agents/dsh/agent-presets/:presetId', requireSuperAdmin, presets.read)
codingAgentRoutes.delete('/api/coding-agents/dsh/agent-presets/:presetId', requireSuperAdmin, presets.remove)
codingAgentRoutes.put('/api/coding-agents/dsh/agent-presets/:presetId/default', requireSuperAdmin, presets.makeDefault)
codingAgentRoutes.post('/api/coding-agents/dsh/agent-presets/:presetId/location', requireSuperAdmin, presets.openLocation)

codingAgentRoutes.get('/api/coding-agents/dsh/plugin-inventory', requireSuperAdmin, plugins.inventory)
codingAgentRoutes.post('/api/coding-agents/dsh/web-plugins', requireSuperAdmin, plugins.change)
codingAgentRoutes.post('/api/coding-agents/dsh/ui-session', requireSuperAdmin, plugins.openUi)
codingAgentRoutes.delete('/api/coding-agents/dsh/ui-session/:id', requireSuperAdmin, plugins.closeUi)

// Authenticated, signed-URL native UI mount — never a URL proxy. The mounted
// frame is treated as native HTTP/SSE transport and validated per request.
codingAgentRoutes.all(/^\/api\/coding-agents\/dsh\/ui\/([a-f0-9]{48})\/.*$/, async (ctx, next) => {
  const host = await getDshHost()
  return host.ui.middleware(ctx, next)
})

codingAgentRoutes.get('/api/coding-agents', ctrl.status)
codingAgentRoutes.post('/api/coding-agents/:id/install', ctrl.install)
codingAgentRoutes.post('/api/coding-agents/:id/check-update', ctrl.checkUpdate)
codingAgentRoutes.post('/api/coding-agents/:id/launch/prepare', ctrl.prepareLaunch)
codingAgentRoutes.post('/api/coding-agents/:id/launch/native', ctrl.nativeLaunch)
codingAgentRoutes.post('/api/coding-agents/:id/runs', ctrl.startRun)
codingAgentRoutes.post('/api/coding-agents/runs/:sessionId/input', ctrl.sendRunInput)
codingAgentRoutes.delete('/api/coding-agents/runs/:sessionId', ctrl.stopRun)
codingAgentRoutes.delete('/api/coding-agents/:id', ctrl.remove)
codingAgentRoutes.get('/api/coding-agents/:id/config-files/:key', ctrl.readConfigFile)
codingAgentRoutes.put('/api/coding-agents/:id/config-files/:key', ctrl.writeConfigFile)
