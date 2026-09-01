import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/realtime-agent'

/**
 * Realtime 工具调用的服务端 Agent 代理路由。
 *
 * 仅一个端点：Omni-Realtime 的 `query_hermes_agent` 工具调用时通过 HTTP
 * POST 过来，把用户随口问的问题送到 Hermes Agent（带 MCP / skills /
 * terminal_exec）执行一次，返回最终文本。
 *
 * 必须在 catch-all 之前注册（详见 routes/index.ts）。
 */
export const realtimeAgentRoutes = new Router()

realtimeAgentRoutes.post('/api/hermes/realtime/agent-query', ctrl.queryAgent)
