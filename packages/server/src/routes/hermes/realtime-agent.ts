import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/realtime-agent'

/** Realtime direct terminal tools and Hermes fallback, registered before the proxy. */
export const realtimeAgentRoutes = new Router()

realtimeAgentRoutes.post('/api/hermes/realtime/agent-query', ctrl.queryAgent)

realtimeAgentRoutes.post('/api/hermes/realtime/terminal-command', ctrl.terminalCommand)
