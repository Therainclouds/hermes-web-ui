import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/user-auth'
import { provision, status } from '../controllers/xiaozhi'
export const xiaozhiPublicRoutes = new Router()
xiaozhiPublicRoutes.get('/api/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/xiaozhi/ota/:code', provision)
export const xiaozhiProtectedRoutes = new Router()
xiaozhiProtectedRoutes.get('/api/xiaozhi/status', requireSuperAdmin, status)
