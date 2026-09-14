import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/media'

export const mediaRoutes = new Router()

mediaRoutes.post('/api/hermes/media/grok-image-to-video', ctrl.grokImageToVideo)
mediaRoutes.post('/api/hermes/media/apikey-image-generate', ctrl.apiKeyImageGenerate)
mediaRoutes.post('/api/hermes/media/minimax-image-to-video', ctrl.miniMaxImageToVideo)
mediaRoutes.post('/api/hermes/media/chatgpt-web-image', ctrl.chatGptWebImageGenerate)
// Async job polling for the same flow. Keep this before any proxy catch-all so
// the local controller (not the gateway) answers it.
mediaRoutes.get('/api/hermes/media/chatgpt-web-image/jobs/:jobId', ctrl.chatGptWebImageJobStatus)
mediaRoutes.get('/api/hermes/media/chatgpt-web-status', ctrl.chatGptWebImageStatus)
