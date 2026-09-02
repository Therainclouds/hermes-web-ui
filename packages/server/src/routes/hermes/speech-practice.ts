import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/speech-practice'

/**
 * 口语对练（speech-practice）报告落盘路由。
 *
 * 唯一端点：口语对练会话结束后客户端把生成的 Markdown 分析报告 POST 过来，
 * 服务端写入 Web UI state 目录并返回文件名 / 绝对路径；下载走既有的
 * `/api/hermes/download`。必须在 catch-all 之前注册（见 routes/index.ts）。
 */
export const speechPracticeRoutes = new Router()

speechPracticeRoutes.post('/api/hermes/speech-practice/report', ctrl.savePracticeReport)
